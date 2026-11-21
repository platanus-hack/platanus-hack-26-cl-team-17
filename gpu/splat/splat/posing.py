"""Estimación de cámaras y profundidad con VGGT (feed-forward, sin COLMAP).

VGGT (Wang et al., CVPR 2025) predice en una pasada las cámaras (extrínsecas OpenCV mundo→cámara
e intrínsecas) y un mapa de profundidad con confianza por cuadro. El mundo es el sistema de la
primera cámara, con escala arbitraria.

Se corre una pasada por grupo (cada video o set de fotos por separado): mezclar videos que
comparten poco en una sola pasada deja cada video en otro lugar y otra escala. La unión entre
grupos y el ajuste fino de cámaras los hace `register.py`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Sequence

import cv2
import numpy as np
import torch

from .depthmap import FrameDepth

VGGT_SIZE = 518
PATCH = 14
# Umbral de confianza de profundidad que usa demo_colmap.py de VGGT sin bundle adjustment.
CONF_THRESHOLD = 5.0
# Un cuadro cuenta como registrado si al menos esta fracción de su imagen es confiable.
MIN_CONFIDENT_FRACTION = 0.10


@dataclass(frozen=True)
class GroupPose:
    """Resultado de VGGT para un grupo de cuadros (un video o un set de fotos), en su propio
    sistema: el de su primera cámara, con escala arbitraria."""

    c2w: np.ndarray  # (N,4,4) cámara→mundo, OpenCV
    Ks: np.ndarray  # (N,3,3) en la resolución de cada imagen de entrenamiento
    depths: list[FrameDepth]
    confident_fraction: np.ndarray  # (N,)
    registered: np.ndarray  # (N,) bool
    conf_threshold: float


@dataclass(frozen=True)
class CanvasSlot:
    width: int
    height: int
    pad_left: int
    pad_top: int


def vggt_frame_cap(total_vram_bytes: int) -> int:
    """Cuadros que caben en VGGT a 518 px (≈0,2 GB por cuadro + ~8 GB fijos; tabla del README)."""
    gb = total_vram_bytes / 1e9
    return max(8, int((gb - 8.0) / 0.21))


def canvas_layout(sizes: Sequence[tuple[int, int]]) -> tuple[int, int, list[CanvasSlot]]:
    """Lado largo a 518 y lados múltiplos de 14 (modo "pad" de VGGT); todas las imágenes se
    centran en un lienzo común, así se mezclan videos verticales y horizontales."""
    dims: list[tuple[int, int]] = []
    for w, h in sizes:
        if w >= h:
            nw, nh = VGGT_SIZE, max(PATCH, round(h * (VGGT_SIZE / w) / PATCH) * PATCH)
        else:
            nh, nw = VGGT_SIZE, max(PATCH, round(w * (VGGT_SIZE / h) / PATCH) * PATCH)
        dims.append((nw, nh))
    cw = max(d[0] for d in dims)
    ch = max(d[1] for d in dims)
    slots = [CanvasSlot(nw, nh, (cw - nw) // 2, (ch - nh) // 2) for nw, nh in dims]
    return cw, ch, slots


def load_vggt(weights_path: str, device: torch.device) -> torch.nn.Module:
    from safetensors.torch import load_file
    from vggt.models.vggt import VGGT

    model = VGGT(enable_point=False, enable_track=False)
    state = load_file(weights_path)
    missing, _unexpected = model.load_state_dict(state, strict=False)
    if missing:
        raise RuntimeError(f"Pesos de VGGT incompletos: faltan {len(missing)} tensores")
    return model.to(device).eval()


def estimate_group(
    model: torch.nn.Module,
    images: Sequence[np.ndarray],
    device: torch.device,
    seed: int = 0,
) -> GroupPose:
    """`images`: RGB uint8 (H,W,3) en la resolución de entrenamiento (pueden tener tamaños distintos)."""
    from vggt.utils.pose_enc import pose_encoding_to_extri_intri

    n = len(images)
    sizes = [(im.shape[1], im.shape[0]) for im in images]
    cw, ch, slots = canvas_layout(sizes)
    canvas = np.ones((n, ch, cw, 3), dtype=np.float32)
    for k, (im, s) in enumerate(zip(images, slots)):
        small = cv2.resize(im, (s.width, s.height), interpolation=cv2.INTER_AREA)
        canvas[k, s.pad_top : s.pad_top + s.height, s.pad_left : s.pad_left + s.width] = small / 255.0

    batch = torch.from_numpy(canvas).permute(0, 3, 1, 2).contiguous().to(device)
    with torch.no_grad():
        with torch.autocast("cuda", dtype=torch.bfloat16):
            preds = model(batch)
        extr, intr = pose_encoding_to_extri_intri(preds["pose_enc"], batch.shape[-2:])
    depth = preds["depth"][0, ..., 0].float()  # (N,H,W)
    conf = preds["depth_conf"][0].float()  # (N,H,W)
    extr = extr[0].double().cpu().numpy()  # (N,3,4) mundo→cámara
    intr = intr[0].double().cpu().numpy()  # (N,3,3) en el lienzo
    del preds, batch
    torch.cuda.empty_cache()

    valid = torch.zeros((n, ch, cw), dtype=torch.bool, device=device)
    for k, s in enumerate(slots):
        valid[k, s.pad_top : s.pad_top + s.height, s.pad_left : s.pad_left + s.width] = True
    valid &= torch.isfinite(depth) & (depth > 0) & torch.isfinite(conf)

    gen = torch.Generator(device=device).manual_seed(seed)
    conf_valid = conf[valid]
    sample = conf_valid[torch.randint(0, max(1, conf_valid.numel()), (min(conf_valid.numel(), 1_000_000),), device=device, generator=gen)]
    median_conf = float(sample.median()) if sample.numel() else 0.0
    # Con escenas difíciles la confianza baja en todo: se garantiza al menos la mitad de los píxeles.
    thr = min(CONF_THRESHOLD, median_conf)
    confident = valid & (conf >= thr)
    frac = (confident.flatten(1).sum(1).double() / valid.flatten(1).sum(1).clamp(min=1).double()).cpu().numpy()
    registered = frac >= MIN_CONFIDENT_FRACTION
    depth_np = depth.cpu().numpy()
    confident_np = confident.cpu().numpy()
    del depth, conf, valid, confident
    torch.cuda.empty_cache()

    c2w = np.tile(np.eye(4), (n, 1, 1))
    rot_c2w = np.transpose(extr[:, :3, :3], (0, 2, 1))
    c2w[:, :3, :3] = rot_c2w
    c2w[:, :3, 3] = -(rot_c2w @ extr[:, :3, 3, None])[..., 0]

    # Intrínsecas del lienzo → área útil de cada cuadro → resolución de entrenamiento.
    ks = np.zeros((n, 3, 3))
    depths: list[FrameDepth] = []
    for k, ((w, h), s) in enumerate(zip(sizes, slots)):
        k_small = intr[k].copy()
        k_small[0, 2] -= s.pad_left
        k_small[1, 2] -= s.pad_top
        sx = w / s.width
        sy = h / s.height
        ks[k] = np.diag([sx, sy, 1.0]) @ k_small
        crop = (slice(s.pad_top, s.pad_top + s.height), slice(s.pad_left, s.pad_left + s.width))
        depths.append(
            FrameDepth(
                depth=np.ascontiguousarray(depth_np[k][crop], dtype=np.float32),
                confident=np.ascontiguousarray(confident_np[k][crop]),
                K_small=k_small,
                sx=sx,
                sy=sy,
            )
        )
    if not math.isfinite(float(np.abs(ks).sum())) or not np.isfinite(c2w).all():
        raise RuntimeError("VGGT devolvió cámaras no finitas")
    return GroupPose(
        c2w=c2w,
        Ks=ks,
        depths=depths,
        confident_fraction=frac,
        registered=registered,
        conf_threshold=thr,
    )


def estimate_poses(
    images: Sequence[np.ndarray],
    groups: Sequence[Sequence[int]],
    weights_path: str,
    device: torch.device,
    log: Callable[[str], None] = print,
) -> list[GroupPose]:
    """Una pasada de VGGT por grupo (índices sobre `images`); el modelo se carga una sola vez."""
    model = load_vggt(weights_path, device)
    out: list[GroupPose] = []
    try:
        for g, idx in enumerate(groups):
            out.append(estimate_group(model, [images[i] for i in idx], device, seed=g))
            gp = out[-1]
            log(f"VGGT grupo {g}: {int(gp.registered.sum())}/{len(idx)} cuadros confiables (umbral {gp.conf_threshold:.2f})")
    finally:
        del model
        torch.cuda.empty_cache()
    return out
