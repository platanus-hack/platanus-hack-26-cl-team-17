"""Gaussian Splatting en vivo (ver LIVE3D.md, sección «Gaussian splatting en vivo»).

Mientras alguien mira la vista de splats, el hilo de GPU del servicio entrena entre ventanas de
VGGT una escena 3DGS que crece con el vuelo:

- **Vistas:** cada cuadro clave ya ubicado (imagen al tamaño del lienzo, cámara del mundo, K de
  VGGT y una máscara de los píxeles con profundidad válida, sin cielo ni fondo lejano).
- **Gaussianas nuevas:** de cada trozo de la nube (solo vóxeles nuevos, o sea zonas recién vistas)
  salen gaussianas isótropas con el color del punto y el tamaño de la distancia a sus vecinos.
- **Entrenamiento:** gsplat (mismo rasterizador que el job), pérdida 0,8·L1 + 0,2·(1−SSIM) solo en
  la máscara, armónicos esféricos de grado 0. La mitad de los pasos va a los cuadros más recientes
  (lo nuevo se ve bien pronto) y la otra mitad a todo el recorrido.
- **Tope:** si no caben, se podan las gaussianas más transparentes.
- **Salida:** cada tanto una instantánea en el binario compacto "VGS1" (17 bytes por gaussiana).

`encode_live_splat` / `decode_live_splat` son solo numpy; `LiveSplatTrainer` importa torch y gsplat al construirse (solo en la imagen de GPU,
aunque el rasterizador se puede inyectar para probarlo en CPU).
"""

from __future__ import annotations

import math
import os
import struct
import time
from dataclasses import dataclass
from typing import Callable, Sequence

import numpy as np

SH_C0 = 0.28209479177387814
SPLAT_MAGIC = b"VGS1"
HEADER = struct.Struct("<4sII3f3f2f")  # magic, version, n, lo[3], hi[3], log_scale_min, log_scale_max
assert HEADER.size == 44

# Gaussianas.
GS_MAX = 450_000  # en entrenamiento
GS_PER_CHUNK = 30_000  # nuevas por trozo de la nube, a lo más
# En la instantánea (≈ 4 MB con 250 000); LIVE3D_SPLAT_EXPORT_MAX lo cambia (ancho de banda).
EXPORT_MAX = int(os.environ.get("LIVE3D_SPLAT_EXPORT_MAX", "250000"))
INIT_OPACITY = 0.5
PRUNE_OPACITY = 0.02
EXPORT_MIN_ALPHA = 0.02
MAX_SCALE_FRAC = 0.03  # de la escala de la escena: nada más grande (evita manchas enormes)

# Vistas.
MAX_TRAIN_VIEWS = 300
RECENT_VIEWS = 10
RECENT_SHARE = 0.5

# Tasas de aprendizaje (las de gsplat, sin decaimiento: la escena nunca "termina").
LR_MEANS = 2e-4  # × escala de la escena
LR_SCALES = 5e-3
LR_QUATS = 1e-3
LR_OPACITIES = 5e-2
LR_COLORS = 5e-3
SSIM_WEIGHT = 0.2


@dataclass
class View:
    """Cuadro clave ubicado, tal como lo deja la sesión (CPU)."""

    index: int
    image: np.ndarray  # (h,w,3) uint8 RGB al tamaño del lienzo
    c2w: np.ndarray  # (4,4) mundo, OpenCV
    K: np.ndarray  # (3,3) para (h,w)
    mask: np.ndarray  # (h,w) bool: píxeles con profundidad válida


# ---------------------------------------------------------------------------
# Binario compacto
# ---------------------------------------------------------------------------


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -60.0, 60.0)))


