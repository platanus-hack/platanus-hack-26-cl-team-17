"""Dobles de prueba sin GPU para el motor 3D en vivo (no se usan en el servicio)."""

from __future__ import annotations

import math
import time
from typing import Callable, Sequence

import numpy as np

from splat.live3d import Prediction, look_at
from splat.live_gs import GS_MAX, MAX_TRAIN_VIEWS, View, _Base


class FakeEstimator:
    """Imita a VGGT sin GPU: el dron orbita sobre un suelo plano (z=0) con relieve según el brillo
    de la imagen. Devuelve cada ventana en el sistema de su primera cámara y con una escala al azar,
    como VGGT, así se ejercita la alineación entera. Solo para las pruebas."""

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


class FakeSplatTrainer(_Base):
    """Sin torch ni GPU: las gaussianas iniciales tal cual, sin entrenar. Solo para las pruebas."""

    engine = "fake"

    def __init__(self, log: Callable[[str], None] = print):
        super().__init__(log)
        self.g: dict[str, np.ndarray] | None = None
        self.views = 0

    @property
    def count(self) -> int:
        return 0 if self.g is None else len(self.g["means"])

    @property
    def n_views(self) -> int:
        return self.views

    def _add_views(self, views: list[View]) -> None:
        self.views = min(MAX_TRAIN_VIEWS, self.views + len(views))

    def _add_gaussians(self, g: dict[str, np.ndarray]) -> None:
        if self.g is None:
            self.g = {k: v.copy() for k, v in g.items()}
        else:
            self.g = {k: np.concatenate([self.g[k], g[k]]) for k in self.g}
        if self.count > GS_MAX:
            self.g = {k: v[-GS_MAX:] for k, v in self.g.items()}

    def train(self, seconds: float) -> int:
        time.sleep(min(seconds, 0.05))
        if self.count == 0:
            return 0
        self.steps += 5
        self.psnr = 18.0 + 6.0 * (1.0 - math.exp(-self.steps / 400.0))
        return 5

    def arrays(self):
        g = self.g
        if g is None:
            z = np.zeros((0, 3), np.float32)
            return z, z, np.zeros((0, 4), np.float32), z, np.zeros(0, np.float32)
        return g["means"], g["scales"], g["quats"], g["sh0"][:, 0, :], g["opacities"] + 2.0
