"""Unión de grupos de VGGT y ajuste fino de cámaras (bundle adjustment) con coincidencias SIFT.

VGGT corre por separado en cada grupo (un video o un set de fotos): dentro de un video sus
cámaras son buenas, pero no sabe dónde queda un video respecto de otro. Aquí:

1. Puntos SIFT en cada cuadro y coincidencias entre pares (vecinos dentro de cada grupo y una
   muestra de pares entre grupos), verificadas con una matriz fundamental robusta (MAGSAC).
2. Entre dos grupos, cada coincidencia verificada da un par de puntos 3D (profundidad de VGGT en
   cada lado) → similitud robusta (RANSAC + Umeyama). Los grupos se unen por un árbol de
   expansión máximo; los que no se conectan con el principal se descartan (mejor una escena
   limpia con menos videos que una con muebles duplicados).
3. Pistas (un mismo punto visto en varios cuadros) → bundle adjustment con pérdida de Huber sobre
   poses, puntos y una focal por grupo, con la primera cámara fija. Si empeora, se revierte.
4. Escala de profundidad por cuadro (la de VGGT contra los puntos ajustados) para la nube densa,
   y descarte de los cuadros que quedan con error de reproyección alto.

Solo numpy, scipy y OpenCV (se prueba sin GPU); el emparejamiento de descriptores usa torch en
la GPU si se le pasa un `device`.
"""

from __future__ import annotations

import math
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

import cv2
import numpy as np

from .align import apply_to_cameras, matrix_scale, similarity_matrix, umeyama
from .depthmap import FrameDepth

SIFT_FEATURES = 4000
RATIO = 0.85
# Vecinos temporales emparejados dentro de un grupo.
SEQ_WINDOW = 6
# Tope de pares entre grupos (se reparte entre los pares de grupos).
CROSS_PAIR_BUDGET = 6000
MIN_CROSS_SAMPLE = 6
MAX_CROSS_SAMPLE = 40
F_THRESHOLD_PX = 2.0
MIN_PAIR_INLIERS = 25
# Unión entre grupos: error relativo a la profundidad aceptado y mínimos para confiar.
SIM3_REL_THRESHOLD = 0.06
SIM3_MIN_INLIERS = 40
SIM3_MIN_INLIER_RATIO = 0.25
SIM3_ITERS = 2000
# Bundle adjustment.
MAX_BA_OBSERVATIONS = 250_000
INIT_MAX_REPROJ_PX = 40.0
BA_OUTLIER_PX = 6.0
HUBER_PX = 2.0
BA_MAX_ITERS = 30
# Un cuadro con al menos estas observaciones y error mediano mayor que el tope se descarta.
FRAME_MIN_OBS = 12
FRAME_MAX_REPROJ_PX = 8.0
MIN_DEPTH_SAMPLES = 20

Log = Callable[[str], None]


@dataclass(frozen=True)
class Features:
    kps: np.ndarray  # (M,2) float64, píxeles de la imagen de entrenamiento
    desc: np.ndarray  # (M,128) float32 RootSIFT normalizado


@dataclass
class Registration:
    kept: np.ndarray  # (N,) bool: cuadros que siguen
    c2w: np.ndarray  # (N,4,4) en el sistema del grupo de referencia (válido donde kept)
    Ks: np.ndarray  # (N,3,3)
    depth_scale: np.ndarray  # (N,) escala de la profundidad de VGGT de cada cuadro
    points: np.ndarray  # (P,3) puntos ajustados
    colors: np.ndarray  # (P,3) 0..1
    dropped_groups: list[int]
    stats: dict[str, Any] = field(default_factory=dict)


# ───────────────────────────── coincidencias ─────────────────────────────


def extract_features(image: np.ndarray, n_features: int = SIFT_FEATURES) -> Features:
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY) if image.ndim == 3 else image
    sift = cv2.SIFT_create(nfeatures=n_features)
    kps, desc = sift.detectAndCompute(gray, None)
    if desc is None or len(kps) == 0:
        return Features(np.zeros((0, 2)), np.zeros((0, 128), dtype=np.float32))
    # RootSIFT: mejora el emparejamiento con distancia euclidiana.
    desc = desc.astype(np.float32)
    desc /= np.maximum(desc.sum(axis=1, keepdims=True), 1e-7)
    desc = np.sqrt(desc)
    return Features(np.array([k.pt for k in kps], dtype=np.float64), desc)