def encode_live_splat(
    means: np.ndarray,
    log_scales: np.ndarray,
    quats_wxyz: np.ndarray,
    sh0: np.ndarray,
    opacity_logits: np.ndarray,
    version: int,
    max_gaussians: int = EXPORT_MAX,
) -> tuple[bytes, int]:
    """→ (binario "VGS1", gaussianas escritas). Little-endian:

    cabecera (44 B): "VGS1", u32 versión, u32 n, f32×3 mín, f32×3 máx, f32 log-escala mín, f32 máx
    u16[n×3]  posición cuantizada en la caja: p = mín + q/65535·(máx − mín)
    u8[n×3]   log-escala cuantizada: s = exp(lmín + q/255·(lmáx − lmín))
    u8[n×4]   RGBA (RGB = 0,5 + C0·SH0; A = sigmoide(opacidad))
    u8[n×4]   rotación w,x,y,z como q·128 + 128 (igual que .splat)

    Van las más importantes (volumen × opacidad) primero; las que caen fuera de la caja robusta
    (percentiles 0,2–99,8: "flotadores") no se escriben.
    """
    means = np.asarray(means, dtype=np.float64).reshape(-1, 3)
    log_scales = np.asarray(log_scales, dtype=np.float64).reshape(-1, 3)
    quats = np.asarray(quats_wxyz, dtype=np.float64).reshape(-1, 4)
    sh0 = np.asarray(sh0, dtype=np.float64).reshape(-1, 3)
    opacity_logits = np.asarray(opacity_logits, dtype=np.float64).reshape(-1)
    alpha = _sigmoid(opacity_logits)
    qnorm = np.linalg.norm(quats, axis=1)
    ok = (
        np.isfinite(means).all(axis=1)
        & np.isfinite(log_scales).all(axis=1)
        & np.isfinite(quats).all(axis=1)
        & np.isfinite(sh0).all(axis=1)
        & (qnorm > 1e-12)
        & (alpha >= EXPORT_MIN_ALPHA)
    )
    idx = np.nonzero(ok)[0]
    lo = hi = np.zeros(3)
    if len(idx):
        lo = np.percentile(means[idx], 0.2, axis=0)
        hi = np.percentile(means[idx], 99.8, axis=0)
        pad = 0.02 * (hi - lo) + 1e-6
        lo, hi = lo - pad, hi + pad
        inside = ((means[idx] >= lo) & (means[idx] <= hi)).all(axis=1)
        idx = idx[inside]
    if len(idx):
        imp = np.exp(np.clip(log_scales[idx].sum(axis=1), -60.0, 60.0)) * alpha[idx]
        idx = idx[np.argsort(-imp, kind="stable")[: max(0, int(max_gaussians))]]
    n = len(idx)
    ls = log_scales[idx]
    lmin = float(ls.min()) if n else 0.0
    lmax = float(ls.max()) if n else 0.0
    if lmax - lmin < 1e-6:
        lmax = lmin + 1e-6
    span = np.maximum(hi - lo, 1e-12)
    pos_q = np.clip(np.round((means[idx] - lo) / span * 65535.0), 0, 65535).astype("<u2")
    ls_q = np.clip(np.round((ls - lmin) / (lmax - lmin) * 255.0), 0, 255).astype(np.uint8)
    rgba = np.zeros((n, 4), dtype=np.uint8)
    rgba[:, :3] = np.round(np.clip(0.5 + SH_C0 * sh0[idx], 0.0, 1.0) * 255.0).astype(np.uint8)
    rgba[:, 3] = np.round(np.clip(alpha[idx], 0.0, 1.0) * 255.0).astype(np.uint8)
    q = quats[idx] / np.maximum(qnorm[idx, None], 1e-12)
    rot = np.clip(np.round(q * 128.0 + 128.0), 0, 255).astype(np.uint8)
    head = HEADER.pack(SPLAT_MAGIC, int(version) & 0xFFFFFFFF, n, *map(float, lo), *map(float, hi), lmin, lmax)
    body = pos_q.tobytes() + ls_q.tobytes() + rgba.tobytes() + rot.tobytes()
    return head + body, n


