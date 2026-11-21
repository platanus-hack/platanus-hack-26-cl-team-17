"""Escritor del formato .splat de antimatter15 (32 bytes por gaussiana, little-endian):

  0..11   posición           float32 × 3
  12..23  escala lineal      float32 × 3   (exp de la escala logarítmica)
  24..27  color RGBA         uint8 × 4     (RGB = 0,5 + C0·SH0; A = sigmoide(opacidad))
  28..31  rotación           uint8 × 4     orden w, x, y, z, codificada como q·128 + 128

Las gaussianas van ordenadas por importancia (volumen × opacidad, de mayor a menor), así un
visor que carga de a poco muestra primero lo que más pesa, y el tope se aplica cortando la cola.
"""

from __future__ import annotations

import numpy as np

SPLAT_BYTES = 32
SH_C0 = 0.28209479177387814
# Tope razonable para un navegador (≈ 48 MB).
DEFAULT_MAX_GAUSSIANS = 1_500_000

SPLAT_DTYPE = np.dtype(
    [
        ("position", "<f4", (3,)),
        ("scale", "<f4", (3,)),
        ("rgba", "u1", (4,)),
        ("rot", "u1", (4,)),
    ]
)
assert SPLAT_DTYPE.itemsize == SPLAT_BYTES


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def importance(log_scales: np.ndarray, opacity_logits: np.ndarray) -> np.ndarray:
    """Volumen × opacidad, el mismo criterio que usa el convertidor de antimatter15."""
    return np.exp(np.clip(log_scales.sum(axis=1), -60.0, 60.0)) * _sigmoid(opacity_logits)


def encode_splat(
    means: np.ndarray,
    log_scales: np.ndarray,
    quats_wxyz: np.ndarray,
    sh0: np.ndarray,
    opacity_logits: np.ndarray,
    max_gaussians: int = DEFAULT_MAX_GAUSSIANS,
    min_opacity: float = 1.0 / 255.0,
) -> tuple[bytes, int]:
    """→ (bytes del archivo, cantidad de gaussianas escritas).

    means (N,3), log_scales (N,3), quats_wxyz (N,4) sin normalizar, sh0 (N,3) coeficiente DC,
    opacity_logits (N,).
    """
    means = np.asarray(means, dtype=np.float64).reshape(-1, 3)
    log_scales = np.asarray(log_scales, dtype=np.float64).reshape(-1, 3)
    quats = np.asarray(quats_wxyz, dtype=np.float64).reshape(-1, 4)
    sh0 = np.asarray(sh0, dtype=np.float64).reshape(-1, 3)
    opacity_logits = np.asarray(opacity_logits, dtype=np.float64).reshape(-1)
    n = means.shape[0]
    if not (log_scales.shape[0] == quats.shape[0] == sh0.shape[0] == opacity_logits.shape[0] == n):
        raise ValueError("encode_splat: los arreglos no tienen la misma cantidad de gaussianas")

    qnorm = np.linalg.norm(quats, axis=1)
    alpha = _sigmoid(opacity_logits)
    finite = (
        np.isfinite(means).all(axis=1)
        & np.isfinite(log_scales).all(axis=1)
        & np.isfinite(quats).all(axis=1)
        & np.isfinite(sh0).all(axis=1)
        & np.isfinite(opacity_logits)
        & (qnorm > 1e-12)
        & (alpha >= min_opacity)
    )
    idx = np.nonzero(finite)[0]
    order = np.argsort(-importance(log_scales[idx], opacity_logits[idx]), kind="stable")
    idx = idx[order[: max(0, int(max_gaussians))]]

    out = np.zeros(len(idx), dtype=SPLAT_DTYPE)
    out["position"] = means[idx].astype(np.float32)
    out["scale"] = np.exp(np.clip(log_scales[idx], -30.0, 30.0)).astype(np.float32)
    rgb = np.clip(0.5 + SH_C0 * sh0[idx], 0.0, 1.0)
    out["rgba"][:, :3] = np.round(rgb * 255.0).astype(np.uint8)
    out["rgba"][:, 3] = np.round(np.clip(alpha[idx], 0.0, 1.0) * 255.0).astype(np.uint8)
    q = quats[idx] / qnorm[idx, None]
    out["rot"] = np.clip(np.round(q * 128.0 + 128.0), 0, 255).astype(np.uint8)
    return out.tobytes(), len(idx)


def decode_splat(data: bytes) -> dict[str, np.ndarray]:
    """Lector (para pruebas y diagnóstico)."""
    if len(data) % SPLAT_BYTES != 0:
        raise ValueError("decode_splat: el tamaño no es múltiplo de 32 bytes")
    arr = np.frombuffer(data, dtype=SPLAT_DTYPE)
    rot = (arr["rot"].astype(np.float64) - 128.0) / 128.0
    return {
        "position": arr["position"].astype(np.float64),
        "scale": arr["scale"].astype(np.float64),
        "rgba": arr["rgba"].copy(),
        "rot_wxyz": rot,
    }