def match_descriptors(da: Any, db: Any, ratio: float = RATIO) -> np.ndarray:
    """Vecino más cercano mutuo + prueba de razón de Lowe. → (K,2) índices (a, b).
    `da`/`db` pueden ser arreglos numpy o tensores de torch (en la GPU)."""
    if len(da) < 2 or len(db) < 2:
        return np.zeros((0, 2), dtype=np.int64)
    if isinstance(da, np.ndarray):
        sim = da @ db.T
        top2 = np.argpartition(-sim, 1, axis=1)[:, :2]
        s0 = np.take_along_axis(sim, top2, axis=1)
        swap = s0[:, 1] > s0[:, 0]
        best = np.where(swap, top2[:, 1], top2[:, 0])
        s_best = np.where(swap, s0[:, 1], s0[:, 0])
        s_second = np.where(swap, s0[:, 0], s0[:, 1])
        back = sim.argmax(axis=0)
    else:  # tensores de torch
        sim = da @ db.T
        vals, inds = sim.topk(2, dim=1)
        best = inds[:, 0].cpu().numpy()
        s_best = vals[:, 0].float().cpu().numpy()
        s_second = vals[:, 1].float().cpu().numpy()
        back = sim.argmax(dim=0).cpu().numpy()
    # Para vectores unitarios: d² = 2 − 2·sim.
    d_best = np.sqrt(np.maximum(2.0 - 2.0 * s_best, 0.0))
    d_second = np.sqrt(np.maximum(2.0 - 2.0 * s_second, 0.0))
    ia = np.arange(len(best))
    ok = (d_best < ratio * d_second) & (back[best] == ia)
    return np.stack((ia[ok], best[ok]), axis=1).astype(np.int64)


def select_pairs(groups: Sequence[Sequence[int]], window: int = SEQ_WINDOW, budget: int = CROSS_PAIR_BUDGET) -> list[tuple[int, int]]:
    """Pares (i<j) de índices globales: vecinos temporales dentro de cada grupo y, entre grupos,
    todos contra todos sobre una muestra pareja de cada uno."""
    pairs: set[tuple[int, int]] = set()
    for idx in groups:
        for a in range(len(idx)):
            for b in range(a + 1, min(len(idx), a + 1 + window)):
                pairs.add((min(idx[a], idx[b]), max(idx[a], idx[b])))
    ng = len(groups)
    n_gp = ng * (ng - 1) // 2
    if n_gp:
        per = int(math.sqrt(budget / n_gp))
        per = max(MIN_CROSS_SAMPLE, min(MAX_CROSS_SAMPLE, per))
        samples = [list(idx) if len(idx) <= per else [idx[round(k * (len(idx) - 1) / (per - 1))] for k in range(per)] for idx in groups]
        for a in range(ng):
            for b in range(a + 1, ng):
                for i in samples[a]:
                    for j in samples[b]:
                        pairs.add((min(i, j), max(i, j)))
    return sorted(pairs)


def verify_pair(ka: np.ndarray, kb: np.ndarray, matches: np.ndarray) -> np.ndarray:
    """Coincidencias consistentes con una matriz fundamental (MAGSAC). → subconjunto de `matches`."""
    if len(matches) < max(8, MIN_PAIR_INLIERS):
        return matches[:0]
    pa = ka[matches[:, 0]].astype(np.float64)
    pb = kb[matches[:, 1]].astype(np.float64)
    try:
        _f, mask = cv2.findFundamentalMat(pa, pb, cv2.USAC_MAGSAC, F_THRESHOLD_PX, 0.999, 5000)
    except cv2.error:
        return matches[:0]
    if mask is None:
        return matches[:0]
    good = matches[mask.ravel().astype(bool)]
    return good if len(good) >= MIN_PAIR_INLIERS else matches[:0]


def match_all(
    feats: Sequence[Features],
    pairs: Sequence[tuple[int, int]],
    device: Any = None,
    workers: int = 16,
) -> dict[tuple[int, int], np.ndarray]:
    descs: list[Any]
    if device is not None:
        import torch

        descs = [torch.from_numpy(f.desc).to(device) for f in feats]
    else:
        descs = [f.desc for f in feats]
    raw = {(i, j): match_descriptors(descs[i], descs[j]) for i, j in pairs}
    del descs

    def one(p: tuple[int, int]) -> tuple[tuple[int, int], np.ndarray]:
        i, j = p
        return p, verify_pair(feats[i].kps, feats[j].kps, raw[p])

    with ThreadPoolExecutor(max_workers=workers) as pool:
        verified = dict(pool.map(one, list(raw)))
    return {p: m for p, m in verified.items() if len(m)}


# ───────────────────────────── unión entre grupos ─────────────────────────────


