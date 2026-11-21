"""Pruebas de consistencia de una escena 3DGS exportada (scene.splat + result.json), y la
limpieza de flotantes que el job aplica antes de exportar.

Responde a «¿la escena es físicamente creíble?» sin mirar las fotos: lo que el puesto de mando
vería como basura flotando, manchas que tapan todo o una vertical torcida.

Las gaussianas vienen en ENU (x Este, y Norte, z arriba). Sin GPS la escala es arbitraria, así
que todos los umbrales son relativos: al espaciado típico entre gaussianas (h) o al tamaño de
la escena. El peso visual de una gaussiana es opacidad × área de sus dos ejes mayores (lo que
tapa en pantalla); los porcentajes se dan en peso, que es lo que se ve.

Pruebas:
  integridad    valores finitos, cuaterniones válidos, tamaño de archivo, opacidad mínima.
  aisladas      gaussianas lejos de sus vecinas y sin tocarse con ninguna (puntos sueltos).
  desprendidas  islas separadas de la escena principal (informativa: una isla apoyada en el
                suelo puede ser un objeto aparte, como un auto o una silla).
  flotantes     islas separadas que además no tocan el suelo: el «objeto flotante» que no
                puede existir en una escena real.
  bajo_suelo    peso por debajo del plano del suelo (reflejos de un piso brillante, un suelo
                doble o la vertical mal puesta).
  vertical      inclinación del suelo respecto de z (la alineación ENU).
  tamanos       gaussianas desmesuradas (niebla) o agujas.
  fondo         peso muy lejos del centro (cielo o fondo que se coló).
  metadatos     result.json coherente con el archivo (cantidad, estado, alineación).

Uso:
  python -m splat.consistency scene.splat [--result result.json] [--json reporte.json] [--png vistas.png]
Sale con 0 si no hay fallas, 1 si alguna prueba falla.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

from .splat_io import SPLAT_BYTES, decode_splat

# Vecinas para el espaciado local.
NEIGHBORS = 8
# Suelta: distancia media a sus vecinas sobre la mediana + n·sigma (MAD) y sobre m veces la
# mediana, y tocándose con menos de 2 de ellas.
ISOLATED_SIGMAS = 6.0
ISOLATED_MIN_RATIO = 4.0
# Gaussianas que cuentan para la conectividad. En una escena entrenada la mayoría es
# semitransparente (mediana ~0,1) y es justo ese tejido el que une las superficies: con un
# umbral alto la escena se rompe en islas que no existen.
LINK_ALPHA = 0.05
# Celda de la grilla de conectividad, en múltiplos del espaciado típico h.
VOXEL_FACTOR = 2.0
# Alcance de una gaussiana: este múltiplo de su eje mayor (≈ 2σ), con tope en múltiplos de h.
REACH_SIGMAS = 2.0
MAX_REACH_H = 10.0
REACH_NEIGHBORS = 32
# Una isla cuenta como desprendida si la separa de la escena principal más que DETACH_GAP_H·h
# (los huecos menores son muestreo) y como flotante si la separación supera FLOAT_GAP_H·h y
# no toca el suelo.
DETACH_GAP_H = 4.0
FLOAT_GAP_H = 8.0
# Además, la separación de una flotante debe superar esta fracción del ancho de la escena: con
# muchas gaussianas h se achica y un hueco físico chico (las patas finas de una mesa que no se
# reconstruyeron) no debe contar como objeto en el aire.
FLOAT_GAP_EXTENT = 0.01
# Tolerancia de altura sobre/bajo el suelo, en múltiplos de h y como fracción del tamaño horizontal.
GROUND_TOL_H = 6.0
GROUND_TOL_EXTENT = 0.02
# Gaussiana desmesurada: eje mayor sobre esta fracción de la diagonal robusta de la escena.
BIG_SCALE_FRACTION = 0.05
# Aguja: eje mayor sobre este múltiplo del eje MEDIO. (Un disco plano, con dos ejes grandes y
# uno mínimo, es un pedazo de pared o de suelo y es correcto.)
NEEDLE_RATIO = 30.0
# Fondo: más lejos del centro que este múltiplo del radio del percentil 90.
FAR_RADIUS_FACTOR = 3.0

# Umbrales de veredicto (fracción del peso visual total): (aviso, falla). Un límite > 1 no falla nunca.
LIMITS: dict[str, tuple[float, float]] = {
    "aisladas": (0.005, 0.02),
    "desprendidas": (0.10, 2.0),
    "flotantes": (0.002, 0.01),
    "bajo_suelo": (0.01, 0.03),
    "tamanos": (0.05, 0.15),
    "fondo": (0.005, 0.02),
}
# Una sola isla flotante con más de esta fracción del peso ya es falla (un objeto entero en el aire).
FLOATING_COMPONENT_FAIL = 0.003
# Inclinación del suelo (grados): (aviso, falla).
TILT_LIMITS = (10.0, 20.0)

# Limpieza del job, en dos niveles:
#  1) Islas flotantes CHICAS (pocas gaussianas o tamaño menor a una fracción del ancho) y
#     sueltas: una gaussiana sola en el vacío no es ambigua, se borra con un tope amplio.
#  2) Islas flotantes GRANDES y lo que está bajo el suelo: podrían ser escena real mal
#     conectada, así que nunca más de MAX_CLEANUP_WEIGHT del peso y solo si la escena principal
#     tiene al menos MIN_MAIN_WEIGHT. Si haría falta más, la escena está mal de raíz y esa parte
#     se exporta como está, con el reporte que lo dice.
# Se repite hasta CLEANUP_PASSES veces: al quitar una capa de basura quedan expuestas las
# islas que colgaban de ella.
SMALL_ISLAND_GAUSSIANS = 32
SMALL_ISLAND_EXTENT = 0.02
MAX_SMALL_CLEANUP_WEIGHT = 0.50
MAX_CLEANUP_WEIGHT = 0.30
CLEANUP_PASSES = 3
# Si la escena principal no llega a esta fracción del peso, la escena está fragmentada y no se
# sabe bien qué es escena y qué es basura: no se limpia.
MIN_MAIN_WEIGHT = 0.5
# Lo que está bajo el suelo solo se borra con la vertical confiable y si es poco.
UNDER_CLEANUP_MAX_TILT = 10.0
UNDER_CLEANUP_MAX_WEIGHT = 0.08

OK, WARN, FAIL, SKIP = "ok", "aviso", "falla", "omitida"


@dataclass
class Check:
    name: str
    status: str  # "ok" | "aviso" | "falla" | "omitida"
    value: float | None
    detail: str
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class Report:
    gaussians: int
    spacing_h: float
    extent: list[float]
    checks: list[Check]

    @property
    def failed(self) -> bool:
        return any(c.status == FAIL for c in self.checks)

    def summary(self) -> dict[str, str]:
        return {c.name: c.status for c in self.checks}

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["failed"] = self.failed
        return d


@dataclass
class SceneClasses:
    """Clasificación geométrica de las gaussianas (todas finitas y válidas)."""

    h: float
    weight: np.ndarray
    main: np.ndarray        # escena principal (conectada)
    isolated: np.ndarray    # sueltas
    detached: np.ndarray    # en islas separadas > DETACH_GAP_H·h
    floating: np.ndarray    # en islas separadas > FLOAT_GAP_H·h que no tocan el suelo
    under: np.ndarray       # bajo el suelo
    height: np.ndarray      # altura con signo sobre el suelo
    normal: np.ndarray
    d: float
    tilt: float
    ground_fallback: bool   # True si la vertical era tan mala que se usó un suelo horizontal
    tol: float
    islands: list[dict[str, Any]]
    extent: np.ndarray
    diag: float


def _verdict(name: str, frac: float) -> str:
    warn, fail = LIMITS[name]
    return FAIL if frac > fail else WARN if frac > warn else OK


def _pct(x: float) -> str:
    return f"{100.0 * x:.2f} %".replace(".", ",")


def visual_weight(scale: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Opacidad × área de los dos ejes mayores: lo que una gaussiana tapa en pantalla."""
    s = np.sort(scale, axis=1)
    return alpha * s[:, 1] * s[:, 2]


