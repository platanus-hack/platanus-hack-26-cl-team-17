"""Limpieza para que una escena hecha con material malo igual se pueda mostrar.

- Nube inicial: fuera los puntos aislados (profundidad de VGGT ruidosa en bordes y cielo).
- Exportación: fuera las gaussianas lejos de la escena (fondo, cielo, flotantes detrás de las
  cámaras) o desmesuradas, que en el visor se ven como niebla o manchas que tapan todo.
"""

from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

# Puntos aislados: distancia media a los k vecinos sobre la mediana + n·sigma (sigma robusta, MAD).
OUTLIER_NEIGHBORS = 8
OUTLIER_SIGMAS = 3.0
# Caja de la escena: percentiles de la nube de referencia y las cámaras, agrandada este margen.
BOX_PERCENTILE = 2.0
BOX_MARGIN = 0.25
# Una gaussiana con el eje mayor sobre esta fracción de la diagonal de la caja se descarta.
MAX_SCALE_FRACTION = 0.08


def remove_outliers(
    points: np.ndarray, colors: np.ndarray, k: int = OUTLIER_NEIGHBORS, sigmas: float = OUTLIER_SIGMAS
) -> tuple[np.ndarray, np.ndarray]:
    if len(points) <= k + 1:
        return points, colors
    dists, _ = cKDTree(points).query(points, k=k + 1, workers=-1)
    mean_d = dists[:, 1:].mean(axis=1)
    med = float(np.median(mean_d))
    sigma = float(np.median(np.abs(mean_d - med))) * 1.4826
    keep = mean_d <= med + sigmas * max(sigma, 1e-12)
    return points[keep], colors[keep]


def scene_box(ref_points: np.ndarray, cam_centers: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Caja robusta (min, max) que contiene la escena vista y las cámaras."""
    pts = ref_points if len(ref_points) else cam_centers
    lo = np.percentile(pts, BOX_PERCENTILE, axis=0)
    hi = np.percentile(pts, 100.0 - BOX_PERCENTILE, axis=0)
    lo = np.minimum(lo, cam_centers.min(axis=0))
    hi = np.maximum(hi, cam_centers.max(axis=0))
    pad = (hi - lo) * BOX_MARGIN + 1e-6
    return lo - pad, hi + pad


def export_mask(
    means: np.ndarray,
    log_scales: np.ndarray,
    ref_points: np.ndarray,
    cam_centers: np.ndarray,
) -> np.ndarray:
    """Gaussianas que se exportan: dentro de la caja de la escena y de tamaño razonable."""
    lo, hi = scene_box(ref_points, cam_centers)
    inside = np.all((means >= lo) & (means <= hi), axis=1)
    diag = float(np.linalg.norm(hi - lo))
    big = np.exp(np.clip(log_scales.max(axis=1), -30.0, 30.0)) > MAX_SCALE_FRACTION * diag
    return inside & ~big