def backproject(c2w: np.ndarray, K: np.ndarray, uv: np.ndarray, z: np.ndarray) -> np.ndarray:
    """Píxeles con profundidad z → puntos en el mundo de esa cámara."""
    x = (uv[:, 0] - K[0, 2]) / K[0, 0] * z
    y = (uv[:, 1] - K[1, 2]) / K[1, 1] * z
    cam = np.stack((x, y, z), axis=1)
    return cam @ c2w[:3, :3].T + c2w[:3, 3]


def ransac_sim3(
    src: np.ndarray,
    dst: np.ndarray,
    tol: np.ndarray,
    iters: int = SIM3_ITERS,
    seed: int = 0,
) -> tuple[np.ndarray | None, np.ndarray]:
    """Similitud que lleva `src` a `dst` con tolerancia por punto `tol` (en unidades de dst).
    → (matriz 4×4 o None, máscara de inliers)."""
    n = len(src)
    if n < 3:
        return None, np.zeros(n, dtype=bool)
    rng = np.random.default_rng(seed)
    best_mask = np.zeros(n, dtype=bool)
    best_count = 0
    for _ in range(iters):
        pick = rng.choice(n, size=3, replace=False)
        a, b, c = src[pick]
        if np.linalg.norm(np.cross(b - a, c - a)) < 1e-9:
            continue
        try:
            s, r, t = umeyama(src[pick], dst[pick])
        except (np.linalg.LinAlgError, ValueError):
            continue
        if not (math.isfinite(s) and s > 1e-6):
            continue
        err = np.linalg.norm(dst - (s * src @ r.T + t), axis=1)
        mask = err < tol
        count = int(mask.sum())
        if count > best_count:
            best_count, best_mask = count, mask
    if best_count < 3:
        return None, best_mask
    mask = best_mask
    for _ in range(3):
        s, r, t = umeyama(src[mask], dst[mask])
        err = np.linalg.norm(dst - (s * src @ r.T + t), axis=1)
        new_mask = err < tol
        if new_mask.sum() < 3:
            break
        mask = new_mask
    s, r, t = umeyama(src[mask], dst[mask])
    return similarity_matrix(s, r, t), mask