def decode_live_splat(data: bytes) -> dict:
    """Lector del binario "VGS1" (pruebas y diagnóstico)."""
    if len(data) < HEADER.size or data[:4] != SPLAT_MAGIC:
        raise ValueError("no es un binario VGS1")
    _m, version, n, *rest = HEADER.unpack_from(data)
    lo, hi, lmin, lmax = np.array(rest[0:3]), np.array(rest[3:6]), rest[6], rest[7]
    if len(data) < HEADER.size + 17 * n:
        raise ValueError("binario VGS1 incompleto")
    off = HEADER.size
    pos_q = np.frombuffer(data, dtype="<u2", count=n * 3, offset=off).reshape(n, 3)
    off += n * 6
    ls_q = np.frombuffer(data, dtype=np.uint8, count=n * 3, offset=off).reshape(n, 3)
    off += n * 3
    rgba = np.frombuffer(data, dtype=np.uint8, count=n * 4, offset=off).reshape(n, 4)
    off += n * 4
    rot = np.frombuffer(data, dtype=np.uint8, count=n * 4, offset=off).reshape(n, 4)
    return {
        "version": version,
        "position": lo + pos_q.astype(np.float64) / 65535.0 * (hi - lo),
        "log_scale": lmin + ls_q.astype(np.float64) / 255.0 * (lmax - lmin),
        "rgba": rgba.copy(),
        "rot_wxyz": (rot.astype(np.float64) - 128.0) / 128.0,
    }


# ---------------------------------------------------------------------------
# Inicialización desde la nube
# ---------------------------------------------------------------------------


def init_from_points(xyz: np.ndarray, rgb: np.ndarray, fallback_scale: float, seed: int = 0) -> dict[str, np.ndarray]:
    """Gaussianas isótropas desde puntos: tamaño = distancia media a los 3 vecinos más cercanos
    (acotada alrededor de la mediana), color del punto, opacidad INIT_OPACITY."""
    xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
    rgb = np.asarray(rgb, dtype=np.uint8).reshape(-1, 3)
    if len(xyz) > GS_PER_CHUNK:
        pick = np.random.default_rng(seed).choice(len(xyz), size=GS_PER_CHUNK, replace=False)
        xyz, rgb = xyz[pick], rgb[pick]
    n = len(xyz)
    if n >= 8:
        from scipy.spatial import cKDTree

        d, _ = cKDTree(xyz).query(xyz, k=4)
        dist = np.sqrt(np.maximum((d[:, 1:] ** 2).mean(axis=1), 1e-18))
        med = float(np.median(dist))
        dist = np.clip(dist, 0.3 * med, 3.0 * med)
    else:
        dist = np.full(n, max(fallback_scale, 1e-9))
    return {
        "means": xyz.astype(np.float32),
        "scales": np.log(dist)[:, None].repeat(3, axis=1).astype(np.float32),
        "quats": np.tile(np.array([1.0, 0.0, 0.0, 0.0], np.float32), (n, 1)),
        "opacities": np.full(n, math.log(INIT_OPACITY / (1.0 - INIT_OPACITY)), np.float32),
        "sh0": ((rgb.astype(np.float32) / 255.0 - 0.5) / SH_C0).reshape(n, 1, 3),
    }


# ---------------------------------------------------------------------------
# Entrenadores
# ---------------------------------------------------------------------------


class _Base:
    engine = "base"

    def __init__(self, log: Callable[[str], None] = print):
        self.log = log
        self.last_view_index = -1
        self.n_chunks = 0
        self.steps = 0
        self.psnr: float | None = None
        self.scene_scale: float | None = None

    @property
    def count(self) -> int:
        raise NotImplementedError

    @property
    def n_views(self) -> int:
        raise NotImplementedError

    def sync(self, views: Sequence[View], chunks: Sequence[tuple[np.ndarray, np.ndarray]], voxel: float | None) -> None:
        """Toma las vistas con índice nuevo y los trozos `chunks` (los que siguen a los ya vistos)."""
        if self.scene_scale is None and voxel:
            from .live3d import VOXEL_FRAC

            self.scene_scale = float(voxel) / VOXEL_FRAC
        fresh = [v for v in views if v.index > self.last_view_index]
        if fresh:
            self.last_view_index = max(v.index for v in fresh)
            self._add_views(fresh)
        for xyz, rgb in chunks:
            if len(xyz):
                g = init_from_points(xyz, rgb, (voxel or 1e-3) * 2.0, seed=self.n_chunks)
                self._add_gaussians(g)
            self.n_chunks += 1

    def _add_views(self, views: list[View]) -> None:
        raise NotImplementedError

    def _add_gaussians(self, g: dict[str, np.ndarray]) -> None:
        raise NotImplementedError

    def train(self, seconds: float) -> int:
        raise NotImplementedError

    def arrays(self) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """(means, log_scales, quats_wxyz, sh0 (N,3), opacity_logits) en numpy."""
        raise NotImplementedError


