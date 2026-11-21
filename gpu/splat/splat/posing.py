"""Estimación de cámaras y nube de puntos inicial con VGGT (feed-forward, sin COLMAP).

VGGT (Wang et al., CVPR 2025) predice en una pasada las cámaras (extrínsecas OpenCV mundo→cámara
e intrínsecas) y un mapa de profundidad con confianza por cuadro. El mundo es el sistema de la
primera cámara, con escala arbitraria.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Sequence

import cv2
import numpy as np
import torch

VGGT_SIZE = 518
PATCH = 14
# Umbral de confianza de profundidad que usa demo_colmap.py de VGGT sin bundle adjustment.
CONF_THRESHOLD = 5.0
# Un cuadro cuenta como registrado si al menos esta fracción de su imagen es confiable.
MIN_CONFIDENT_FRACTION = 0.10
MAX_INIT_POINTS = 300_000


@dataclass(frozen=True)
class PoseResult:
    c2w: np.ndarray  # (N,4,4) cámara→mundo, OpenCV
    Ks: np.ndarray  # (N,3,3) en la resolución de cada imagen de entrenamiento
    points: np.ndarray  # (M,3)
    colors: np.ndarray  # (M,3) 0..1
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


def estimate_poses(
    images: Sequence[np.ndarray],
    weights_path: str,
    device: torch.device,
    log: Callable[[str], None] = print,
    max_points: int = MAX_INIT_POINTS,
    seed: int = 0,
) -> PoseResult:
    """`images`: RGB uint8 (H,W,3) en la resolución de entrenamiento (pueden tener tamaños distintos)."""
    from vggt.utils.pose_enc import pose_encoding_to_extri_intri

    n = len(images)
    sizes = [(im.shape[1], im.shape[0]) for im in images]
    cw, ch, slots = canvas_layout(sizes)
    canvas = np.ones((n, ch, cw, 3), dtype=np.float32)
    for k, (im, s) in enumerate(zip(images, slots)):
        small = cv2.resize(im, (s.width, s.height), interpolation=cv2.INTER_AREA)
        canvas[k, s.pad_top : s.pad_top + s.height, s.pad_left : s.pad_left + s.width] = small / 255.0
    log(f"VGGT: {n} cuadros en un lienzo de {cw}×{ch}")

    model = load_vggt(weights_path, device)
    batch = torch.from_numpy(canvas).permute(0, 3, 1, 2).contiguous().to(device)
    with torch.no_grad():
        with torch.autocast("cuda", dtype=torch.bfloat16):
            preds = model(batch)
        extr, intr = pose_encoding_to_extri_intri(preds["pose_enc"], batch.shape[-2:])
    depth = preds["depth"][0, ..., 0].float()  # (N,H,W)
    conf = preds["depth_conf"][0].float()  # (N,H,W)
    extr = extr[0].double()  # (N,3,4) mundo→cámara
    intr = intr[0].double()  # (N,3,3) en el lienzo
    del preds, model
    torch.cuda.empty_cache()

    valid = torch.zeros((n, ch, cw), dtype=torch.bool, device=device)
    for k, s in enumerate(slots):
        valid[k, s.pad_top : s.pad_top + s.height, s.pad_left : s.pad_left + s.width] = True
    finite = torch.isfinite(depth) & (depth > 0) & torch.isfinite(conf)
    valid &= finite

    gen = torch.Generator(device=device).manual_seed(seed)
    conf_valid = conf[valid]
    sample = conf_valid[torch.randint(0, conf_valid.numel(), (min(conf_valid.numel(), 1_000_000),), device=device, generator=gen)]
    median_conf = float(sample.median()) if sample.numel() else 0.0
    # Con escenas difíciles la confianza baja en todo: se garantiza al menos la mitad de los píxeles.
    thr = min(CONF_THRESHOLD, median_conf)
    confident = valid & (conf >= thr)
    frac = (confident.flatten(1).sum(1).double() / valid.flatten(1).sum(1).clamp(min=1).double()).cpu().numpy()
    registered = frac >= MIN_CONFIDENT_FRACTION

    rot = extr[:, :3, :3]
    trans = extr[:, :3, 3]
    rot_c2w = rot.transpose(1, 2)
    centers = -(rot_c2w @ trans[..., None])[..., 0]
    c2w = torch.eye(4, dtype=torch.float64, device=device).repeat(n, 1, 1)
    c2w[:, :3, :3] = rot_c2w
    c2w[:, :3, 3] = centers

    # Nube de puntos: profundidad desproyectada con las cámaras (más precisa que el mapa de puntos).
    vs, us = torch.meshgrid(
        torch.arange(ch, device=device, dtype=torch.float32),
        torch.arange(cw, device=device, dtype=torch.float32),
        indexing="ij",
    )
    pts_list: list[torch.Tensor] = []
    col_list: list[torch.Tensor] = []
    canvas_t = batch.permute(0, 2, 3, 1)  # (N,H,W,3)
    for k in range(n):
        if not registered[k]:
            continue
        m = confident[k]
        d = depth[k][m]
        fx, fy, cx, cy = (float(intr[k, 0, 0]), float(intr[k, 1, 1]), float(intr[k, 0, 2]), float(intr[k, 1, 2]))
        cam = torch.stack(((us[m] - cx) / fx * d, (vs[m] - cy) / fy * d, d), dim=1).double()
        world = cam @ rot_c2w[k].T + centers[k]
        pts_list.append(world.float())
        col_list.append(canvas_t[k][m])
    if pts_list:
        pts = torch.cat(pts_list)
        cols = torch.cat(col_list)
        if pts.shape[0] > max_points:
            pick = torch.randperm(pts.shape[0], device=device, generator=gen)[:max_points]
            pts, cols = pts[pick], cols[pick]
        points = pts.cpu().numpy().astype(np.float64)
        colors = cols.clamp(0, 1).cpu().numpy().astype(np.float64)
    else:
        points = np.zeros((0, 3))
        colors = np.zeros((0, 3))

    # Intrínsecas del lienzo → resolución de entrenamiento de cada imagen.
    intr_np = intr.cpu().numpy()
    ks = np.zeros((n, 3, 3))
    for k, ((w, h), s) in enumerate(zip(sizes, slots)):
        sx = w / s.width
        sy = h / s.height
        ks[k] = [
            [intr_np[k, 0, 0] * sx, 0.0, (intr_np[k, 0, 2] - s.pad_left) * sx],
            [0.0, intr_np[k, 1, 1] * sy, (intr_np[k, 1, 2] - s.pad_top) * sy],
            [0.0, 0.0, 1.0],
        ]
    if not math.isfinite(float(np.abs(ks).sum())):
        raise RuntimeError("VGGT devolvió intrínsecas no finitas")
    del batch, depth, conf, valid, confident, canvas_t
    torch.cuda.empty_cache()
    return PoseResult(
        c2w=c2w.cpu().numpy(),
        Ks=ks,
        points=points,
        colors=colors,
        confident_fraction=frac,
        registered=registered,
        conf_threshold=thr,
    )