def group_correspondences(
    a: int,
    b: int,
    group_of: np.ndarray,
    c2w_local: np.ndarray,
    Ks: np.ndarray,
    depths: Sequence[FrameDepth],
    feats: Sequence[Features],
    verified: dict[tuple[int, int], np.ndarray],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Pares de puntos 3D (en el sistema del grupo b, en el del grupo a) y la profundidad del lado a."""
    src: list[np.ndarray] = []
    dst: list[np.ndarray] = []
    za: list[np.ndarray] = []
    for (i, j), m in verified.items():
        gi, gj = group_of[i], group_of[j]
        if {gi, gj} != {a, b}:
            continue
        if gi == b:
            i, j = j, i
            m = m[:, ::-1]
        uv_a = feats[i].kps[m[:, 0]]
        uv_b = feats[j].kps[m[:, 1]]
        d_a, ok_a = depths[i].at(uv_a)
        d_b, ok_b = depths[j].at(uv_b)
        ok = ok_a & ok_b
        if ok.sum() < 3:
            continue
        dst.append(backproject(c2w_local[i], Ks[i], uv_a[ok], d_a[ok]))
        src.append(backproject(c2w_local[j], Ks[j], uv_b[ok], d_b[ok]))
        za.append(d_a[ok])
    if not src:
        return np.zeros((0, 3)), np.zeros((0, 3)), np.zeros(0)
    return np.concatenate(src), np.concatenate(dst), np.concatenate(za)


def join_groups(
    n_groups: int,
    group_sizes: Sequence[int],
    edges: dict[tuple[int, int], tuple[np.ndarray, int]],
) -> tuple[dict[int, np.ndarray], list[int], int]:
    """Árbol de expansión máximo (peso = inliers) sobre `edges` {(a,b): (S que lleva b→a, inliers)}.
    Se queda con el componente de más cuadros; la referencia es su grupo más grande.
    → ({grupo: similitud grupo→referencia}, grupos descartados, grupo de referencia)."""
    parent = list(range(n_groups))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    tree: dict[int, list[tuple[int, np.ndarray]]] = defaultdict(list)
    for (a, b), (s_ab, _w) in sorted(edges.items(), key=lambda e: -e[1][1]):
        ra, rb = find(a), find(b)
        if ra == rb:
            continue
        parent[ra] = rb
        # tree[u] guarda (v, similitud que lleva v→u).
        tree[a].append((b, s_ab))
        tree[b].append((a, np.linalg.inv(s_ab)))
    comps: dict[int, list[int]] = defaultdict(list)
    for g in range(n_groups):
        comps[find(g)].append(g)
    main = max(comps.values(), key=lambda c: (sum(group_sizes[g] for g in c), -min(c)))
    ref = max(main, key=lambda g: (group_sizes[g], -g))
    to_ref = {ref: np.eye(4)}
    stack = [ref]
    while stack:
        u = stack.pop()
        for v, s_vu in tree[u]:
            if v in to_ref:
                continue
            to_ref[v] = to_ref[u] @ s_vu
            stack.append(v)
    dropped = [g for g in range(n_groups) if g not in to_ref]
    return to_ref, dropped, ref


# ───────────────────────────── bundle adjustment ─────────────────────────────


def build_tracks(n_kps: Sequence[int], verified: dict[tuple[int, int], np.ndarray]) -> list[list[tuple[int, int]]]:
    """Une coincidencias en pistas [(cuadro, punto clave)]; descarta las que repiten cuadro."""
    offsets = np.concatenate(([0], np.cumsum(n_kps)))
    parent = np.arange(int(offsets[-1]))

    def find(x: int) -> int:
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    for (i, j), m in verified.items():
        for a, b in zip(m[:, 0] + offsets[i], m[:, 1] + offsets[j]):
            ra, rb = find(int(a)), find(int(b))
            if ra != rb:
                parent[ra] = rb
    members: dict[int, list[int]] = defaultdict(list)
    used = set()
    for (i, j), m in verified.items():
        for node in np.concatenate((m[:, 0] + offsets[i], m[:, 1] + offsets[j])):
            node = int(node)
            if node not in used:
                used.add(node)
                members[find(node)].append(node)
    tracks: list[list[tuple[int, int]]] = []
    for nodes in members.values():
        if len(nodes) < 2:
            continue
        imgs = np.searchsorted(offsets, nodes, side="right") - 1
        if len(set(imgs.tolist())) != len(nodes):
            continue
        tracks.append([(int(im), int(nd - offsets[im])) for im, nd in zip(imgs, nodes)])
    return tracks


def rodrigues(rv: np.ndarray) -> np.ndarray:
    """Vectores de rotación (M,3) → matrices (M,3,3)."""
    theta = np.linalg.norm(rv, axis=1)
    small = theta < 1e-12
    k = rv / np.where(small, 1.0, theta)[:, None]
    kx = np.zeros((len(rv), 3, 3))
    kx[:, 0, 1], kx[:, 0, 2] = -k[:, 2], k[:, 1]
    kx[:, 1, 0], kx[:, 1, 2] = k[:, 2], -k[:, 0]
    kx[:, 2, 0], kx[:, 2, 1] = -k[:, 1], k[:, 0]
    s = np.sin(theta)[:, None, None]
    c = (1.0 - np.cos(theta))[:, None, None]
    return np.eye(3)[None] + s * kx + c * (kx @ kx)


def rotvec_of(r: np.ndarray) -> np.ndarray:
    rv, _ = cv2.Rodrigues(np.asarray(r, dtype=np.float64))
    return rv.ravel()


@dataclass
class BAProblem:
    cam_idx: np.ndarray  # (O,) cuadro de cada observación
    pt_idx: np.ndarray  # (O,)
    uv: np.ndarray  # (O,2)
    w2c: np.ndarray  # (N,4,4)
    Ks: np.ndarray  # (N,3,3)
    group_of: np.ndarray  # (N,)
    points: np.ndarray  # (P,3)


def project(p: BAProblem, w2c: np.ndarray, focal_mult: np.ndarray, points: np.ndarray) -> np.ndarray:
    r = w2c[p.cam_idx, :3, :3]
    t = w2c[p.cam_idx, :3, 3]
    xc = np.einsum("oij,oj->oi", r, points[p.pt_idx]) + t
    z = np.where(np.abs(xc[:, 2]) < 1e-9, 1e-9, xc[:, 2])
    k = p.Ks[p.cam_idx]
    f = focal_mult[p.group_of[p.cam_idx]]
    u = k[:, 0, 0] * f * xc[:, 0] / z + k[:, 0, 2]
    v = k[:, 1, 1] * f * xc[:, 1] / z + k[:, 1, 2]
    return np.stack((u, v), axis=1)


def reproj_errors(p: BAProblem, w2c: np.ndarray, focal_mult: np.ndarray, points: np.ndarray) -> np.ndarray:
    return np.linalg.norm(project(p, w2c, focal_mult, points) - p.uv, axis=1)


def _skew(v: np.ndarray) -> np.ndarray:
    m = np.zeros((len(v), 3, 3))
    m[:, 0, 1], m[:, 0, 2] = -v[:, 2], v[:, 1]
    m[:, 1, 0], m[:, 1, 2] = v[:, 2], -v[:, 0]
    m[:, 2, 0], m[:, 2, 1] = -v[:, 1], v[:, 0]
    return m


def _huber(e: np.ndarray) -> tuple[float, np.ndarray]:
    """Costo de Huber sobre normas de residuo y pesos de mínimos cuadrados reponderados."""
    big = e > HUBER_PX
    cost = float(np.where(big, 2.0 * HUBER_PX * e - HUBER_PX**2, e**2).sum())
    return cost, np.where(big, HUBER_PX / np.maximum(e, 1e-12), 1.0)


def bundle_adjust(
    p: BAProblem, fixed_cam: int, n_groups: int, max_iters: int = BA_MAX_ITERS
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Levenberg–Marquardt con jacobiano analítico y complemento de Schur (se eliminan los puntos
    y queda un sistema denso del tamaño de las cámaras). Optimiza poses (salvo `fixed_cam`), una
    focal por grupo y los puntos; la escala queda fija con la distancia entre la cámara fija y la
    más lejana. Pérdida de Huber. → (w2c, focal_mult, puntos)."""
    from scipy.sparse import bsr_matrix, csr_matrix

    n_cam = len(p.w2c)
    observed = np.unique(p.cam_idx)
    free = np.array([c for c in observed if c != fixed_cam], dtype=np.int64)
    slot = -np.ones(n_cam, dtype=np.int64)
    slot[free] = np.arange(len(free))
    n_cp = 6 * len(free)
    n_c = n_cp + n_groups
    n_pts = len(p.points)
    n_obs = len(p.cam_idx)

    def center(w: np.ndarray) -> np.ndarray:
        return -(w[:3, :3].T @ w[:3, 3])

    centers0 = np.array([center(w) for w in p.w2c])
    far = int(observed[np.argmax(np.linalg.norm(centers0[observed] - centers0[fixed_cam], axis=1))])
    d0 = float(np.linalg.norm(centers0[far] - centers0[fixed_cam]))
    gauge_w = 100.0 / d0 if d0 > 1e-9 and slot[far] >= 0 else 0.0
    c_fix = centers0[fixed_cam]

    cs = slot[p.cam_idx]
    has = cs >= 0
    grp = p.group_of[p.cam_idx]
    fx = p.Ks[p.cam_idx, 0, 0]
    fy = p.Ks[p.cam_idx, 1, 1]

    def evaluate(w2c: np.ndarray, fm: np.ndarray, pts: np.ndarray) -> tuple[float, np.ndarray, np.ndarray, float]:
        res = project(p, w2c, fm, pts) - p.uv
        e = np.linalg.norm(res, axis=1)
        cost, wts = _huber(e)
        g = gauge_w * (np.linalg.norm(center(w2c[far]) - c_fix) - d0)
        return cost + g * g, res, wts, g

    w2c = p.w2c.copy()
    fm = np.ones(n_groups)
    pts = p.points.copy()
    cost, res, wts, g = evaluate(w2c, fm, pts)
    lam = 1e-3
    rows2 = np.arange(2 * n_obs).reshape(n_obs, 2)
    for _it in range(max_iters):
        # Jacobianos con perturbación a la izquierda: R ← exp([ω]) R, t ← t + δt.
        r = w2c[p.cam_idx, :3, :3]
        rx = np.einsum("oij,oj->oi", r, pts[p.pt_idx])
        xc = rx + w2c[p.cam_idx, :3, 3]
        z = np.where(np.abs(xc[:, 2]) < 1e-9, 1e-9, xc[:, 2])
        m = fm[grp]
        d = np.zeros((n_obs, 2, 3))
        d[:, 0, 0] = fx * m / z
        d[:, 0, 2] = -fx * m * xc[:, 0] / z**2
        d[:, 1, 1] = fy * m / z
        d[:, 1, 2] = -fy * m * xc[:, 1] / z**2
        j_w = -d @ _skew(rx)
        j_t = d
        j_m = np.stack((fx * xc[:, 0] / z, fy * xc[:, 1] / z), axis=1)
        j_p = d @ r
        sw = np.sqrt(wts)[:, None]
        rw = res * sw

        # Lado de las cámaras (2·O+1 filas): 6 columnas por cámara libre + 1 de la focal del grupo.
        cam_cols = 6 * cs[:, None] + np.arange(6)[None, :]
        j_cam = np.concatenate((j_w, j_t), axis=2) * sw[..., None]
        rr = np.repeat(rows2[has], 6, axis=1).ravel()
        cc = np.repeat(cam_cols[has][:, None, :], 2, axis=1).ravel()
        vv = j_cam[has].reshape(-1)
        rr = np.concatenate((rr, rows2.ravel()))
        cc = np.concatenate((cc, np.repeat(n_cp + grp, 2)))
        vv = np.concatenate((vv, (j_m * sw).ravel()))
        g_row = np.zeros(0)
        if gauge_w > 0:
            wf = w2c[far]
            cf = center(wf)
            dg_dc = gauge_w * (cf - c_fix) / max(np.linalg.norm(cf - c_fix), 1e-12)
            rt = wf[:3, :3].T
            g_row = np.concatenate((dg_dc @ (-rt @ _skew(wf[None, :3, 3])[0]), dg_dc @ (-rt)))
            rr = np.concatenate((rr, np.full(6, 2 * n_obs)))
            cc = np.concatenate((cc, 6 * slot[far] + np.arange(6)))
            vv = np.concatenate((vv, g_row))
        jc = csr_matrix((vv, (rr, cc)), shape=(2 * n_obs + 1, n_c))
        jp_w = j_p * sw[..., None]
        jp = csr_matrix(
            (jp_w.reshape(-1), (np.repeat(rows2.ravel(), 3), np.repeat(3 * p.pt_idx[:, None, None] + np.arange(3), 2, axis=1).ravel())),
            shape=(2 * n_obs + 1, 3 * n_pts),
        )
        rvec = np.concatenate((rw.ravel(), [g]))

        u_mat = (jc.T @ jc).toarray()
        w_mat = (jc.T @ jp).tocsr()
        v_blocks = np.zeros((n_pts, 3, 3))
        np.add.at(v_blocks, p.pt_idx, np.einsum("oki,okj->oij", jp_w, jp_w))
        g_c = jc.T @ rvec
        g_p = jp.T @ rvec

        improved = False
        for _try in range(10):
            u_d = u_mat + np.diag(lam * np.diag(u_mat) + 1e-9)
            v_d = v_blocks + (lam * np.einsum("pii->pi", v_blocks) + 1e-9)[:, :, None] * np.eye(3)[None]
            v_inv = np.linalg.inv(v_d)
            vinv = bsr_matrix((v_inv, np.arange(n_pts), np.arange(n_pts + 1)), shape=(3 * n_pts, 3 * n_pts))
            wv = (w_mat @ vinv).tocsr()
            schur = u_d - (wv @ w_mat.T).toarray()
            rhs = -(g_c - wv @ g_p)
            try:
                dc = np.linalg.solve(schur, rhs)
            except np.linalg.LinAlgError:
                dc = np.linalg.lstsq(schur, rhs, rcond=None)[0]
            dp = vinv @ (-g_p - w_mat.T @ dc)
            w_new = w2c.copy()
            if len(free):
                step = dc[:n_cp].reshape(-1, 6)
                w_new[free, :3, :3] = rodrigues(step[:, :3]) @ w2c[free, :3, :3]
                w_new[free, :3, 3] = w2c[free, :3, 3] + step[:, 3:]
            fm_new = fm + dc[n_cp:]
            pts_new = pts + dp.reshape(-1, 3)
            new = evaluate(w_new, fm_new, pts_new)
            if np.isfinite(new[0]) and new[0] < cost:
                rel = (cost - new[0]) / max(cost, 1e-12)
                w2c, fm, pts = w_new, fm_new, pts_new
                cost, res, wts, g = new
                lam = max(lam / 3.0, 1e-7)
                improved = True
                break
            lam *= 4.0
        if not improved or rel < 1e-6:
            break
    return w2c, fm, pts


# ───────────────────────────── orquestación ─────────────────────────────


def register(
    images: Sequence[np.ndarray],
    group_of: np.ndarray,
    c2w_local: np.ndarray,
    Ks: np.ndarray,
    depths: Sequence[FrameDepth],
    log: Log = print,
    device: Any = None,
    feats: Sequence[Features] | None = None,
) -> Registration:
    """`group_of` (N,) grupo de cada cuadro; `c2w_local` en el sistema de VGGT de su grupo."""
    n = len(images)
    group_of = np.asarray(group_of, dtype=np.int64)
    n_groups = int(group_of.max()) + 1
    groups = [list(np.nonzero(group_of == g)[0]) for g in range(n_groups)]
    sizes = [len(g) for g in groups]
    stats: dict[str, Any] = {}

    if feats is None:
        with ThreadPoolExecutor(max_workers=16) as pool:
            feats = list(pool.map(extract_features, images))
    pairs = select_pairs(groups)
    verified = match_all(feats, pairs, device=device)
    stats["pairs"] = len(pairs)
    stats["verified_pairs"] = len(verified)
    log(f"Coincidencias: {len(verified)}/{len(pairs)} pares verificados, {int(np.median([len(f.kps) for f in feats]))} puntos SIFT por cuadro")

    # Unión de grupos.
    edges: dict[tuple[int, int], tuple[np.ndarray, int]] = {}
    for a in range(n_groups):
        for b in range(a + 1, n_groups):
            src, dst, za = group_correspondences(a, b, group_of, c2w_local, Ks, depths, feats, verified)
            if len(src) < SIM3_MIN_INLIERS:
                log(f"Grupos {a}↔{b}: {len(src)} correspondencias 3D, no alcanzan")
                continue
            s_ab, mask = ransac_sim3(src, dst, SIM3_REL_THRESHOLD * za, seed=a * 1000 + b)
            cnt = int(mask.sum())
            ratio = cnt / len(src)
            ok = s_ab is not None and cnt >= SIM3_MIN_INLIERS and ratio >= SIM3_MIN_INLIER_RATIO
            log(f"Grupos {a}↔{b}: {cnt}/{len(src)} correspondencias consistentes ({ratio:.0%}){'' if ok else ', se descarta la unión'}")
            if ok and s_ab is not None:
                edges[(a, b)] = (s_ab, cnt)
    to_ref, dropped, ref = join_groups(n_groups, sizes, edges)
    kept = np.array([group_of[i] in to_ref for i in range(n)])
    c2w = np.array(c2w_local, dtype=np.float64, copy=True)
    depth_scale = np.ones(n)
    for g, s in to_ref.items():
        idx = groups[g]
        c2w[idx] = apply_to_cameras(s, c2w_local[idx])
        depth_scale[idx] = matrix_scale(s)
    stats["dropped_groups"] = dropped

    # Pistas y puntos iniciales (mediana de las retroproyecciones con profundidad de VGGT).
    kverified = {p: m for p, m in verified.items() if kept[p[0]] and kept[p[1]]}
    tracks = build_tracks([len(f.kps) for f in feats], kverified)
    tracks.sort(key=len, reverse=True)
    obs_cam: list[int] = []
    obs_pt: list[int] = []
    obs_uv: list[np.ndarray] = []
    pts: list[np.ndarray] = []
    total = 0
    for tr in tracks:
        if total >= MAX_BA_OBSERVATIONS:
            break
        cand = []
        for im, kp in tr:
            uv = feats[im].kps[kp]
            z, ok = depths[im].at(uv[None])
            if ok[0]:
                cand.append(backproject(c2w[im], Ks[im], uv[None], z * depth_scale[im])[0])
        if not cand:
            continue
        pid = len(pts)
        pts.append(np.median(np.array(cand), axis=0))
        for im, kp in tr:
            obs_cam.append(im)
            obs_pt.append(pid)
            obs_uv.append(feats[im].kps[kp])
        total += len(tr)

    reg = Registration(
        kept=kept, c2w=c2w, Ks=np.array(Ks, dtype=np.float64, copy=True), depth_scale=depth_scale,
        points=np.zeros((0, 3)), colors=np.zeros((0, 3)), dropped_groups=dropped, stats=stats,
    )
    if len(pts) < 50:
        log(f"Bundle adjustment omitido: solo {len(pts)} pistas")
        stats["ba"] = "skipped"
        return reg

    w2c0 = np.linalg.inv(c2w)
    prob = BAProblem(
        cam_idx=np.array(obs_cam), pt_idx=np.array(obs_pt), uv=np.array(obs_uv),
        w2c=w2c0, Ks=reg.Ks, group_of=group_of, points=np.array(pts),
    )
    fm1 = np.ones(n_groups)
    err0 = reproj_errors(prob, w2c0, fm1, prob.points)
    prob = _subset(prob, err0 < INIT_MAX_REPROJ_PX)
    if prob is None:
        log("Bundle adjustment omitido: las pistas no son consistentes")
        stats["ba"] = "skipped"
        return reg
    err_before = float(np.median(reproj_errors(prob, w2c0, fm1, prob.points)))
    fixed = int(groups[ref][0])
    try:
        w2c1, fm, pts1 = bundle_adjust(prob, fixed, n_groups)
        e1 = reproj_errors(prob, w2c1, fm, pts1)
        prob2 = _subset(BAProblem(**{**prob.__dict__, "w2c": w2c1, "points": pts1}), e1 < BA_OUTLIER_PX)
        if prob2 is not None:
            w2c2, fm2, pts2 = bundle_adjust(prob2, fixed, n_groups)
            prob, w2c1, fm, pts1 = prob2, w2c2, fm2, pts2
        err_after_all = reproj_errors(prob, w2c1, fm, pts1)
    except (ValueError, np.linalg.LinAlgError) as e:
        log(f"Bundle adjustment falló ({e}); se usan las cámaras de VGGT")
        stats["ba"] = "failed"
        return reg
    err_after = float(np.median(err_after_all))
    finite = np.isfinite(w2c1).all() and np.isfinite(pts1).all() and np.all(fm > 0.5) and np.all(fm < 2.0)
    if not finite or err_after > err_before:
        log(f"Bundle adjustment descartado (error {err_before:.2f} → {err_after:.2f} px)")
        stats["ba"] = "reverted"
        return reg
    log(f"Bundle adjustment: {len(prob.points)} puntos, {len(prob.cam_idx)} observaciones, error mediano {err_before:.2f} → {err_after:.2f} px")
    stats.update(ba="ok", reproj_before_px=round(err_before, 2), reproj_after_px=round(err_after, 2))

    c2w_new = np.linalg.inv(w2c1)
    ks_new = reg.Ks.copy()
    for g in range(n_groups):
        idx = groups[g]
        ks_new[idx, 0, 0] *= fm[g]
        ks_new[idx, 1, 1] *= fm[g]

    # Escala de profundidad por cuadro y descarte de cuadros mal ubicados.
    scale_new = depth_scale.copy()
    bad = np.zeros(n, dtype=bool)
    for im in range(n):
        if not kept[im]:
            continue
        sel = prob.cam_idx == im
        if sel.sum() >= FRAME_MIN_OBS and np.median(err_after_all[sel]) > FRAME_MAX_REPROJ_PX:
            bad[im] = True
            continue
        if sel.sum() < MIN_DEPTH_SAMPLES:
            continue
        xc = pts1[prob.pt_idx[sel]] @ w2c1[im, :3, :3].T + w2c1[im, :3, 3]
        z_vggt, ok = depths[im].at(prob.uv[sel])
        ok &= xc[:, 2] > 0
        if ok.sum() >= MIN_DEPTH_SAMPLES:
            s = float(np.median(xc[ok, 2] / z_vggt[ok]))
            if math.isfinite(s) and 0.5 * depth_scale[im] < s < 2.0 * depth_scale[im]:
                scale_new[im] = s
    if bad.any():
        log(f"Se descartan {int(bad.sum())} cuadros con error de reproyección alto")
    if (kept & ~bad).sum() >= 3:
        kept = kept & ~bad
    stats["frames_dropped_ba"] = int(bad.sum())

    cols = np.zeros((len(pts1), 3))
    cnt = np.zeros(len(pts1))
    for im in np.unique(prob.cam_idx):
        sel = prob.cam_idx == im
        img = images[im]
        u = np.clip(np.round(prob.uv[sel, 0]).astype(int), 0, img.shape[1] - 1)
        v = np.clip(np.round(prob.uv[sel, 1]).astype(int), 0, img.shape[0] - 1)
        np.add.at(cols, prob.pt_idx[sel], img[v, u, :3] / 255.0)
        np.add.at(cnt, prob.pt_idx[sel], 1)
    cols /= np.maximum(cnt, 1)[:, None]
    return Registration(
        kept=kept, c2w=c2w_new, Ks=ks_new, depth_scale=scale_new, points=pts1, colors=cols,
        dropped_groups=dropped, stats=stats,
    )


def _subset(p: BAProblem, keep_obs: np.ndarray) -> BAProblem | None:
    """Filtra observaciones, deja solo puntos con ≥2 y renumera."""
    cam = p.cam_idx[keep_obs]
    pt = p.pt_idx[keep_obs]
    uv = p.uv[keep_obs]
    counts = np.bincount(pt, minlength=len(p.points))
    good_pt = counts >= 2
    sel = good_pt[pt]
    cam, pt, uv = cam[sel], pt[sel], uv[sel]
    if good_pt.sum() < 50:
        return None
    remap = -np.ones(len(p.points), dtype=np.int64)
    remap[good_pt] = np.arange(int(good_pt.sum()))
    return BAProblem(cam_idx=cam, pt_idx=remap[pt], uv=uv, w2c=p.w2c, Ks=p.Ks, group_of=p.group_of, points=p.points[good_pt])
