"""Entrenamiento 3D Gaussian Splatting con gsplat (rasterizador CUDA + DefaultStrategy).

Sigue a examples/simple_trainer.py de gsplat: mismas tasas de aprendizaje, pérdida
0,8·L1 + 0,2·(1−SSIM), armónicos esféricos hasta grado 3 y densificación del paper original.
Agrega un ajuste fino de cámaras (las de VGGT no pasan por bundle adjustment) y una corrección
de exposición por imagen (teléfonos distintos), que no se exporta.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Callable, Sequence

import numpy as np
import torch
import torch.nn.functional as F
from scipy.spatial import cKDTree

SH_C0 = 0.28209479177387814
SH_DEGREE = 3
SH_INTERVAL = 1000
# Sobre esto se deja de densificar (memoria y tiempo); el archivo final se recorta igual.
GROWTH_CAP = 4_000_000

ProgressFn = Callable[[int, int, int, float], None]


@dataclass(frozen=True)
class TrainedSplats:
    means: np.ndarray
    log_scales: np.ndarray
    quats_wxyz: np.ndarray
    opacity_logits: np.ndarray
    sh0: np.ndarray  # (N,3)
    c2w: np.ndarray  # cámaras afinadas (N_img,4,4)
    psnr: float
    count: int


def rotation_6d_to_matrix(d6: torch.Tensor) -> torch.Tensor:
    a1, a2 = d6[..., :3], d6[..., 3:]
    b1 = F.normalize(a1, dim=-1)
    b2 = F.normalize(a2 - (b1 * a2).sum(-1, keepdim=True) * b1, dim=-1)
    b3 = torch.cross(b1, b2, dim=-1)
    return torch.stack((b1, b2, b3), dim=-2)


class CameraOpt(torch.nn.Module):
    """Delta de pose por imagen (traslación + rotación 6D), inicializado en cero."""

    def __init__(self, n: int, trans_scale: float) -> None:
        super().__init__()
        self.embeds = torch.nn.Embedding(n, 9)
        torch.nn.init.zeros_(self.embeds.weight)
        self.register_buffer("identity", torch.tensor([1.0, 0.0, 0.0, 0.0, 1.0, 0.0]))
        self.trans_scale = trans_scale

    def forward(self, c2w: torch.Tensor, ids: torch.Tensor) -> torch.Tensor:
        d = self.embeds(ids)
        delta = torch.eye(4, device=c2w.device, dtype=c2w.dtype).repeat(len(ids), 1, 1)
        delta[:, :3, :3] = rotation_6d_to_matrix(d[:, 3:] + self.identity)
        delta[:, :3, 3] = d[:, :3] * self.trans_scale
        return c2w @ delta


class ExposureOpt(torch.nn.Module):
    """Ganancia y sesgo RGB por imagen (absorbe diferencias de exposición entre teléfonos)."""

    def __init__(self, n: int) -> None:
        super().__init__()
        self.embeds = torch.nn.Embedding(n, 6)
        torch.nn.init.zeros_(self.embeds.weight)

    def forward(self, rgb: torch.Tensor, ids: torch.Tensor) -> torch.Tensor:
        e = self.embeds(ids)[:, None, None, :]
        return rgb * (1.0 + e[..., :3]) + e[..., 3:]


def scene_scale_of(c2w: np.ndarray, points: np.ndarray) -> float:
    centers = c2w[:, :3, 3]
    mid = centers.mean(axis=0)
    cam_extent = float(np.linalg.norm(centers - mid, axis=1).max()) * 1.1
    pts_extent = float(np.percentile(np.linalg.norm(points - mid, axis=1), 90)) if len(points) else 0.0
    return max(cam_extent, 0.1 * pts_extent, 1e-3)


def init_params(points: np.ndarray, colors: np.ndarray, device: torch.device) -> torch.nn.ParameterDict:
    pts = np.asarray(points, dtype=np.float64)
    dists, _ = cKDTree(pts).query(pts, k=min(4, len(pts)))
    nn = dists[:, 1:] if dists.ndim == 2 and dists.shape[1] > 1 else np.full((len(pts), 1), 0.01)
    dist = np.sqrt(np.maximum((nn**2).mean(axis=1), 1e-14))
    n = len(pts)
    log_scales = np.log(dist)[:, None].repeat(3, axis=1)
    sh = np.zeros((n, (SH_DEGREE + 1) ** 2, 3), dtype=np.float32)
    sh[:, 0, :] = (np.clip(colors, 0, 1) - 0.5) / SH_C0
    return torch.nn.ParameterDict(
        {
            "means": torch.nn.Parameter(torch.tensor(pts, dtype=torch.float32)),
            "scales": torch.nn.Parameter(torch.tensor(log_scales, dtype=torch.float32)),
            "quats": torch.nn.Parameter(torch.rand((n, 4))),
            "opacities": torch.nn.Parameter(torch.logit(torch.full((n,), 0.1))),
            "sh0": torch.nn.Parameter(torch.tensor(sh[:, :1, :])),
            "shN": torch.nn.Parameter(torch.tensor(sh[:, 1:, :])),
        }
    ).to(device)


def render(
    params: torch.nn.ParameterDict,
    c2w: torch.Tensor,
    K: torch.Tensor,
    width: int,
    height: int,
    sh_degree: int,
) -> tuple[torch.Tensor, torch.Tensor, dict]:
    from gsplat import rasterization

    colors = torch.cat([params["sh0"], params["shN"]], 1)
    return rasterization(
        means=params["means"],
        quats=params["quats"],
        scales=torch.exp(params["scales"]),
        opacities=torch.sigmoid(params["opacities"]),
        colors=colors,
        viewmats=torch.linalg.inv(c2w),
        Ks=K,
        width=width,
        height=height,
        sh_degree=sh_degree,
        packed=False,
        absgrad=False,
        render_mode="RGB",
    )


def train_splats(
    images: Sequence[np.ndarray],
    c2w: np.ndarray,
    Ks: np.ndarray,
    points: np.ndarray,
    colors: np.ndarray,
    iterations: int,
    device: torch.device,
    progress: ProgressFn,
    log: Callable[[str], None] = print,
    seed: int = 0,
) -> tuple[TrainedSplats, torch.nn.ParameterDict]:
    """→ (resultado en numpy, parámetros en la GPU para renderizar la vista previa)."""
    from gsplat.losses import ssim_loss
    from gsplat.strategy import DefaultStrategy

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    n_img = len(images)
    gts = [torch.from_numpy(np.ascontiguousarray(im)).to(device) for im in images]
    c2w_t = torch.tensor(c2w, dtype=torch.float32, device=device)
    ks_t = torch.tensor(Ks, dtype=torch.float32, device=device)
    scene_scale = scene_scale_of(c2w, points)
    log(f"gsplat: {len(points)} puntos iniciales, {n_img} imágenes, escala de escena {scene_scale:.2f}")

    params = init_params(points, colors, device)
    lrs = {
        "means": 1.6e-4 * scene_scale,
        "scales": 5e-3,
        "quats": 1e-3,
        "opacities": 5e-2,
        "sh0": 2.5e-3,
        "shN": 2.5e-3 / 20,
    }
    optimizers = {
        k: torch.optim.Adam([{"params": params[k], "lr": lr, "name": k}], eps=1e-15, fused=True)
        for k, lr in lrs.items()
    }
    schedulers = [torch.optim.lr_scheduler.ExponentialLR(optimizers["means"], gamma=0.01 ** (1.0 / iterations))]
    strategy = DefaultStrategy(
        refine_start_iter=min(500, iterations // 10),
        refine_stop_iter=int(iterations * 0.5),
        reset_every=3000,
        refine_every=100,
    )
    strategy.check_sanity(params, optimizers)
    state = strategy.initialize_state(scene_scale=scene_scale)

    cam_opt = CameraOpt(n_img, scene_scale).to(device)
    cam_optim = torch.optim.Adam(cam_opt.parameters(), lr=1e-5, weight_decay=1e-6)
    schedulers.append(torch.optim.lr_scheduler.ExponentialLR(cam_optim, gamma=0.01 ** (1.0 / iterations)))
    exp_opt = ExposureOpt(n_img).to(device)
    exp_optim = torch.optim.Adam(exp_opt.parameters(), lr=1e-3)

    order: list[int] = []
    psnr_ema = 0.0
    for step in range(iterations):
        if not order:
            order = list(range(n_img))
            random.shuffle(order)
        i = order.pop()
        ids = torch.tensor([i], device=device)
        gt = gts[i].float()[None] / 255.0
        h, w = gt.shape[1:3]
        cam = cam_opt(c2w_t[i : i + 1], ids)
        sh_degree = min(step // SH_INTERVAL, SH_DEGREE)
        rgb, _alpha, info = render(params, cam, ks_t[i : i + 1], w, h, sh_degree)
        strategy.step_pre_backward(params, optimizers, state, step, info)
        pred = exp_opt(rgb, ids)
        l1 = (pred - gt).abs().mean()
        ssim = ssim_loss(pred.permute(0, 3, 1, 2), gt.permute(0, 3, 1, 2))
        loss = torch.lerp(l1, ssim, 0.2) + 1e-3 * exp_opt.embeds(ids).pow(2).mean()
        loss.backward()

        for opt in (*optimizers.values(), cam_optim, exp_optim):
            opt.step()
            opt.zero_grad(set_to_none=True)
        for sched in schedulers:
            sched.step()
        strategy.step_post_backward(params, optimizers, state, step, info, packed=False)
        if len(params["means"]) > GROWTH_CAP and strategy.refine_stop_iter > step:
            log(f"gsplat: tope de {GROWTH_CAP} gaussianas alcanzado en el paso {step}; se detiene la densificación")
            strategy.refine_stop_iter = step

        with torch.no_grad():
            mse = float(((pred.clamp(0, 1) - gt) ** 2).mean())
        psnr = -10.0 * math.log10(max(mse, 1e-10))
        psnr_ema = psnr if step == 0 else 0.98 * psnr_ema + 0.02 * psnr
        progress(step + 1, iterations, len(params["means"]), psnr_ema)

    with torch.no_grad():
        ids_all = torch.arange(n_img, device=device)
        refined = cam_opt(c2w_t, ids_all).double().cpu().numpy()
        out = TrainedSplats(
            means=params["means"].detach().cpu().numpy(),
            log_scales=params["scales"].detach().cpu().numpy(),
            quats_wxyz=params["quats"].detach().cpu().numpy(),
            opacity_logits=params["opacities"].detach().cpu().numpy(),
            sh0=params["sh0"].detach()[:, 0, :].cpu().numpy(),
            c2w=refined,
            psnr=psnr_ema,
            count=len(params["means"]),
        )
    return out, params


def render_view(
    params: torch.nn.ParameterDict, c2w: np.ndarray, K: np.ndarray, width: int, height: int, device: torch.device
) -> np.ndarray:
    """Imagen RGB uint8 de la escena entrenada vista desde una cámara."""
    with torch.no_grad():
        cam = torch.tensor(c2w, dtype=torch.float32, device=device)[None]
        k = torch.tensor(K, dtype=torch.float32, device=device)[None]
        rgb, _a, _i = render(params, cam, k, width, height, SH_DEGREE)
        return (rgb[0].clamp(0, 1) * 255.0).round().byte().cpu().numpy()


def preview_camera(c2w: np.ndarray) -> int:
    """Cámara más cercana al centro del recorrido: suele ver la escena completa."""
    centers = c2w[:, :3, 3]
    return int(np.argmin(np.linalg.norm(centers - centers.mean(axis=0), axis=1)))