def _neighbors(pos: np.ndarray, k: int = NEIGHBORS) -> tuple[np.ndarray, np.ndarray]:
    """→ (distancias, índices) de las k vecinas más cercanas de cada gaussiana (sin ella misma)."""
    k = max(1, min(k, len(pos) - 1))
    d, j = cKDTree(pos).query(pos, k=k + 1, workers=-1)
    return d[:, 1:], j[:, 1:]


def _cell_graph(pos: np.ndarray, voxel: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """Grilla dispersa: celda de cada punto y aristas entre celdas vecinas (vecindad 26)."""
    cells = np.floor((pos - pos.min(axis=0)) / voxel).astype(np.int64)
    dims = cells.max(axis=0) + 3
    cells += 1  # margen para que el vecino -1 no se salga
    keys = (cells[:, 0] * dims[1] + cells[:, 1]) * dims[2] + cells[:, 2]
    uniq, inv = np.unique(keys, return_inverse=True)
    m = len(uniq)
    cx, rem = np.divmod(uniq, dims[1] * dims[2])
    cy, cz = np.divmod(rem, dims[2])
    rows, cols = [], []
    # La mitad de los 26 vecinos alcanza (el grafo es no dirigido).
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                if (dx, dy, dz) <= (0, 0, 0):
                    continue
                nk = ((cx + dx) * dims[1] + (cy + dy)) * dims[2] + (cz + dz)
                j = np.searchsorted(uniq, nk)
                j_ok = np.minimum(j, m - 1)
                hit = (j < m) & (uniq[j_ok] == nk)
                rows.append(np.nonzero(hit)[0])
                cols.append(j_ok[hit])
    r = np.concatenate(rows) if rows else np.zeros(0, dtype=np.int64)
    c = np.concatenate(cols) if cols else np.zeros(0, dtype=np.int64)
    return inv, r, c, m


def voxel_components(pos: np.ndarray, voxel: float, reach: np.ndarray | None = None) -> np.ndarray:
    """Componente conexa de cada gaussiana.

    Dos gaussianas se unen si sus centros caen en celdas vecinas de una grilla de lado `voxel`,
    o si el centro de una cae dentro del alcance (`reach`, ~2σ del eje mayor) de la otra: una
    gaussiana grande toca a las que cubre aunque su centro esté lejos.
    """
    n = len(pos)
    if n == 0:
        return np.zeros(0, dtype=np.int64)
    inv, cr, cc, m = _cell_graph(pos, voxel)
    # Nodos: 0..n-1 gaussianas, n..n+m-1 celdas.
    rows = [np.arange(n), n + cr]
    cols = [n + inv, n + cc]
    if reach is not None:
        big = np.nonzero(reach > voxel)[0]
        if len(big):
            # Las REACH_NEIGHBORS más cercanas dentro del alcance bastan para la conectividad: lo
            # demás que cubre ya está unido entre sí por la grilla. (Pedir todas las del alcance
            # son miles por gaussiana en una superficie densa y se come la memoria.)
            k = min(REACH_NEIGHBORS, n)
            d, j = cKDTree(pos).query(pos[big], k=k, distance_upper_bound=float(reach[big].max()), workers=-1)
            d, j = d.reshape(len(big), k), j.reshape(len(big), k)
            hit = (j < n) & (d <= reach[big][:, None])
            rows.append(np.repeat(big, hit.sum(axis=1)))
            cols.append(j[hit].astype(np.int64))
    r = np.concatenate(rows)
    c = np.concatenate(cols)
    graph = coo_matrix((np.ones(len(r), dtype=np.int8), (r, c)), shape=(n + m, n + m))
    _, label = connected_components(graph, directed=False)
    return label[:n]


def isolated_mask(smax: np.ndarray, h: float, spacing: np.ndarray, neighbors: np.ndarray,
                  dists: np.ndarray) -> np.ndarray:
    """Gaussianas sueltas: lejos de sus vecinas y sin tocarse con casi ninguna.

    «Tocarse» = la distancia entre centros es menor que la suma de sus alcances (2σ del eje
    mayor de cada una). Así una gaussiana grande de una pared, con su centro lejos de las demás
    pero encima de ellas, no cuenta como suelta.
    """
    mad = float(np.median(np.abs(spacing - h))) * 1.4826
    far = (spacing > h + ISOLATED_SIGMAS * max(mad, 1e-12)) & (spacing > ISOLATED_MIN_RATIO * h)
    touching = (dists < REACH_SIGMAS * (smax[:, None] + smax[neighbors])).sum(axis=1)
    return far & (touching < 2)


def fit_ground(pos: np.ndarray, weight: np.ndarray, lowest_fraction: float = 0.15, iters: int = 300,
               seed: int = 0) -> tuple[np.ndarray, float, float]:
    """Plano del suelo (normal unitaria con z ≥ 0, d) por RANSAC sobre la capa más baja.

    → (normal, d, inclinación en grados) con normal·p + d = altura con signo sobre el suelo.
    """
    z = pos[:, 2]
    cut = np.quantile(z, lowest_fraction)
    low = pos[z <= cut]
    w = weight[z <= cut]
    flat = (np.array([0.0, 0.0, 1.0]), -float(np.quantile(z, 0.02)), 0.0)
    if len(low) < 3:
        return flat
    rng = np.random.default_rng(seed)
    span = float(np.ptp(low[:, :2], axis=0).max()) or 1.0
    tol = 0.01 * span
    cos45 = math.cos(math.radians(45.0))
    best, best_score = None, -1.0
    for _ in range(iters):
        p = low[rng.choice(len(low), 3, replace=False)]
        nrm = np.cross(p[1] - p[0], p[2] - p[0])
        norm = np.linalg.norm(nrm)
        if norm < 1e-12:
            continue
        nrm = nrm / norm
        if nrm[2] < 0:
            nrm = -nrm
        if nrm[2] < cos45:
            continue  # una pared, no un suelo
        d = -float(nrm @ p[0])
        score = float(w[np.abs(low @ nrm + d) < tol].sum())
        if score > best_score:
            best, best_score = (nrm, d), score
    if best is None:
        return flat
    nrm, d = best
    inl = np.abs(low @ nrm + d) < tol
    if inl.sum() >= 3:
        # Ajuste fino por mínimos cuadrados sobre los inliers.
        q = low[inl]
        c = q.mean(axis=0)
        _, _, vt = np.linalg.svd(q - c, full_matrices=False)
        n2 = vt[-1] / np.linalg.norm(vt[-1])
        if n2[2] < 0:
            n2 = -n2
        if n2[2] >= cos45:
            nrm, d = n2, -float(n2 @ c)
    tilt = math.degrees(math.acos(min(1.0, abs(float(nrm[2])))))
    return nrm, d, tilt


def classify(pos: np.ndarray, scale: np.ndarray, alpha: np.ndarray) -> SceneClasses:
    """Clasifica cada gaussiana: escena principal, suelta, isla, flotante, bajo el suelo."""
    n = len(pos)
    weight = visual_weight(scale, alpha)
    dists, nbrs = _neighbors(pos)
    spacing = dists.mean(axis=1)
    h = float(np.median(spacing)) or 1e-9
    smax = scale.max(axis=1)
    lo = np.percentile(pos, 2.0, axis=0)
    hi = np.percentile(pos, 98.0, axis=0)
    extent = hi - lo
    diag = float(np.linalg.norm(extent)) or 1.0
    horiz = float(max(extent[0], extent[1])) or 1.0

    iso = isolated_mask(smax, h, spacing, nbrs, dists)

    # Conectividad: escena principal = la componente con más peso visual.
    link_idx = np.nonzero(alpha >= LINK_ALPHA)[0]
    voxel = VOXEL_FACTOR * h
    reach = np.minimum(REACH_SIGMAS * smax[link_idx], MAX_REACH_H * h)
    labels = voxel_components(pos[link_idx], voxel, reach)
    comp_w = np.bincount(labels, weights=weight[link_idx]) if len(labels) else np.zeros(0)
    main_label = int(np.argmax(comp_w)) if len(comp_w) else -1
    main = np.zeros(n, dtype=bool)
    main[link_idx[labels == main_label]] = True

    # Islas, con su separación de la escena principal.
    islands: list[dict[str, Any]] = []
    if len(comp_w) > 1 and main.any():
        det_labels = labels[labels != main_label]
        det_idx = link_idx[labels != main_label]
        gap_pt, _ = cKDTree(pos[main]).query(pos[det_idx], k=1, workers=-1)
        order = np.argsort(det_labels, kind="stable")
        det_labels, det_idx, gap_pt = det_labels[order], det_idx[order], gap_pt[order]
        starts = np.flatnonzero(np.r_[True, det_labels[1:] != det_labels[:-1]])
        ends = np.r_[starts[1:], len(det_labels)]
        for s, e in zip(starts, ends):
            islands.append({"idx": det_idx[s:e], "gap": float(gap_pt[s:e].min())})

    # Suelo y vertical, sobre TODAS las gaussianas visibles: el piso es la superficie horizontal
    # baja con más peso de la escena. (Solo con la escena principal fallaba cuando el piso, por
    # brillante o semitransparente, quedaba como isla: el plano caía sobre las mesas.)
    visible = alpha >= LINK_ALPHA
    ref = pos[visible] if visible.sum() >= 100 else pos
    ref_w = weight[visible] if visible.sum() >= 100 else weight
    normal, d0, tilt = fit_ground(ref, ref_w)
    fallback = tilt > TILT_LIMITS[1]
    if fallback:
        # Con la vertical tan torcida el plano ajustado puede ser una rampa o una pared baja:
        # alturas contra un suelo horizontal en la parte baja de la escena principal.
        normal = np.array([0.0, 0.0, 1.0])
        d0 = -float(np.quantile(ref[:, 2], 0.02))
    height = pos @ normal + d0
    tol = max(GROUND_TOL_H * h, GROUND_TOL_EXTENT * horiz)
    under = height < -tol

    detached = np.zeros(n, dtype=bool)
    floating = np.zeros(n, dtype=bool)
    float_gap = max(FLOAT_GAP_H * h, FLOAT_GAP_EXTENT * horiz)
    for isl in islands:
        idx = isl["idx"]
        isl["base"] = float(height[idx].min())
        isl["floating"] = isl["gap"] > float_gap and isl["base"] > tol
        isl["size"] = float(np.ptp(pos[idx], axis=0).max()) if len(idx) > 1 else 2.0 * float(smax[idx[0]])
        isl["small"] = len(idx) <= SMALL_ISLAND_GAUSSIANS or isl["size"] < SMALL_ISLAND_EXTENT * horiz
        if isl["gap"] > DETACH_GAP_H * h:
            detached[idx] = True
        if isl["floating"]:
            floating[idx] = True

    return SceneClasses(h=h, weight=weight, main=main, isolated=iso, detached=detached,
                        floating=floating, under=under, height=height, normal=normal, d=d0,
                        tilt=tilt, ground_fallback=fallback, tol=tol, islands=islands,
                        extent=extent, diag=diag)


def analyze(splat: bytes, result: dict[str, Any] | None = None) -> Report:
    checks: list[Check] = []

    # ── Integridad ──
    if len(splat) % SPLAT_BYTES != 0:
        return Report(0, 0.0, [0, 0, 0], [Check("integridad", FAIL, None,
                                                 f"El archivo pesa {len(splat)} bytes: no es múltiplo de 32.")])
    g = decode_splat(splat)
    pos, scale, rgba = g["position"], g["scale"], g["rgba"]
    n_all = len(pos)
    if n_all < 100:
        return Report(n_all, 0.0, [0, 0, 0], [Check("integridad", FAIL, float(n_all),
                                                     f"Solo {n_all} gaussianas: no hay escena.")])
    qn = np.linalg.norm(g["rot_wxyz"], axis=1)
    finite = np.isfinite(pos).all(axis=1) & np.isfinite(scale).all(axis=1)
    bad_q = (qn < 0.5) | (qn > 1.5)
    bad = (~finite) | bad_q | (scale <= 0).any(axis=1) | (rgba[:, 3] == 0)
    checks.append(Check(
        "integridad", FAIL if bad.any() else OK, float(bad.sum()),
        f"{int(bad.sum())} gaussianas inválidas (no finitas, cuaternión nulo, escala ≤ 0 u opacidad 0)."
        if bad.any() else "Todas las gaussianas son válidas.",
        {"no_finitas": int((~finite).sum()), "cuaternion_invalido": int(bad_q.sum())},
    ))
    keep = ~bad
    pos, scale = pos[keep], scale[keep]
    alpha = rgba[keep, 3].astype(np.float64) / 255.0
    sc = classify(pos, scale, alpha)
    w = sc.weight
    total_w = float(w.sum()) or 1.0
    frac = lambda m: float(w[m].sum()) / total_w  # noqa: E731

    f_iso = frac(sc.isolated)
    checks.append(Check(
        "aisladas", _verdict("aisladas", f_iso), f_iso,
        f"{int(sc.isolated.sum())} gaussianas sueltas ({_pct(sc.isolated.mean())} de la cantidad, {_pct(f_iso)} del peso visual).",
        {"cantidad": int(sc.isolated.sum())},
    ))

    det_islands = [i for i in sc.islands if i["gap"] > DETACH_GAP_H * sc.h]
    f_det = frac(sc.detached)
    checks.append(Check(
        "desprendidas", _verdict("desprendidas", f_det), f_det,
        f"{len(det_islands)} islas separadas de la escena principal por más de {DETACH_GAP_H:g}·h: "
        f"{_pct(f_det)} del peso visual (las apoyadas en el suelo pueden ser objetos aparte).",
        {"islas": len(det_islands), "peso_principal": frac(sc.main)},
    ))

    t_status = FAIL if sc.tilt > TILT_LIMITS[1] else WARN if sc.tilt > TILT_LIMITS[0] else OK
    approx = bool(result) and result.get("alignment") != "gps"
    checks.append(Check(
        "vertical", t_status, sc.tilt,
        f"El suelo está inclinado {sc.tilt:.1f}° respecto de la vertical de la escena"
        + (" (alineación aproximada: vertical estimada desde las cámaras)." if approx else ".")
        + (" Alturas medidas contra un suelo horizontal (z del percentil 2)." if sc.ground_fallback else ""),
        {"normal": sc.normal.tolist(), "d": sc.d, "tolerancia_altura": sc.tol},
    ))

    f_under = frac(sc.under)
    checks.append(Check(
        "bajo_suelo", _verdict("bajo_suelo", f_under), f_under,
        f"{_pct(f_under)} del peso visual está bajo el suelo (más de {sc.tol:.3g} unidades por debajo).",
        {"cantidad": int(sc.under.sum())},
    ))

    groups = []
    for isl in sc.islands:
        if not isl["floating"]:
            continue
        idx = isl["idx"]
        groups.append({
            "peso": float(w[idx].sum()) / total_w,
            "cantidad": int(len(idx)),
            "centro": pos[idx].mean(axis=0).round(4).tolist(),
            "altura_base": round(isl["base"], 4),
            "separacion_h": round(isl["gap"] / sc.h, 1),
            "tamano": float(np.ptp(pos[idx], axis=0).max()) if len(idx) > 1 else 0.0,
        })
    groups.sort(key=lambda x: -x["peso"])
    f_float = frac(sc.floating)
    biggest = groups[0]["peso"] if groups else 0.0
    f_status = _verdict("flotantes", f_float)
    if biggest > FLOATING_COMPONENT_FAIL:
        f_status = FAIL
    checks.append(Check(
        "flotantes", f_status, f_float,
        f"{len(groups)} objetos flotando sin apoyo: {_pct(f_float)} del peso visual"
        + (f"; el mayor tiene {_pct(biggest)} y su base está a {groups[0]['altura_base']:.3g} del suelo."
           if groups else "."),
        {"grupos": groups[:10], "total_grupos": len(groups)},
    ))

    smax = scale.max(axis=1)
    smid = np.sort(scale, axis=1)[:, 1]
    big = smax > BIG_SCALE_FRACTION * sc.diag
    needle = smax / np.maximum(smid, 1e-12) > NEEDLE_RATIO
    f_big = frac(big | needle)
    checks.append(Check(
        "tamanos", _verdict("tamanos", f_big), f_big,
        f"{int(big.sum())} desmesuradas y {int(needle.sum())} agujas: {_pct(f_big)} del peso visual.",
        {"desmesuradas": int(big.sum()), "agujas": int(needle.sum())},
    ))

    center = np.median(pos, axis=0)
    r = np.linalg.norm(pos - center, axis=1)
    r90 = float(np.quantile(r, 0.9)) or 1.0
    far = r > FAR_RADIUS_FACTOR * r90
    f_far = frac(far)
    checks.append(Check(
        "fondo", _verdict("fondo", f_far), f_far,
        f"{int(far.sum())} gaussianas a más de {FAR_RADIUS_FACTOR:g} veces el radio de la escena: {_pct(f_far)} del peso.",
        {"cantidad": int(far.sum())},
    ))

    checks.append(check_metadata(result, n_all))
    rep = Report(n_all, sc.h, [round(float(x), 4) for x in sc.extent], checks)
    rep._diag = {"pos": pos, "alpha": alpha, "classes": sc}  # type: ignore[attr-defined]
    return rep


def check_metadata(result: dict[str, Any] | None, n_file: int) -> Check:
    if not result:
        return Check("metadatos", SKIP, None, "Sin result.json.")
    problems: list[str] = []
    if result.get("status") != "ready":
        problems.append(f"estado «{result.get('status')}» con un scene.splat presente")
    if result.get("gaussians") is not None and int(result["gaussians"]) != n_file:
        problems.append(f"result.json dice {result['gaussians']} gaussianas y el archivo tiene {n_file}")
    fc, fr = result.get("frame_count"), result.get("frames_registered")
    if fc is not None and fr is not None and fr > fc:
        problems.append(f"{fr} cuadros registrados de {fc}")
    if result.get("alignment") != "gps" and result.get("scale_known"):
        problems.append("escala «conocida» sin alineación por GPS")
    tr = result.get("transform")
    if tr is not None and (len(tr) != 16 or not np.allclose(tr, np.eye(4).flatten())):
        problems.append("transform no es la identidad (las gaussianas ya vienen en ENU)")
    return Check("metadatos", FAIL if problems else OK, float(len(problems)),
                 "; ".join(problems) if problems else "result.json coincide con el archivo.")


def cleanup_mask(means: np.ndarray, log_scales: np.ndarray, opacity_logits: np.ndarray) -> tuple[np.ndarray, dict[str, Any]]:
    """Gaussianas que el job conserva al exportar (ver los dos niveles junto a SMALL_ISLAND_*).

    → (máscara de las que se conservan, estadísticas). Las islas grandes y lo de bajo el suelo
    no se tocan si harían borrar más de MAX_CLEANUP_WEIGHT o si la escena principal es chica.
    """
    means = np.asarray(means, dtype=np.float64)
    n = len(means)
    keep = np.ones(n, dtype=bool)
    stats: dict[str, Any] = {"aplicada": False, "pasadas": 0, "islas_flotantes": 0, "flotantes": 0, "sueltas": 0,
                             "bajo_suelo": 0, "peso_quitado": 0.0, "peso_islas_chicas": 0.0, "peso_islas_grandes": 0.0}
    finite = np.isfinite(means).all(axis=1) & np.isfinite(log_scales).all(axis=1) & np.isfinite(opacity_logits)
    if finite.sum() < 1000:
        return keep, stats
    scale_all = np.exp(np.clip(np.asarray(log_scales, dtype=np.float64), -30.0, 30.0))
    alpha_all = 1.0 / (1.0 + np.exp(-np.asarray(opacity_logits, dtype=np.float64)))
    keep[~finite] = True  # las no finitas las descarta encode_splat; aquí no se tocan
    total = float(visual_weight(scale_all[finite], alpha_all[finite]).sum()) or 1.0
    small_w = big_w = 0.0
    for _ in range(CLEANUP_PASSES):
        cur = np.nonzero(finite & keep)[0]
        if len(cur) < 1000:
            break
        sc = classify(means[cur], scale_all[cur], alpha_all[cur])
        w = sc.weight
        small = sc.isolated.copy()
        big = np.zeros(len(cur), dtype=bool)
        n_small_isl = n_big_isl = 0
        for isl in sc.islands:
            if not isl["floating"]:
                continue
            if isl["small"]:
                small[isl["idx"]] = True
                n_small_isl += 1
            else:
                big[isl["idx"]] = True
                n_big_isl += 1
        cur_total = float(w.sum()) or 1.0
        # Bajo el suelo: el suelo se ajusta sobre todas las gaussianas visibles, así que basta
        # con que la vertical sea confiable y sea poco (no depende de la escena principal).
        under_frac = float(w[sc.under].sum()) / cur_total
        use_under = (not sc.ground_fallback) and sc.tilt <= UNDER_CLEANUP_MAX_TILT and under_frac <= UNDER_CLEANUP_MAX_WEIGHT
        under = (sc.under & ~small) if use_under else np.zeros(len(cur), dtype=bool)
        big &= ~small & ~under
        add_small = float(w[small].sum()) / total
        add_under = float(w[under].sum()) / total
        add_big = float(w[big].sum()) / total
        main_frac = float(w[sc.main].sum()) / cur_total
        drop = np.zeros(len(cur), dtype=bool)
        if small.any():
            if small_w + add_small <= MAX_SMALL_CLEANUP_WEIGHT:
                drop |= small
                small_w += add_small
                stats["islas_flotantes"] += n_small_isl
                stats["sueltas"] += int(sc.isolated.sum())
            else:
                stats["motivo"] = f"las islas chicas suman {small_w + add_small:.0%} del peso visual: la escena está mal de raíz"
        if under.any() and big_w + add_under <= MAX_CLEANUP_WEIGHT:
            drop |= under
            big_w += add_under
            stats["bajo_suelo"] += int(under.sum())
        # Islas grandes: podrían ser escena real mal conectada (una mesa cuyas patas no salieron).
        if big.any():
            if big_w + add_big > MAX_CLEANUP_WEIGHT:
                stats["motivo"] = f"las islas flotantes grandes suman {big_w + add_big:.0%} del peso visual: se dejan"
            elif main_frac < MIN_MAIN_WEIGHT:
                stats["motivo"] = f"la escena principal tiene solo {main_frac:.0%} del peso visual: las islas flotantes grandes se dejan"
            else:
                drop |= big
                big_w += add_big
                stats["islas_flotantes"] += n_big_isl
        if not drop.any():
            break
        stats["flotantes"] += int((sc.floating & drop).sum())
        keep[cur[drop]] = False
        stats["pasadas"] += 1
        stats["inclinacion"] = sc.tilt
        stats["peso_principal"] = main_frac
    stats.update({
        "aplicada": stats["pasadas"] > 0,
        "peso_islas_chicas": small_w,
        "peso_islas_grandes": big_w,
        "peso_quitado": small_w + big_w,
    })
    return keep, stats


def format_report(rep: Report, title: str = "") -> str:
    icon = {OK: "✓", WARN: "!", FAIL: "✗", SKIP: "–"}
    lines = [f"{title}  ({rep.gaussians} gaussianas, espaciado h={rep.spacing_h:.3g}, "
             f"tamaño {' × '.join(f'{e:.3g}' for e in rep.extent)})"]
    for c in rep.checks:
        lines.append(f"  {icon[c.status]} {c.name:<13} {c.detail}")
    lines.append("  → " + ("FALLA" if rep.failed else "OK"))
    return "\n".join(lines)


def render_views(rep: Report, path: str, size: int = 900) -> None:
    """Planta (x-y) y costado (x-z) coloreadas por clase: gris escena, azul isla en el suelo,
    rojo flotante, naranjo bajo el suelo, magenta suelta; línea verde el suelo."""
    import cv2

    dg = getattr(rep, "_diag", None)
    if dg is None:
        return
    pos, alpha, sc = dg["pos"], dg["alpha"], dg["classes"]
    cls = np.zeros(len(pos), dtype=np.int8)
    cls[sc.detached] = 1
    cls[sc.under] = 3
    cls[sc.floating] = 2
    cls[sc.isolated] = 4
    colors = {0: (150, 150, 150), 1: (230, 140, 40), 2: (40, 40, 235), 3: (30, 150, 255), 4: (220, 60, 220)}
    lo = np.percentile(pos, 0.5, axis=0)
    hi = np.percentile(pos, 99.5, axis=0)
    pad = (hi - lo) * 0.08 + 1e-9
    lo, hi = lo - pad, hi + pad
    panels = []
    for ax_u, ax_v, title in ((0, 1, "planta (x Este, y Norte)"), (0, 2, "costado (x Este, z arriba)")):
        img = np.full((size, size, 3), 255, np.uint8)
        span = max(hi[ax_u] - lo[ax_u], hi[ax_v] - lo[ax_v])
        u = ((pos[:, ax_u] - lo[ax_u]) / span * (size - 1)).astype(np.int64)
        v = (size - 1 - (pos[:, ax_v] - lo[ax_v]) / span * (size - 1)).astype(np.int64)
        ok = (u >= 0) & (u < size) & (v >= 0) & (v < size) & (alpha >= LINK_ALPHA)
        for c in (0, 1, 3, 2, 4):  # la escena abajo, los problemas encima
            m = ok & (cls == c)
            r = 1 if c == 0 else 2
            for uu, vv in zip(u[m], v[m]):
                cv2.circle(img, (int(uu), int(vv)), r, colors[c], -1)
        if ax_v == 2:
            nrm, d = sc.normal, sc.d
            ym = float(np.median(pos[:, 1]))
            xs = np.array([lo[0], hi[0]])
            zs = -(nrm[0] * xs + nrm[1] * ym + d) / max(nrm[2], 1e-9)
            pts = [(int((x - lo[0]) / span * (size - 1)), int(size - 1 - (z - lo[2]) / span * (size - 1))) for x, z in zip(xs, zs)]
            cv2.line(img, pts[0], pts[1], (0, 160, 0), 2)
        cv2.putText(img, title, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
        panels.append(img)
    legend = np.full((40, size * 2, 3), 255, np.uint8)
    x = 12
    for c, name in ((0, "escena"), (1, "isla en el suelo"), (2, "flotante"), (3, "bajo el suelo"), (4, "suelta")):
        cv2.circle(legend, (x + 8, 20), 7, colors[c], -1)
        cv2.putText(legend, name, (x + 22, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 1)
        x += 60 + 11 * len(name)
    cv2.putText(legend, "linea verde: suelo", (x + 10, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 120, 0), 1)
    cv2.imwrite(path, np.vstack([np.hstack(panels), legend]))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Pruebas de consistencia de un scene.splat")
    ap.add_argument("splat")
    ap.add_argument("--result", help="result.json de la reconstrucción")
    ap.add_argument("--json", help="guarda el reporte en este archivo")
    ap.add_argument("--png", help="guarda vistas de planta y costado coloreadas por clase")
    args = ap.parse_args(argv)
    with open(args.splat, "rb") as f:
        data = f.read()
    result = None
    if args.result:
        with open(args.result, encoding="utf-8") as f:
            result = json.load(f)
    rep = analyze(data, result)
    print(format_report(rep, args.splat))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(rep.to_dict(), f, ensure_ascii=False, indent=2)
    if args.png:
        render_views(rep, args.png)
    return 1 if rep.failed else 0


if __name__ == "__main__":
    sys.exit(main())
