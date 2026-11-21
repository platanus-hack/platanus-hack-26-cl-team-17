"""Mapa de profundidad de VGGT de un cuadro, consultable desde la resolución de entrenamiento.

Solo numpy: lo usan el registro entre videos (profundidad en los puntos clave) y la nube inicial.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class FrameDepth:
    # Profundidad (z de cámara) y máscara de confianza en el área útil del cuadro dentro del
    # lienzo de VGGT (sin el relleno), con sus intrínsecas a esa resolución.
    depth: np.ndarray  # (h,w) float32
    confident: np.ndarray  # (h,w) bool
    K_small: np.ndarray  # (3,3)
    # Resolución de entrenamiento / resolución del mapa.
    sx: float
    sy: float

    def at(self, uv: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Profundidad en píxeles `uv` (M,2) de la imagen de entrenamiento → (z (M,), confiable (M,))."""
        uv = np.asarray(uv, dtype=np.float64).reshape(-1, 2)
        h, w = self.depth.shape
        x = np.round(uv[:, 0] / self.sx).astype(np.int64)
        y = np.round(uv[:, 1] / self.sy).astype(np.int64)
        inside = (x >= 0) & (x < w) & (y >= 0) & (y < h)
        xi = np.clip(x, 0, w - 1)
        yi = np.clip(y, 0, h - 1)
        z = self.depth[yi, xi].astype(np.float64)
        ok = inside & self.confident[yi, xi] & np.isfinite(z) & (z > 0)
        return np.where(ok, z, np.nan), ok

    def cam_points(
        self, image: np.ndarray, max_points: int, rng: np.random.Generator
    ) -> tuple[np.ndarray, np.ndarray]:
        """Píxeles confiables desproyectados en el sistema de la cámara (OpenCV), con el color de
        la imagen de entrenamiento. → (puntos (M,3), colores (M,3) 0..1)."""
        ys, xs = np.nonzero(self.confident)
        if len(xs) > max_points:
            pick = rng.choice(len(xs), size=max_points, replace=False)
            ys, xs = ys[pick], xs[pick]
        z = self.depth[ys, xs].astype(np.float64)
        fx, fy = self.K_small[0, 0], self.K_small[1, 1]
        cx, cy = self.K_small[0, 2], self.K_small[1, 2]
        pts = np.stack(((xs - cx) / fx * z, (ys - cy) / fy * z, z), axis=1)
        ih, iw = image.shape[:2]
        u = np.clip(np.round(xs * self.sx).astype(np.int64), 0, iw - 1)
        v = np.clip(np.round(ys * self.sy).astype(np.int64), 0, ih - 1)
        cols = image[v, u, :3].astype(np.float64) / 255.0
        return pts, cols


def to_world(c2w: np.ndarray, cam_pts: np.ndarray, depth_scale: float) -> np.ndarray:
    """Puntos de cámara (profundidad de VGGT) → mundo, con la escala de profundidad del cuadro."""
    return (cam_pts * depth_scale) @ c2w[:3, :3].T + c2w[:3, 3]
