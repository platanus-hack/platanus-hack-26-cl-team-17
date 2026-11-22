"""Reconstrucción 3D en vivo a partir del video del dron (ver LIVE3D.md).

Ventanas deslizantes de VGGT: cada ventana junta los cuadros clave nuevos con algunas anclas ya
ubicadas en el mapa. VGGT entrega cámaras y profundidad de la ventana en su propio sistema (el de
su primera cámara, con su propia escala); los píxeles confiables de las anclas tienen posición en
ambos sistemas y una similitud robusta lleva la ventana al mapa (como VGGT-Long). De cada ventana
quedan los puntos de los cuadros nuevos que caen en vóxeles libres: un trozo inmutable que el
cliente pide una sola vez.

Solo numpy y OpenCV: el modelo entra como `Estimator` (VGGT en la imagen de GPU, `FakeEstimator`
para desarrollo y pruebas sin GPU).
"""

from __future__ import annotations

import math
import struct
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Protocol, Sequence

import cv2
import numpy as np

# Lado de VGGT y múltiplo de los parches.
VGGT_SIZE = 518
PATCH = 14

# Cuadros clave: a lo más uno cada KF_MIN_GAP_S; se descartan los movidos y los casi iguales al anterior.
KF_MIN_GAP_S = 0.3
SHARP_WINDOW = 30
SHARP_MIN_RATIO = 0.35
SAME_DIFF = 1.5  # diferencia media (0..255) en miniatura bajo la cual el cuadro "es el mismo"
SAME_MAX_S = 2.0  # aunque sea igual, uno cada tanto (el dron detenido sigue apareciendo)

# Ventanas.
FIRST_MIN = 6  # cuadros para la primera ventana
FIRST_WAIT_S = 4.0  # o menos si pasó este tiempo (desde 3)
NEW_MIN = 4  # cuadros nuevos para lanzar una ventana
NEW_WAIT_S = 2.5  # o menos (desde 1) si el más viejo esperó esto
NEW_MAX = 12  # más que esto: se submuestrean (prioridad: ir al día)
RECENT_ANCHORS = 4
OLD_ANCHOR_BACK = (8, 16)  # anclas más antiguas: frenan la deriva
KEEP_MAPS = 17  # cuadros clave que conservan su mapa de puntos (los que pueden ser ancla)

# Alineación.
ALIGN_STRIDE = 2
ALIGN_SAMPLE = 40_000
ALIGN_MIN_PAIRS = 300
ALIGN_MAX_REL_ERR = 0.08
MAX_FAILS = 3  # ventanas que no encajan seguidas antes de aceptar la siguiente igual

# Nube.
POINT_STRIDE = 3
VOXEL_FRAC = 1.0 / 300.0  # del tamaño de la escena de la primera ventana
FAR_MULT = 3.5  # más lejos que esto × mediana de profundidad del cuadro = fondo/cielo
EDGE_REL = 0.06  # salto relativo de profundidad por píxel que marca un borde
CONF_QUANTILE = 0.35  # de la ventana: por debajo, fuera
CHUNK_MAX_POINTS = 60_000
MAX_POINTS = 3_000_000
MAX_CAMERAS_OUT = 600

# Orientación para mostrar.
DISPLAY_EVERY = 4  # tras las primeras ventanas, se recalcula cada tanto
DISPLAY_EARLY = 6
PLANE_MAX_ANGLE_DEG = 65.0

POINTS_MAGIC = b"VL3D"


@dataclass(frozen=True)
class Prediction:
    """Salida del modelo para una ventana, en el sistema de la ventana."""

    depth: np.ndarray  # (n,h,w) float32, z de cámara
    conf: np.ndarray  # (n,h,w) float32, ≥ 1 (más alto = más confiable)
    c2w: np.ndarray  # (n,4,4) float64, OpenCV
    K: np.ndarray  # (n,3,3) float64 en (h,w)


class Estimator(Protocol):
    engine: str

    def __call__(self, images: Sequence[np.ndarray], ids: Sequence[int]) -> Prediction: ...


# ---------------------------------------------------------------------------
# Geometría
# ---------------------------------------------------------------------------


def canvas_size(width: int, height: int) -> tuple[int, int]:
    """(w, h) para VGGT: lado largo 518 y lados múltiplos de 14."""
    if width >= height:
        return VGGT_SIZE, max(PATCH, round(height * VGGT_SIZE / width / PATCH) * PATCH)
    return max(PATCH, round(width * VGGT_SIZE / height / PATCH) * PATCH), VGGT_SIZE


