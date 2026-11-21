"""Alineación de la reconstrucción (sistema de VGGT, escala arbitraria) al ENU local del incidente.

- gps: ≥3 posiciones GPS distintas, separadas y no alineadas en una recta (dron con lat/lng/alt
  por cuadro; teléfonos con una posición por video) → similitud de Umeyama, escala en metros.
- approximate: sin eso, la vertical se estima desde las cámaras (y el plano del suelo), la escala
  desde la altura típica de la cámara y el rumbo desde la brújula o el GPS que haya.

Convención de cámaras: matrices cámara→mundo 4×4 en OpenCV (x derecha, y abajo, z adelante).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal, Sequence

import numpy as np

from .geo import heading_vector, to_enu

# Altura típica de un teléfono en la mano.
PHONE_HEIGHT_M = 1.5
# Altura supuesta de un dron sin altitud informada (LIMITS: misiones de 10 a 120 m, 45 por defecto).
DRONE_DEFAULT_ALT_M = 45.0
MIN_GPS_POSITIONS = 3
# Dos posiciones a menos de esto cuentan como una sola.
MIN_SEPARATION_M = 3.0
# Las posiciones deben extenderse al menos esto (desviación) en una segunda dirección: si no,
# están sobre una recta y el giro en torno a ella queda indeterminado.
MIN_LATERAL_SPREAD_M = 1.0
# Un teléfono con precisión peor que esto no sirve para alinear.
MAX_PHONE_ACCURACY_M = 60.0
# Altitudes de dron mayores que esto parecen sobre el nivel del mar: se nivela con el suelo.
MSL_ALTITUDE_HINT_M = 150.0

AlignmentMode = Literal["gps", "approximate", "none"]


@dataclass(frozen=True)
class CameraInfo:
    source: str
    media_id: str
    lat: float | None
    lng: float | None
    alt_m: float | None
    heading_deg: float | None
    per_frame_gps: bool
    accuracy_m: float | None = None


@dataclass(frozen=True)
class Alignment:
    # Lleva puntos del sistema de VGGT al ENU local (x Este, y Norte, z arriba).
    matrix: np.ndarray
    mode: AlignmentMode
    scale_known: bool
    gps_positions: int
    gps_rms_m: float | None
    note: str


@dataclass(frozen=True)
class Plane:
    normal: np.ndarray
    point: np.ndarray
    inlier_fraction: float


# ─────────────────────────────── utilidades geométricas ───────────────────────────────


def umeyama(src: np.ndarray, dst: np.ndarray, with_scale: bool = True) -> tuple[float, np.ndarray, np.ndarray]:
    """Similitud (s, R, t) que minimiza Σ‖dst − (s·R·src + t)‖² (Umeyama 1991). Funciona en 2D o 3D."""
    src = np.asarray(src, dtype=np.float64)
    dst = np.asarray(dst, dtype=np.float64)
    if src.shape != dst.shape or src.ndim != 2 or src.shape[0] < 2:
        raise ValueError("umeyama: se necesitan ≥2 pares con la misma forma")
    n, dim = src.shape
    mu_s = src.mean(axis=0)
    mu_d = dst.mean(axis=0)
    xs = src - mu_s
    xd = dst - mu_d
    var_s = float((xs**2).sum() / n)
    cov = xd.T @ xs / n
    u, d, vt = np.linalg.svd(cov)
    s_mat = np.eye(dim)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        s_mat[-1, -1] = -1.0
    r = u @ s_mat @ vt
    scale = float((d * np.diag(s_mat)).sum() / var_s) if with_scale and var_s > 0 else 1.0
    t = mu_d - scale * r @ mu_s
    return scale, r, t


def similarity_matrix(scale: float, rot: np.ndarray, t: np.ndarray) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3] = scale * rot
    m[:3, 3] = t
    return m


def apply_to_points(matrix: np.ndarray, points: np.ndarray) -> np.ndarray:
    return points @ matrix[:3, :3].T + matrix[:3, 3]


def matrix_scale(matrix: np.ndarray) -> float:
    return float(np.cbrt(np.linalg.det(matrix[:3, :3])))


def apply_to_cameras(matrix: np.ndarray, c2w: np.ndarray) -> np.ndarray:
    """Transforma cámaras cámara→mundo (N,4,4) con una similitud: rota y traslada, sin escalar ejes."""
    s = matrix_scale(matrix)
    rot = matrix[:3, :3] / s
    out = np.array(c2w, dtype=np.float64, copy=True)
    out[:, :3, :3] = rot @ c2w[:, :3, :3]
    out[:, :3, 3] = c2w[:, :3, 3] @ matrix[:3, :3].T + matrix[:3, 3]
    return out


def rotation_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Rotación mínima que lleva el vector unitario a sobre b (Rodrigues)."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if c < -0.999999:
        # Opuestos: 180° en torno a cualquier eje perpendicular.
        axis = np.cross(a, [1.0, 0.0, 0.0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0.0, 1.0, 0.0])
        axis /= np.linalg.norm(axis)
        return 2.0 * np.outer(axis, axis) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1.0 / (1.0 + c))


def rot_z(angle: float) -> np.ndarray:
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def count_distinct(positions: np.ndarray, min_sep: float = MIN_SEPARATION_M) -> int:
    """Grupos de posiciones separados por más de `min_sep` (agrupación voraz)."""
    reps: list[np.ndarray] = []
    for p in positions:
        if all(np.linalg.norm(p - r) >= min_sep for r in reps):
            reps.append(p)
    return len(reps)


def principal_spread(points: np.ndarray) -> np.ndarray:
    """Desviaciones estándar a lo largo de los ejes principales (de mayor a menor)."""
    if len(points) < 2:
        return np.zeros(points.shape[1] if points.ndim == 2 else 3)
    x = points - points.mean(axis=0)
    return np.linalg.svd(x, compute_uv=False) / math.sqrt(len(points))


def fit_ground_plane(
    points: np.ndarray,
    up0: np.ndarray,
    max_angle_deg: float = 30.0,
    iterations: int = 400,
    low_quantile: float = 0.4,
    seed: int = 0,
) -> Plane | None:
    """Plano dominante casi perpendicular a `up0`, buscado en la parte baja de la escena
    (para preferir el suelo antes que un techo). None si no hay uno convincente."""
    pts = np.asarray(points, dtype=np.float64)
    if len(pts) < 50:
        return None
    rng = np.random.default_rng(seed)
    if len(pts) > 100_000:
        pts = pts[rng.choice(len(pts), 100_000, replace=False)]
    up0 = up0 / np.linalg.norm(up0)
    heights = pts @ up0
    lo, hi = np.percentile(pts, 5, axis=0), np.percentile(pts, 95, axis=0)
    diag = float(np.linalg.norm(hi - lo))
    if not math.isfinite(diag) or diag <= 0:
        return None
    thr = 0.01 * diag
    low = pts[heights <= np.quantile(heights, low_quantile)]
    if len(low) < 3:
        return None
    cos_max = math.cos(math.radians(max_angle_deg))
    best_n: np.ndarray | None = None
    best_d = 0.0
    best_count = 0
    for _ in range(iterations):
        a, b, c = low[rng.choice(len(low), 3, replace=False)]
        n = np.cross(b - a, c - a)
        norm = np.linalg.norm(n)
        if norm < 1e-12:
            continue
        n = n / norm
        if n @ up0 < 0:
            n = -n
        if n @ up0 < cos_max:
            continue
        d = float(n @ a)
        count = int((np.abs(pts @ n - d) < thr).sum())
        if count > best_count:
            best_n, best_d, best_count = n, d, count
    if best_n is None:
        return None
    inliers = pts[np.abs(pts @ best_n - best_d) < thr]
    centroid = inliers.mean(axis=0)
    # Refina con mínimos cuadrados sobre los inliers.
    _, _, vt = np.linalg.svd(inliers - centroid, full_matrices=False)
    normal = vt[-1]
    if normal @ up0 < 0:
        normal = -normal
    if normal @ up0 < cos_max:
        normal = best_n
    frac = len(inliers) / len(pts)
    if frac < 0.08:
        return None
    return Plane(normal=normal, point=centroid, inlier_fraction=frac)


def cam_up(c2w: np.ndarray) -> np.ndarray:
    """Dirección "arriba" de la imagen en el mundo (−y de la cámara OpenCV), por cámara."""
    return -c2w[:, :3, 1]


def cam_forward(c2w: np.ndarray) -> np.ndarray:
    return c2w[:, :3, 2]


def _unit(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


# ─────────────────────────────────── GPS ───────────────────────────────────


def gps_correspondences(
    centers: np.ndarray, cams: Sequence[CameraInfo], origin_lat: float, origin_lng: float
) -> tuple[np.ndarray, np.ndarray]:
    """Pares (centro de cámara en VGGT, posición ENU). Los cuadros de dron aportan uno cada uno;
    un video de teléfono, uno solo: el centro medio de sus cámaras ↔ su posición."""
    src: list[np.ndarray] = []
    dst: list[list[float]] = []
    phone_groups: dict[tuple[str, float, float], list[int]] = {}
    for i, c in enumerate(cams):
        if c.lat is None or c.lng is None:
            continue
        if c.per_frame_gps:
            if c.alt_m is None and c.source == "drone":
                continue
            e, n = to_enu(origin_lat, origin_lng, c.lat, c.lng)
            z = c.alt_m if c.alt_m is not None else PHONE_HEIGHT_M
            src.append(centers[i])
            dst.append([e, n, z])
        else:
            if c.accuracy_m is not None and c.accuracy_m > MAX_PHONE_ACCURACY_M:
                continue
            phone_groups.setdefault((c.media_id, c.lat, c.lng), []).append(i)
    for (_, lat, lng), idxs in phone_groups.items():
        e, n = to_enu(origin_lat, origin_lng, lat, lng)
        src.append(centers[idxs].mean(axis=0))
        dst.append([e, n, PHONE_HEIGHT_M])
    if not src:
        return np.zeros((0, 3)), np.zeros((0, 3))
    return np.asarray(src, dtype=np.float64), np.asarray(dst, dtype=np.float64)


def _upright_ok(rot: np.ndarray, c2w: np.ndarray, cams: Sequence[CameraInfo]) -> bool:
    """Control de cordura: con la escena alineada, los teléfonos deben quedar mayormente
    derechos y el dron no puede mirar al cielo."""
    up = cam_up(c2w) @ rot.T
    fwd = cam_forward(c2w) @ rot.T
    hand = [i for i, c in enumerate(cams) if c.source != "drone"]
    drone = [i for i, c in enumerate(cams) if c.source == "drone"]
    if hand and float(up[hand, 2].mean()) < 0.2:
        return False
    if drone and float(fwd[drone, 2].mean()) > 0.3:
        return False
    return True


def try_gps_alignment(
    centers: np.ndarray,
    c2w: np.ndarray,
    cams: Sequence[CameraInfo],
    points: np.ndarray,
    origin_lat: float,
    origin_lng: float,
) -> tuple[Alignment | None, str]:
    """Alineación GPS si los datos alcanzan; si no, (None, motivo en español)."""
    src, dst = gps_correspondences(centers, cams, origin_lat, origin_lng)
    distinct = count_distinct(dst) if len(dst) else 0
    if distinct < MIN_GPS_POSITIONS:
        return None, f"solo hay {distinct} posición(es) GPS distinta(s)"
    spread = principal_spread(dst)
    if spread[1] < MIN_LATERAL_SPREAD_M:
        return None, "las posiciones GPS están casi en línea recta"
    src_spread = principal_spread(src)
    if src_spread[0] <= 0 or src_spread[1] < 0.02 * src_spread[0]:
        return None, "las cámaras reconstruidas están casi en línea recta"
    scale, rot, t = umeyama(src, dst, with_scale=True)
    if not (math.isfinite(scale) and scale > 0 and np.all(np.isfinite(rot)) and np.all(np.isfinite(t))):
        return None, "el ajuste GPS no convergió"
    resid = dst - (src @ (scale * rot).T + t)
    rms = float(np.sqrt((resid**2).sum(axis=1).mean()))
    dst_rms = float(np.sqrt(((dst - dst.mean(axis=0)) ** 2).sum(axis=1).mean()))
    if rms > max(15.0, 0.5 * dst_rms):
        return None, f"el GPS no calza con las cámaras (error medio {rms:.0f} m)"
    if not _upright_ok(rot, c2w, cams):
        return None, "el ajuste GPS deja la escena invertida"
    matrix = similarity_matrix(scale, rot, t)
    note = f"Alineada con {distinct} posiciones GPS (error medio {rms:.0f} m)."
    if float(dst[:, 2].mean()) > MSL_ALTITUDE_HINT_M:
        # Altitudes sobre el nivel del mar: el suelo se lleva a z = 0.
        plane = fit_ground_plane(apply_to_points(matrix, points), np.array([0.0, 0.0, 1.0]))
        if plane is not None:
            matrix[2, 3] -= float(plane.point[2])
            note += " Altura nivelada con el suelo."
    return (
        Alignment(matrix=matrix, mode="gps", scale_known=True, gps_positions=distinct, gps_rms_m=rms, note=note),
        "",
    )


# ─────────────────────────────── aproximada ───────────────────────────────


def estimate_up(c2w: np.ndarray, cams: Sequence[CameraInfo]) -> np.ndarray:
    """Vertical inicial: promedio de los "arriba" de los teléfonos (se sostienen derechos);
    con solo dron, la normal del plano de vuelo orientada contra la mirada."""
    hand = [i for i, c in enumerate(cams) if c.source != "drone"]
    if hand:
        return _unit(cam_up(c2w[hand]).mean(axis=0))
    centers = c2w[:, :3, 3]
    fwd = cam_forward(c2w)
    if len(centers) >= 3:
        x = centers - centers.mean(axis=0)
        _, sv, vt = np.linalg.svd(x, full_matrices=False)
        if sv[0] > 1e-9 and sv[1] > 0.1 * sv[0]:
            n = vt[-1]
            if float(fwd.mean(axis=0) @ n) > 0:
                n = -n
            return _unit(n)
    return _unit(-fwd.mean(axis=0))


def _yaw_from_pairs(vectors: np.ndarray, targets: np.ndarray) -> float:
    """Ángulo que mejor gira los vectores 2D `vectors` sobre `targets` (mínimos cuadrados)."""
    cross = float((vectors[:, 0] * targets[:, 1] - vectors[:, 1] * targets[:, 0]).sum())
    dot = float((vectors * targets).sum())
    return math.atan2(cross, dot)


def approximate_alignment(
    c2w: np.ndarray,
    cams: Sequence[CameraInfo],
    points: np.ndarray,
    origin_lat: float,
    origin_lng: float,
    reason: str,
) -> Alignment:
    centers = c2w[:, :3, 3]
    up0 = estimate_up(c2w, cams)
    plane = fit_ground_plane(points, up0)
    up = plane.normal if plane is not None else up0
    heights_all = points @ up
    ground_h = float(plane.point @ up) if plane is not None else float(np.percentile(heights_all, 5))
    r_up = rotation_between(up, np.array([0.0, 0.0, 1.0]))
    cam_h = centers @ up - ground_h

    hand = [i for i, c in enumerate(cams) if c.source != "drone"]
    drone = [i for i, c in enumerate(cams) if c.source == "drone"]
    scale = float("nan")
    if hand and np.median(cam_h[hand]) > 0:
        scale = PHONE_HEIGHT_M / float(np.median(cam_h[hand]))
    elif drone and np.median(cam_h[drone]) > 0:
        alts = [cams[i].alt_m for i in drone if cams[i].alt_m is not None and 0 < cams[i].alt_m < MSL_ALTITUDE_HINT_M]
        target = float(np.median(alts)) if alts else DRONE_DEFAULT_ALT_M
        scale = target / float(np.median(cam_h[drone]))
    if not (math.isfinite(scale) and scale > 0):
        scale = 1.0

    # Sistema intermedio: vertical = z, escala aproximada, suelo en z = 0, sin rumbo.
    def to_level(p: np.ndarray) -> np.ndarray:
        return (p - up * ground_h) @ r_up.T * scale

    lvl_centers = to_level(centers)
    fwd = cam_forward(c2w) @ r_up.T
    fwd_h = fwd[:, :2]
    fwd_norm = np.linalg.norm(fwd_h, axis=1)
    ok = fwd_norm > 0.2
    note_parts = ["Vertical estimada desde las cámaras; escala aproximada"]

    yaw = 0.0
    translation = np.zeros(2)
    src, dst = gps_correspondences(lvl_centers, cams, origin_lat, origin_lng)
    distinct = count_distinct(dst) if len(dst) else 0
    used_gps_2d = False
    if distinct >= 2:
        s2, r2, t2 = umeyama(src[:, :2], dst[:, :2], with_scale=True)
        if math.isfinite(s2) and 0.05 < s2 < 20 and np.linalg.det(r2) > 0:
            yaw = math.atan2(r2[1, 0], r2[0, 0])
            scale *= s2
            translation = t2
            used_gps_2d = True
            note_parts.append(f"rumbo y escala desde {distinct} posiciones GPS")
    if not used_gps_2d:
        headings = [
            (i, cams[i].heading_deg) for i in range(len(cams)) if cams[i].heading_deg is not None and ok[i]
        ]
        if headings:
            vecs = np.array([fwd_h[i] / fwd_norm[i] for i, _ in headings])
            tgts = np.array([heading_vector(h) for _, h in headings])
            yaw = _yaw_from_pairs(vecs, tgts)
            note_parts.append("rumbo desde la brújula del teléfono o dron")
        elif ok.any():
            mean_f = _unit((fwd_h[ok] / fwd_norm[ok, None]).mean(axis=0))
            yaw = _yaw_from_pairs(mean_f[None, :], np.array([[0.0, 1.0]]))
            note_parts.append("rumbo desconocido (la vista principal se dejó hacia el norte)")
        rz = rot_z(yaw)
        if distinct == 1:
            translation = dst[:, :2].mean(axis=0) - src[:, :2].mean(axis=0) @ rz[:2, :2].T
            note_parts.append("ubicada con la única posición GPS")
        else:
            pts_lvl = to_level(points) @ rz.T
            translation = -np.median(pts_lvl[:, :2], axis=0)
            note_parts.append("sin GPS: centrada en el incidente")

    rz = rot_z(yaw)
    linear = scale * rz @ r_up
    matrix = np.eye(4)
    matrix[:3, :3] = linear
    matrix[:3, 3] = -linear @ (up * ground_h)
    matrix[0, 3] += translation[0]
    matrix[1, 3] += translation[1]
    note = "; ".join(note_parts) + f" ({reason})."
    return Alignment(
        matrix=matrix,
        mode="approximate",
        scale_known=False,
        gps_positions=distinct,
        gps_rms_m=None,
        note=note[0].upper() + note[1:],
    )


def align_scene(
    c2w: np.ndarray,
    cams: Sequence[CameraInfo],
    points: np.ndarray,
    origin_lat: float,
    origin_lng: float,
) -> Alignment:
    """Elige la mejor alineación disponible. `c2w` (N,4,4) y `points` (M,3) en el sistema de VGGT."""
    centers = c2w[:, :3, 3]
    gps, reason = try_gps_alignment(centers, c2w, cams, points, origin_lat, origin_lng)
    if gps is not None:
        return gps
    try:
        return approximate_alignment(c2w, cams, points, origin_lat, origin_lng, reason)
    except (np.linalg.LinAlgError, ValueError, FloatingPointError):
        return Alignment(
            matrix=np.eye(4),
            mode="none",
            scale_known=False,
            gps_positions=0,
            gps_rms_m=None,
            note="No se pudo alinear la escena: queda en el sistema de la reconstrucción.",
        )