def gsplat_rasterize(means, quats, scales, opacities, colors, viewmats, Ks, width, height):
    """gsplat.rasterization con armónicos de grado 0 → (rgb (1,h,w,3), alpha (1,h,w,1))."""
    from gsplat import rasterization

    rgb, alpha, _info = rasterization(
        means=means,
        quats=quats,
        scales=scales,
        opacities=opacities,
        colors=colors,
        viewmats=viewmats,
        Ks=Ks,
        width=width,
        height=height,
        sh_degree=0,
        packed=False,
        render_mode="RGB",
    )
    return rgb, alpha


class LiveSplatTrainer(_Base):
    """3DGS incremental con torch. `rasterize` se inyecta en las pruebas (CPU); por defecto gsplat."""

    engine = "gsplat"

    def __init__(self, device=None, log: Callable[[str], None] = print, rasterize=None, ssim=None, seed: int = 0):
        super().__init__(log)
        import torch

        self.torch = torch
        self.device = torch.device(device or "cuda")
        self.rasterize = rasterize or gsplat_rasterize
        if ssim is None and rasterize is None:
            try:
                from gsplat.losses import ssim_loss

                ssim = ssim_loss
            except Exception as err:  # noqa: BLE001 - sin SSIM se entrena solo con L1
                log(f"[live3d] gsplat sin ssim_loss ({err}); se entrena solo con L1")
        self.ssim = ssim
        self.rng = np.random.default_rng(seed)
        self.params: dict[str, torch.nn.Parameter] = {}
        self.opts: dict[str, torch.optim.Optimizer] = {}
        # Vistas en la GPU: (índice, imagen uint8 (h,w,3), máscara bool (h,w,1), viewmat (4,4), K (3,3)).
        self.views: list[tuple] = []

    @property
    def count(self) -> int:
        return 0 if not self.params else int(self.params["means"].shape[0])

    @property
    def n_views(self) -> int:
        return len(self.views)

    # -- datos ----------------------------------------------------------------

    def _add_views(self, views: list[View]) -> None:
        torch = self.torch
        for v in views:
            img = torch.from_numpy(np.ascontiguousarray(v.image)).to(self.device)
            mask = torch.from_numpy(np.ascontiguousarray(v.mask)).to(self.device)[..., None]
            viewmat = torch.tensor(np.linalg.inv(v.c2w), dtype=torch.float32, device=self.device)
            k = torch.tensor(v.K, dtype=torch.float32, device=self.device)
            self.views.append((v.index, img, mask, viewmat, k))
        while len(self.views) > MAX_TRAIN_VIEWS:
            # Se ralea la mitad más antigua (uno de cada dos); las recientes quedan todas.
            half = len(self.views) // 2
            self.views = self.views[:half:2] + self.views[half:]

    def _edit(self, fn_param: Callable, fn_state: Callable) -> None:
        """Reemplaza cada parámetro y su estado de Adam (exp_avg, exp_avg_sq) con la misma operación."""
        torch = self.torch
        for name, p in list(self.params.items()):
            opt = self.opts[name]
            new = torch.nn.Parameter(fn_param(name, p.detach()))
            st = opt.state.pop(p, None)
            opt.param_groups[0]["params"] = [new]
            if st:
                opt.state[new] = {
                    k: (fn_state(name, v) if torch.is_tensor(v) and v.ndim > 0 and v.shape[0] == p.shape[0] else v)
                    for k, v in st.items()
                }
            self.params[name] = new

    def _add_gaussians(self, g: dict[str, np.ndarray]) -> None:
        torch = self.torch
        n_new = len(g["means"])
        if n_new == 0:
            return
        if self.params and self.count + n_new > GS_MAX:
            self._prune_to(max(0, GS_MAX - n_new))
        new = {k: torch.from_numpy(np.ascontiguousarray(v)).float().to(self.device) for k, v in g.items()}
        if not self.params:
            scale = self.scene_scale or 1.0
            lrs = {
                "means": LR_MEANS * scale,
                "scales": LR_SCALES,
                "quats": LR_QUATS,
                "opacities": LR_OPACITIES,
                "sh0": LR_COLORS,
            }
            fused = self.device.type == "cuda"
            for k, lr in lrs.items():
                p = torch.nn.Parameter(new[k])
                self.params[k] = p
                self.opts[k] = torch.optim.Adam([{"params": [p], "lr": lr, "name": k}], eps=1e-15, fused=fused)
            return
        self._edit(
            lambda k, x: torch.cat([x, new[k]]),
            lambda k, s: torch.cat([s, torch.zeros((n_new, *s.shape[1:]), dtype=s.dtype, device=s.device)]),
        )

    def _prune_to(self, keep_n: int) -> None:
        """Quita las más transparentes hasta quedar en `keep_n` (y todas bajo PRUNE_OPACITY)."""
        torch = self.torch
        with torch.no_grad():
            op = self.params["opacities"].detach()
            keep = torch.sigmoid(op) >= PRUNE_OPACITY
            if int(keep.sum()) > keep_n:
                thr = torch.topk(op[keep], keep_n, largest=True).values.min() if keep_n > 0 else math.inf
                keep &= op >= thr
            idx = torch.nonzero(keep, as_tuple=False)[:, 0]
        if len(idx) == self.count:
            return
        self._edit(lambda _k, x: x[idx], lambda _k, s: s[idx])

    # -- entrenamiento --------------------------------------------------------

    def _pick(self) -> tuple:
        n = len(self.views)
        if n > RECENT_VIEWS and self.rng.random() < RECENT_SHARE:
            return self.views[n - 1 - int(self.rng.integers(RECENT_VIEWS))]
        return self.views[int(self.rng.integers(n))]

    def train(self, seconds: float) -> int:
        torch = self.torch
        if not self.params or not self.views or self.count == 0:
            return 0
        p = self.params
        scale = self.scene_scale or 1.0
        max_log = math.log(max(scale * MAX_SCALE_FRAC, 1e-12))
        min_log = math.log(max(scale * 1e-6, 1e-15))
        t_end = time.perf_counter() + seconds
        done = 0
        while done == 0 or time.perf_counter() < t_end:
            _i, img, mask, viewmat, k = self._pick()
            h, w = img.shape[:2]
            rgb, _alpha = self.rasterize(
                p["means"],
                p["quats"],
                torch.exp(p["scales"]),
                torch.sigmoid(p["opacities"]),
                p["sh0"],
                viewmat[None],
                k[None],
                w,
                h,
            )
            gt = img[None].float() / 255.0
            m = mask[None]
            # Fuera de la máscara el objetivo es lo propio renderizado: sin gradiente ahí.
            target = torch.where(m, gt, rgb.detach())
            l1 = (rgb - target).abs().mean()
            if self.ssim is not None:
                ss = self.ssim(rgb.permute(0, 3, 1, 2), target.permute(0, 3, 1, 2))
                loss = (1.0 - SSIM_WEIGHT) * l1 + SSIM_WEIGHT * ss
            else:
                loss = l1
            loss.backward()
            for opt in self.opts.values():
                opt.step()
                opt.zero_grad(set_to_none=True)
            with torch.no_grad():
                p["scales"].clamp_(min_log, max_log)
                mf = m.float()
                mse = float((((rgb.clamp(0, 1) - gt) ** 2) * mf).sum() / (mf.sum() * 3.0).clamp_min(1.0))
            psnr = -10.0 * math.log10(max(mse, 1e-10))
            self.psnr = psnr if self.psnr is None else 0.95 * self.psnr + 0.05 * psnr
            done += 1
            self.steps += 1
        return done

    def arrays(self):
        with self.torch.no_grad():
            p = self.params
            if not p:
                z = np.zeros((0, 3), np.float32)
                return z, z, np.zeros((0, 4), np.float32), z, np.zeros(0, np.float32)
            return (
                p["means"].detach().cpu().numpy(),
                p["scales"].detach().cpu().numpy(),
                p["quats"].detach().cpu().numpy(),
                p["sh0"].detach()[:, 0, :].cpu().numpy(),
                p["opacities"].detach().cpu().numpy(),
            )