def weighted_umeyama(src: np.ndarray, dst: np.ndarray, w: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """Similitud (s, R, t) que minimiza Σ wᵢ‖dstᵢ − (s·R·srcᵢ + t)‖²."""
    w = np.asarray(w, dtype=np.float64)
    w = w / max(float(w.sum()), 1e-300)
    mu_s = w @ src
    mu_d = w @ dst
    xs = src - mu_s
    xd = dst - mu_d
    var_s = float((w * (xs**2).sum(axis=1)).sum())
    cov = (xd * w[:, None]).T @ xs
    u, d, vt = np.linalg.svd(cov)
    s_mat = np.eye(3)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        s_mat[-1, -1] = -1.0
    r = u @ s_mat @ vt
    scale = float((d * np.diag(s_mat)).sum() / var_s) if var_s > 0 else 1.0
    t = mu_d - scale * r @ mu_s
    return scale, r, t


@dataclass(frozen=True)
class Sim3Fit:
    matrix: np.ndarray  # (4,4) local → mundo
    scale: float
    rel_err: float  # mediana del residuo / dispersión de los puntos destino
    pairs: int
    ok: bool


def robust_sim3(src: np.ndarray, dst: np.ndarray, w: np.ndarray, iters: int = 8, seed: int = 0) -> Sim3Fit:
    """Umeyama ponderado + IRLS de Cauchy. `ok` exige pares suficientes y un residuo chico."""
    n = len(src)
    if n < ALIGN_MIN_PAIRS:
        return Sim3Fit(np.eye(4), 1.0, math.inf, n, False)
    if n > ALIGN_SAMPLE:
        pick = np.random.default_rng(seed).choice(n, size=ALIGN_SAMPLE, replace=False)
        src, dst, w = src[pick], dst[pick], w[pick]
    src = src.astype(np.float64)
    dst = dst.astype(np.float64)
    w = np.maximum(w.astype(np.float64), 1e-6)
    s, r, t = weighted_umeyama(src, dst, w)
    res = np.linalg.norm(dst - (s * src @ r.T + t), axis=1)
    for _ in range(iters):
        sigma = max(1.4826 * float(np.median(res)), 1e-12)
        rw = w / (1.0 + (res / (2.5 * sigma)) ** 2)
        s, r, t = weighted_umeyama(src, dst, rw)
        res = np.linalg.norm(dst - (s * src @ r.T + t), axis=1)
    spread = float(np.median(np.linalg.norm(dst - np.median(dst, axis=0), axis=1)))
    rel = float(np.median(res)) / max(spread, 1e-12)
    m = np.eye(4)
    m[:3, :3] = s * r
    m[:3, 3] = t
    ok = bool(np.isfinite(m).all() and s > 0 and rel <= ALIGN_MAX_REL_ERR)
    return Sim3Fit(m, float(s), rel, len(src), ok)


def sim3_cameras(m: np.ndarray, c2w: np.ndarray) -> np.ndarray:
    """Aplica la similitud `m` a cámaras c2w (rotación sin escala)."""
    s = float(np.cbrt(np.linalg.det(m[:3, :3])))
    r = m[:3, :3] / s
    out = np.array(c2w, dtype=np.float64, copy=True)
    out[..., :3, :3] = r @ c2w[..., :3, :3]
    out[..., :3, 3] = (m[:3, :3] @ c2w[..., :3, 3, None])[..., 0] + m[:3, 3]
    return out


def unproject(depth: np.ndarray, K: np.ndarray, c2w: np.ndarray, stride: int) -> np.ndarray:
    """Mapa de profundidad (h,w) → puntos (h/s, w/s, 3) en el sistema de `c2w`."""
    d = depth[::stride, ::stride].astype(np.float64)
    hs, ws = d.shape
    v, u = np.mgrid[0:hs, 0:ws].astype(np.float64) * stride
    x = (u - K[0, 2]) / K[0, 0] * d
    y = (v - K[1, 2]) / K[1, 1] * d
    cam = np.stack((x, y, d), axis=-1)
    return (cam @ c2w[:3, :3].T + c2w[:3, 3]).astype(np.float32)


def depth_edges(depth: np.ndarray) -> np.ndarray:
    """True donde la profundidad salta (bordes de objetos: ahí VGGT deja puntos volando)."""
    d = np.where(np.isfinite(depth) & (depth > 0), depth, np.nan).astype(np.float32)
    gy, gx = np.gradient(d)
    rel = np.sqrt(gx**2 + gy**2) / np.maximum(d, 1e-6)
    return ~(rel <= EDGE_REL)  # NaN cuenta como borde


def voxel_keys(points: np.ndarray, voxel: float) -> np.ndarray:
    k = np.floor(points / voxel).astype(np.int64)
    return (k[:, 0] * 73856093) ^ (k[:, 1] * 19349663) ^ (k[:, 2] * 83492791)


def fit_plane(points: np.ndarray, thresh: float, iters: int = 200, seed: int = 0) -> tuple[np.ndarray, np.ndarray, float]:
    """RANSAC de un plano → (normal unitaria, punto, fracción de inliers)."""
    rng = np.random.default_rng(seed)
    n = len(points)
    best = (np.array([0.0, 0.0, 1.0]), points.mean(axis=0), 0.0)
    if n < 50:
        return best
    best_count = 0
    for _ in range(iters):
        a, b, c = points[rng.choice(n, size=3, replace=False)]
        nrm = np.cross(b - a, c - a)
        ln = np.linalg.norm(nrm)
        if ln < 1e-12:
            continue
        nrm /= ln
        count = int((np.abs((points - a) @ nrm) < thresh).sum())
        if count > best_count:
            best_count = count
            best = (nrm, a, count / n)
    nrm, a, _ = best
    inl = points[np.abs((points - a) @ nrm) < thresh]
    if len(inl) >= 3:
        c = inl.mean(axis=0)
        _, _, vt = np.linalg.svd(inl - c, full_matrices=False)
        nrm = vt[-1] / np.linalg.norm(vt[-1])
        a = c
    return nrm, a, best_count / n


def _unit(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-12 else v


def display_matrix(points: np.ndarray, c2w: np.ndarray, seed: int = 0) -> np.ndarray:
    """Mundo → vista: Y arriba, centrado en la nube, radio típico ≈ 1, mirando como las cámaras."""
    centers = c2w[:, :3, 3]
    cam_up = _unit(-c2w[:, :3, 1].mean(axis=0))  # OpenCV: y abajo
    fwd = _unit(c2w[:, :3, 2].mean(axis=0))
    center = np.median(points, axis=0) if len(points) else centers.mean(axis=0)
    extent = float(np.median(np.linalg.norm(points - center, axis=1))) if len(points) else 1.0
    extent = max(extent, 1e-9)
    up = cam_up
    if len(points) >= 200:
        sample = points
        if len(points) > 30_000:
            sample = points[np.random.default_rng(seed).choice(len(points), size=30_000, replace=False)]
        nrm, p0, frac = fit_plane(sample.astype(np.float64), thresh=0.02 * extent, seed=seed)
        if float((centers.mean(axis=0) - p0) @ nrm) < 0:
            nrm = -nrm
        angle = math.degrees(math.acos(max(-1.0, min(1.0, float(nrm @ cam_up)))))
        if frac >= 0.15 and angle <= PLANE_MAX_ANGLE_DEG:
            up = nrm
    horiz = fwd - (fwd @ up) * up
    if np.linalg.norm(horiz) < 1e-3:  # cámaras mirando hacia abajo: el "adelante" es su arriba de imagen
        horiz = cam_up - (cam_up @ up) * up
    if np.linalg.norm(horiz) < 1e-3:
        horiz = np.cross(up, [1.0, 0.0, 0.0]) if abs(up[0]) < 0.9 else np.cross(up, [0.0, 1.0, 0.0])
    horiz = _unit(horiz)
    z_d = -horiz  # three.js: la cámara mira hacia −Z
    y_d = up
    x_d = np.cross(y_d, z_d)
    rot = np.stack((x_d, y_d, z_d))
    s = 1.0 / extent
    m = np.eye(4)
    m[:3, :3] = s * rot
    m[:3, 3] = -s * rot @ center
    return m


# ---------------------------------------------------------------------------
# Sesión
# ---------------------------------------------------------------------------


@dataclass
class Keyframe:
    index: int
    t: float  # s, reloj del servidor
    image: np.ndarray  # (h,w,3) uint8 RGB al tamaño del lienzo
    c2w: np.ndarray | None = None  # mundo (4,4)
    world: np.ndarray | None = None  # (h/ALIGN_STRIDE, w/ALIGN_STRIDE, 3) float32
    weight: np.ndarray | None = None  # (h/ALIGN_STRIDE, w/ALIGN_STRIDE) float32; 0 = no confiable


@dataclass
class Window:
    anchors: list[Keyframe]
    new: list[Keyframe]


@dataclass
class Chunk:
    xyz: np.ndarray  # (n,3) float32
    rgb: np.ndarray  # (n,3) uint8
    encoded: bytes | None = None


def encode_points(start: int, end: int, chunks: Sequence[Chunk]) -> bytes:
    xyz = np.concatenate([c.xyz for c in chunks]) if chunks else np.zeros((0, 3), np.float32)
    rgb = np.concatenate([c.rgb for c in chunks]) if chunks else np.zeros((0, 3), np.uint8)
    head = POINTS_MAGIC + struct.pack("<III", start, end, len(xyz))
    return head + np.ascontiguousarray(xyz, dtype="<f4").tobytes() + np.ascontiguousarray(rgb, dtype=np.uint8).tobytes()


def decode_points(data: bytes) -> tuple[int, int, np.ndarray, np.ndarray]:
    if data[:4] != POINTS_MAGIC:
        raise ValueError("no es un bloque VL3D")
    start, end, n = struct.unpack("<III", data[4:16])
    xyz = np.frombuffer(data, dtype="<f4", count=n * 3, offset=16).reshape(n, 3)
    rgb = np.frombuffer(data, dtype=np.uint8, count=n * 3, offset=16 + n * 12).reshape(n, 3)
    return start, end, xyz, rgb


class Session:
    def __init__(self, sid: str, engine: str, now: Callable[[], float] = time.monotonic):
        self.sid = sid
        self.engine = engine
        self.now = now
        self.lock = threading.Lock()
        self.size: tuple[int, int] | None = None  # (w,h) del lienzo
        self.pending: deque[Keyframe] = deque()
        self.placed: list[Keyframe] = []
        self.chunks: list[Chunk] = []
        self.cameras: list[np.ndarray] = []
        self.n_points = 0
        self.frames_received = 0
        self.next_index = 0
        self.last_kf_t = -math.inf
        self.last_thumb: np.ndarray | None = None
        self.sharpness: deque[float] = deque(maxlen=SHARP_WINDOW)
        self.voxel: float | None = None
        self.occupied = np.zeros(0, dtype=np.int64)
        self.display = np.eye(4)
        self.fails = 0
        self.state = "waiting"
        self.message: str | None = None
        self.version = 0
        self.last_chunk_ms: float | None = None
        self.updated_at_ms: int | None = None
        self.last_seen = now()
        self.busy = False

    # -- entrada ------------------------------------------------------------

    def add_frame(self, jpeg: bytes) -> dict:
        """Decodifica y decide si el cuadro es clave. CPU, en el hilo HTTP."""
        now = self.now()
        img = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
        with self.lock:
            self.last_seen = now
            self.frames_received += 1
            if img is None:
                return self._ack(False, "no se pudo leer el JPEG")
            if now - self.last_kf_t < KF_MIN_GAP_S:
                return self._ack(False, "muy seguido")
            if self.size is None:
                self.size = canvas_size(img.shape[1], img.shape[0])
            size = self.size
        rgb = cv2.cvtColor(cv2.resize(img, size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        thumb = cv2.resize(gray, (32, 18), interpolation=cv2.INTER_AREA).astype(np.float32)
        with self.lock:
            hist = list(self.sharpness)
            self.sharpness.append(sharp)
            if len(hist) >= 8 and sharp < SHARP_MIN_RATIO * float(np.median(hist)):
                return self._ack(False, "movido")
            if (
                self.last_thumb is not None
                and float(np.abs(thumb - self.last_thumb).mean()) < SAME_DIFF
                and now - self.last_kf_t < SAME_MAX_S
            ):
                return self._ack(False, "igual al anterior")
            self.last_thumb = thumb
            self.last_kf_t = now
            self.pending.append(Keyframe(self.next_index, now, rgb))
            self.next_index += 1
            return self._ack(True, None)

    def _ack(self, accepted: bool, reason: str | None) -> dict:
        return {"accepted": accepted, "reason": reason, "keyframes": len(self.placed), "pending": len(self.pending)}

    # -- planificación --------------------------------------------------------

    def take_window(self) -> Window | None:
        """La próxima ventana si ya toca (y la saca de pendientes)."""
        with self.lock:
            if self.busy or not self.pending:
                return None
            now = self.now()
            p = len(self.pending)
            waited = now - self.pending[0].t
            if not self.placed:
                if not (p >= FIRST_MIN or (p >= 3 and waited >= FIRST_WAIT_S)):
                    return None
            elif not (p >= NEW_MIN or waited >= NEW_WAIT_S):
                return None
            new = list(self.pending)
            self.pending.clear()
            if len(new) > NEW_MAX:
                keep = np.unique(np.round(np.linspace(0, len(new) - 1, NEW_MAX)).astype(int))
                new = [new[i] for i in keep]
            self.busy = True
            return Window(self._anchors(), new)

    def _anchors(self) -> list[Keyframe]:
        if not self.placed:
            return []
        idx = list(range(max(0, len(self.placed) - RECENT_ANCHORS), len(self.placed)))
        for back in OLD_ANCHOR_BACK:
            j = len(self.placed) - back
            if j >= 0 and j not in idx:
                idx.insert(0, j)
        return [self.placed[i] for i in idx if self.placed[i].world is not None]

    # -- procesamiento --------------------------------------------------------

    def process(self, win: Window, estimator: Estimator) -> None:
        t0 = time.perf_counter()
        try:
            frames = win.anchors + win.new
            pred = estimator([k.image for k in frames], [k.index for k in frames])
            self._integrate(win, pred, (time.perf_counter() - t0) * 1000.0)
            with self.lock:
                self.last_chunk_ms = (time.perf_counter() - t0) * 1000.0
        except Exception as err:  # noqa: BLE001 - el servicio sigue con la próxima ventana
            with self.lock:
                self.state = "lost" if self.placed else "waiting"
                self.message = f"Falló una ventana de reconstrucción: {err}"
                self.version += 1
            raise
        finally:
            with self.lock:
                self.busy = False

    def _integrate(self, win: Window, pred: Prediction, infer_ms: float) -> None:
        na = len(win.anchors)
        conf = pred.conf
        valid_conf = conf[np.isfinite(conf) & np.isfinite(pred.depth) & (pred.depth > 0)]
        thr = float(np.quantile(valid_conf, CONF_QUANTILE)) if valid_conf.size else math.inf
        thr = max(thr, 1.0 + 1e-6)

        if na == 0:
            fit = Sim3Fit(np.eye(4), 1.0, 0.0, 0, True)
        else:
            src, dst, w = [], [], []
            for j, kf in enumerate(win.anchors):
                local = unproject(pred.depth[j], pred.K[j], pred.c2w[j], ALIGN_STRIDE)
                c = conf[j, ::ALIGN_STRIDE, ::ALIGN_STRIDE]
                hs, ws = kf.world.shape[:2]
                local, c = local[:hs, :ws], c[:hs, :ws]
                m = (c >= thr) & (kf.weight > 0) & np.isfinite(local).all(axis=-1)
                if m.sum() == 0:
                    continue
                src.append(local[m])
                dst.append(kf.world[m])
                w.append(np.sqrt(np.log(c[m]) * kf.weight[m]))
            if src:
                fit = robust_sim3(np.concatenate(src), np.concatenate(dst), np.concatenate(w), seed=len(self.placed))
            else:
                fit = Sim3Fit(np.eye(4), 1.0, math.inf, 0, False)

        if not fit.ok:
            with self.lock:
                self.fails += 1
                forced = self.fails >= MAX_FAILS and np.isfinite(fit.matrix).all() and fit.pairs >= ALIGN_MIN_PAIRS
                if not forced:
                    self.state = "lost"
                    self.message = (
                        "La última ventana no encajó con lo ya reconstruido (poca superposición). "
                        "Vuelve a pasar por una zona ya vista."
                    )
                    self.version += 1
                    self.last_chunk_ms = infer_ms
                    return
        c2w_world = sim3_cameras(fit.matrix, pred.c2w)
        scale = fit.scale

        # Puntos de los cuadros nuevos.
        xyz_all, rgb_all = [], []
        for j in range(na, na + len(win.new)):
            depth = pred.depth[j]
            ok = np.isfinite(depth) & (depth > 0) & (conf[j] >= thr) & ~depth_edges(depth)
            if ok.any():
                med = float(np.median(depth[ok]))
                ok &= depth <= FAR_MULT * med
            ok_s = ok[::POINT_STRIDE, ::POINT_STRIDE]
            pts = unproject(depth, pred.K[j], c2w_world[j], POINT_STRIDE)
            pts = pts.astype(np.float64)
            # unproject usa la rotación de c2w_world; la escala de la ventana se aplica a la profundidad.
            cam_center = c2w_world[j, :3, 3]
            pts = cam_center + (pts - cam_center) * scale
            img = win.new[j - na].image[::POINT_STRIDE, ::POINT_STRIDE]
            xyz_all.append(pts[ok_s].astype(np.float32))
            rgb_all.append(img[ok_s])
        xyz = np.concatenate(xyz_all) if xyz_all else np.zeros((0, 3), np.float32)
        rgb = np.concatenate(rgb_all) if rgb_all else np.zeros((0, 3), np.uint8)

        # Mapas de las anclas futuras (mundo), con el mismo escalado.
        maps = []
        for j in range(na, na + len(win.new)):
            depth = pred.depth[j]
            world = unproject(depth, pred.K[j], c2w_world[j], ALIGN_STRIDE).astype(np.float64)
            cc = c2w_world[j, :3, 3]
            world = (cc + (world - cc) * scale).astype(np.float32)
            c = conf[j, ::ALIGN_STRIDE, ::ALIGN_STRIDE]
            good = (c >= thr) & np.isfinite(world).all(axis=-1)
            maps.append((world, np.where(good, np.log(np.maximum(c, 1.0)), 0.0).astype(np.float32)))

        with self.lock:
            if self.voxel is None:
                if len(xyz):
                    centers = c2w_world[na:, :3, 3]
                    d = np.linalg.norm(xyz - centers.mean(axis=0), axis=1)
                    self.voxel = max(float(np.median(d)) * VOXEL_FRAC, 1e-9)
                else:
                    self.voxel = 1e-3
            if len(xyz):
                keys = voxel_keys(xyz, self.voxel)
                uniq, first = np.unique(keys, return_index=True)
                fresh = ~np.isin(uniq, self.occupied, assume_unique=True)
                pick = first[fresh]
                if len(pick) > CHUNK_MAX_POINTS:
                    pick = np.random.default_rng(len(self.chunks)).choice(pick, size=CHUNK_MAX_POINTS, replace=False)
                room = MAX_POINTS - self.n_points
                pick = pick[: max(0, room)]
                self.occupied = np.union1d(self.occupied, keys[pick])
                xyz, rgb = xyz[pick], rgb[pick]
            for k, j in zip(win.new, range(na, na + len(win.new))):
                k.c2w = c2w_world[j]
                k.world, k.weight = maps[j - na]
                self.placed.append(k)
                self.cameras.append(c2w_world[j])
            for old in self.placed[:-KEEP_MAPS]:
                old.world = None
                old.weight = None
                old.image = old.image[:1, :1]  # ya no se usa; libera memoria
            self.chunks.append(Chunk(xyz.astype(np.float32), rgb.astype(np.uint8)))
            self.n_points += len(xyz)
            if len(self.chunks) <= DISPLAY_EARLY or len(self.chunks) % DISPLAY_EVERY == 0:
                self.display = display_matrix(self._sample_points(), np.stack(self.cameras))
            if fit.ok:
                self.fails = 0
                self.state = "running"
                self.message = None if self.n_points < MAX_POINTS else "Se alcanzó el máximo de puntos; la nube ya no crece."
            else:
                self.fails = 0
                self.state = "running"
                self.message = "Se retomó el seguimiento tras perderlo: puede haber un salto en la escena."
            self.version += 1
            self.last_chunk_ms = infer_ms
            self.updated_at_ms = int(time.time() * 1000)

    def _sample_points(self, n: int = 60_000) -> np.ndarray:
        if not self.chunks:
            return np.zeros((0, 3))
        xyz = np.concatenate([c.xyz for c in self.chunks[-30:]]).astype(np.float64)
        if len(xyz) > n:
            xyz = xyz[np.random.default_rng(len(self.chunks)).choice(len(xyz), size=n, replace=False)]
        return xyz

    # -- salida ---------------------------------------------------------------

    def status(self, ready: bool) -> dict:
        with self.lock:
            cams = self.cameras[-MAX_CAMERAS_OUT:]
            return {
                "session": self.sid,
                "engine": self.engine,
                "ready": ready,
                "state": self.state,
                "message": self.message,
                "version": self.version,
                "chunks": len(self.chunks),
                "points": self.n_points,
                "keyframes": len(self.placed),
                "frames_received": self.frames_received,
                "pending": len(self.pending),
                "last_chunk_ms": None if self.last_chunk_ms is None else round(self.last_chunk_ms),
                "updated_at": self.updated_at_ms,
                "display": [round(float(v), 6) for v in self.display.reshape(-1)],
                "cameras": [[round(float(v), 5) for v in c[:3, :4].reshape(-1)] for c in cams],
            }

    def points(self, start: int, max_chunks: int) -> bytes:
        with self.lock:
            start = max(0, min(start, len(self.chunks)))
            end = min(len(self.chunks), start + max(1, max_chunks))
            parts = self.chunks[start:end]
        return encode_points(start, end, parts)


# ---------------------------------------------------------------------------
# Motor simulado (desarrollo sin GPU)
# ---------------------------------------------------------------------------


def look_at(center: np.ndarray, target: np.ndarray, up: np.ndarray = np.array([0.0, 0.0, 1.0])) -> np.ndarray:
    """c2w OpenCV (x derecha, y abajo, z adelante)."""
    z = _unit(target - center)
    x = _unit(np.cross(z, up))
    if np.linalg.norm(x) < 1e-9:
        x = np.array([1.0, 0.0, 0.0])
    y = np.cross(z, x)
    m = np.eye(4)
    m[:3, :3] = np.stack((x, y, z), axis=1)
    m[:3, 3] = center
    return m


class FakeEstimator:
    """Imita a VGGT sin GPU: el dron orbita sobre un suelo plano (z=0) con relieve según el brillo
    de la imagen. Devuelve cada ventana en el sistema de su primera cámara y con una escala al azar,
    como VGGT, así se ejercita la alineación entera. Solo para desarrollo: el estado dice "fake"."""

    engine = "fake"

    def __init__(self, seed: int = 0, radius: float = 30.0, height: float = 18.0, step_deg: float = 2.0):
        self.rng = np.random.default_rng(seed)
        self.radius = radius
        self.height = height
        self.step = math.radians(step_deg)

    def camera(self, i: int) -> np.ndarray:
        a = i * self.step
        c = np.array([self.radius * math.cos(a), self.radius * math.sin(a), self.height])
        return look_at(c, np.array([0.0, 0.0, 0.0]))

    def __call__(self, images: Sequence[np.ndarray], ids: Sequence[int]) -> Prediction:
        h, w = images[0].shape[:2]
        f = 0.9 * w
        K = np.array([[f, 0, w / 2], [0, f, h / 2], [0, 0, 1.0]])
        v, u = np.mgrid[0:h, 0:w].astype(np.float64)
        rays = np.stack(((u - K[0, 2]) / f, (v - K[1, 2]) / f, np.ones_like(u)), axis=-1)
        gts = [self.camera(i) for i in ids]
        ref_inv = np.linalg.inv(gts[0])
        s = float(self.rng.uniform(0.3, 3.0))
        depths, c2ws = [], []
        for img, gt in zip(images, gts):
            d_world = rays @ gt[:3, :3].T
            with np.errstate(divide="ignore", invalid="ignore"):
                t = -gt[2, 3] / d_world[..., 2]
            luma = img.astype(np.float32).mean(axis=-1) / 255.0
            t = np.where(t > 0, t, np.nan) * (1.0 - 0.08 * luma)
            depths.append((t * s).astype(np.float32))
            local = ref_inv @ gt
            local[:3, 3] *= s
            c2ws.append(local)
        depth = np.stack(depths)
        conf = np.where(np.isfinite(depth), 3.0 + self.rng.random(depth.shape), 1.0).astype(np.float32)
        return Prediction(depth, conf, np.stack(c2ws), np.tile(K, (len(images), 1, 1)))


# ---------------------------------------------------------------------------
# VGGT (solo en la imagen de GPU)
# ---------------------------------------------------------------------------


class VGGTEstimator:
    engine = "vggt"

    def __init__(self, weights_path: str):
        import torch

        from .posing import load_vggt

        self.torch = torch
        self.device = torch.device("cuda")
        self.model = load_vggt(weights_path, self.device)
        self.gpu = torch.cuda.get_device_name(0)
        # Calienta los kernels con una ventana chica.
        dummy = [np.full((294, 518, 3), 127, np.uint8)] * 4
        self(dummy, [0, 1, 2, 3])

    def __call__(self, images: Sequence[np.ndarray], ids: Sequence[int]) -> Prediction:
        torch = self.torch
        from vggt.utils.pose_enc import pose_encoding_to_extri_intri

        batch = torch.from_numpy(np.stack(images)).to(self.device).permute(0, 3, 1, 2).float().div_(255.0)
        with torch.no_grad():
            with torch.autocast("cuda", dtype=torch.bfloat16):
                preds = self.model(batch)
            extr, intr = pose_encoding_to_extri_intri(preds["pose_enc"], batch.shape[-2:])
        depth = preds["depth"][0, ..., 0].float().cpu().numpy()
        conf = preds["depth_conf"][0].float().cpu().numpy()
        extr = extr[0].double().cpu().numpy()
        intr = intr[0].double().cpu().numpy()
        del preds, batch
        n = len(images)
        c2w = np.tile(np.eye(4), (n, 1, 1))
        rot = np.transpose(extr[:, :3, :3], (0, 2, 1))
        c2w[:, :3, :3] = rot
        c2w[:, :3, 3] = -(rot @ extr[:, :3, 3, None])[..., 0]
        return Prediction(depth.astype(np.float32), conf.astype(np.float32), c2w, intr)


# ---------------------------------------------------------------------------
# Administrador de sesiones + hilo de GPU
# ---------------------------------------------------------------------------

SESSION_IDLE_S = 20 * 60
MAX_SESSIONS = 6


class Manager:
    def __init__(self, make_estimator: Callable[[], Estimator], engine: str, log: Callable[[str], None] = print):
        self.sessions: dict[str, Session] = {}
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.engine = engine
        self.estimator: Estimator | None = None
        self.gpu: str | None = None
        self.error: str | None = None
        self.log = log
        self._make = make_estimator
        self._rr = 0

    @property
    def ready(self) -> bool:
        return self.estimator is not None

    def start(self) -> None:
        threading.Thread(target=self._run, name="live3d-gpu", daemon=True).start()

    def session(self, sid: str, create: bool) -> Session | None:
        with self.lock:
            s = self.sessions.get(sid)
            if s is None and create:
                self._evict()
                s = Session(sid, self.engine)
                self.sessions[sid] = s
                self.log(f"[live3d] sesión nueva {sid}")
            return s

    def reset(self, sid: str) -> None:
        with self.lock:
            self.sessions.pop(sid, None)

    def _evict(self) -> None:
        now = time.monotonic()
        for sid, s in list(self.sessions.items()):
            if now - s.last_seen > SESSION_IDLE_S and not s.busy:
                del self.sessions[sid]
        while len(self.sessions) >= MAX_SESSIONS:
            oldest = min(self.sessions.values(), key=lambda s: s.last_seen)
            del self.sessions[oldest.sid]

    def _run(self) -> None:
        try:
            t0 = time.perf_counter()
            self.estimator = self._make()
            self.gpu = getattr(self.estimator, "gpu", None)
            self.log(f"[live3d] modelo listo ({self.engine}) en {time.perf_counter() - t0:.1f} s")
        except Exception as err:  # noqa: BLE001
            self.error = str(err)
            self.log(f"[live3d] no se pudo cargar el modelo: {err}")
            return
        while True:
            job = self._next()
            if job is None:
                self.wake.wait(0.15)
                self.wake.clear()
                continue
            s, win = job
            t0 = time.perf_counter()
            try:
                s.process(win, self.estimator)
                self.log(
                    f"[live3d] {s.sid}: ventana {len(s.chunks)} ({len(win.anchors)} anclas + {len(win.new)} nuevos) "
                    f"en {(time.perf_counter() - t0) * 1000:.0f} ms · {s.n_points} puntos · {s.state}"
                )
            except Exception as err:  # noqa: BLE001
                self.log(f"[live3d] {s.sid}: falló una ventana: {err!r}")

    def _next(self) -> tuple[Session, Window] | None:
        with self.lock:
            sessions = list(self.sessions.values())
        if not sessions:
            return None
        self._rr += 1
        for k in range(len(sessions)):
            s = sessions[(self._rr + k) % len(sessions)]
            win = s.take_window()
            if win is not None:
                return s, win
        return None
