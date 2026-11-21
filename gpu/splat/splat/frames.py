"""Cuadros de entrada: muestreo de videos con ffmpeg y reparto del cupo entre medios."""

from __future__ import annotations

import json
import math
import os
import subprocess
from dataclasses import dataclass, replace
from typing import Callable, Sequence

import numpy as np

from .manifest import ManifestFrame, ManifestMedia

# Lado largo máximo de los cuadros de entrenamiento (igual que LIMITS.FRAME_LONG_EDGE_PX).
FRAME_LONG_EDGE_PX = 1280
# Tope de candidatos por video: más que esto solo cuesta tiempo de decodificación.
MAX_CANDIDATES_PER_VIDEO = 600
# Un cuadro de video hereda la posición del cuadro con GPS más cercano en el tiempo (dron).
GPS_TIME_TOLERANCE_S = 2.0
# Un cuadro con nitidez bajo esta fracción del percentil 90 de su medio está movido y se descarta,
# salvo que eso deje al medio con menos de la mitad de sus cuadros (entonces queda la mitad más nítida).
BLUR_FRACTION = 0.25


@dataclass(frozen=True)
class FrameCandidate:
    media_index: int
    media_id: str
    source: str
    local_path: str
    t_s: float
    lat: float | None
    lng: float | None
    alt_m: float | None
    heading_deg: float | None
    # True si la posición es del cuadro (dron); False si es la del teléfono para todo el video.
    per_frame_gps: bool
    sharpness: float = 0.0


class VideoSamplingError(RuntimeError):
    pass


def allocate(counts: Sequence[int], total: int) -> list[int]:
    """Reparte `total` cuadros entre medios con `counts` candidatos, en partes iguales;
    lo que un medio no alcanza a usar pasa a los demás."""
    alloc = [0] * len(counts)
    remaining = max(0, total)
    active = [i for i, c in enumerate(counts) if c > 0]
    while remaining > 0 and active:
        share = max(1, remaining // len(active))
        for i in sorted(active, key=lambda j: counts[j] - alloc[j]):
            if remaining <= 0:
                break
            give = min(share, counts[i] - alloc[i], remaining)
            alloc[i] += give
            remaining -= give
        active = [i for i in active if alloc[i] < counts[i]]
    return alloc


def pick_sharpest(scores: Sequence[float], k: int) -> list[int]:
    """Divide la secuencia en `k` tramos contiguos y elige el cuadro más nítido de cada uno:
    cubre todo el recorrido de la cámara sin quedarse con cuadros movidos."""
    n = len(scores)
    if k <= 0 or n == 0:
        return []
    if k >= n:
        return list(range(n))
    picked: list[int] = []
    for j in range(k):
        a = (j * n) // k
        b = ((j + 1) * n) // k
        picked.append(max(range(a, b), key=lambda i: scores[i]))
    return picked


def drop_blurry(cands: Sequence[FrameCandidate], fraction: float = BLUR_FRACTION) -> list[FrameCandidate]:
    if len(cands) < 4:
        return list(cands)
    ref = float(np.percentile([c.sharpness for c in cands], 90))
    sharp = [c for c in cands if c.sharpness >= fraction * ref]
    if len(sharp) * 2 >= len(cands):
        return sharp
    keep = sorted(cands, key=lambda c: -c.sharpness)[: math.ceil(len(cands) / 2)]
    return sorted(keep, key=lambda c: c.t_s)


def plan_frames(
    per_media: Sequence[Sequence[FrameCandidate]], max_frames: int, per_media_cap: int | None = None
) -> list[FrameCandidate]:
    """Elige hasta `max_frames` cuadros repartidos entre medios (en orden de medio y tiempo),
    sin cuadros movidos y con a lo sumo `per_media_cap` por medio."""
    per_media = [drop_blurry(c) for c in per_media]
    counts = [len(c) if per_media_cap is None else min(len(c), per_media_cap) for c in per_media]
    alloc = allocate(counts, max_frames)
    chosen: list[FrameCandidate] = []
    for cands, k in zip(per_media, alloc):
        ordered = sorted(cands, key=lambda c: c.t_s)
        for i in pick_sharpest([c.sharpness for c in ordered], k):
            chosen.append(ordered[i])
    return chosen


def gps_for_time(
    media: ManifestMedia, t_s: float
) -> tuple[float | None, float | None, float | None, float | None, bool]:
    """Posición para un instante del video: la del cuadro de dron más cercano (si está a menos
    de GPS_TIME_TOLERANCE_S) o la única del teléfono. → (lat, lng, alt_m, heading, por_cuadro)."""
    best: ManifestFrame | None = None
    for f in media.frames:
        if f.lat is None or f.lng is None:
            continue
        if best is None or abs(f.t_s - t_s) < abs(best.t_s - t_s):
            best = f
    if best is not None and abs(best.t_s - t_s) <= GPS_TIME_TOLERANCE_S:
        return best.lat, best.lng, best.alt_m, best.heading_deg, True
    return media.lat, media.lng, None, media.heading_deg, False


def frame_candidates(media: ManifestMedia, media_index: int, local_paths: Sequence[str]) -> list[FrameCandidate]:
    """Candidatos a partir de los cuadros ya extraídos (descargados en `local_paths`)."""
    out: list[FrameCandidate] = []
    for f, path in zip(media.frames, local_paths):
        per_frame = f.lat is not None and f.lng is not None
        out.append(
            FrameCandidate(
                media_index=media_index,
                media_id=media.id,
                source=media.source,
                local_path=path,
                t_s=f.t_s,
                lat=f.lat if per_frame else media.lat,
                lng=f.lng if per_frame else media.lng,
                alt_m=f.alt_m if per_frame else None,
                heading_deg=f.heading_deg if f.heading_deg is not None else media.heading_deg,
                per_frame_gps=per_frame,
            )
        )
    return out


def video_candidates(
    media: ManifestMedia, media_index: int, samples: Sequence[tuple[str, float]]
) -> list[FrameCandidate]:
    out: list[FrameCandidate] = []
    for path, t in samples:
        lat, lng, alt, heading, per_frame = gps_for_time(media, t)
        out.append(
            FrameCandidate(
                media_index=media_index,
                media_id=media.id,
                source=media.source,
                local_path=path,
                t_s=t,
                lat=lat,
                lng=lng,
                alt_m=alt,
                heading_deg=heading,
                per_frame_gps=per_frame,
            )
        )
    return out


def probe_duration(video_path: str) -> float | None:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", video_path],
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        ).stdout
        d = float(json.loads(out)["format"]["duration"])
        return d if math.isfinite(d) and d > 0 else None
    except (subprocess.SubprocessError, KeyError, ValueError, OSError):
        return None


def scale_filter(long_edge: int) -> str:
    """Achica (nunca agranda) para que el lado largo no pase de `long_edge`, con lados pares."""
    le = int(long_edge)
    return (
        f"scale=w='if(gte(iw,ih),min(iw,{le}),-2)':h='if(gte(iw,ih),-2,min(ih,{le}))'"
    )


def sample_video(
    video_path: str,
    out_dir: str,
    fps: float,
    long_edge: int = FRAME_LONG_EDGE_PX,
    max_candidates: int = MAX_CANDIDATES_PER_VIDEO,
) -> list[tuple[str, float]]:
    """Extrae cuadros JPEG a `fps` (rotación del teléfono ya aplicada por ffmpeg).
    → [(ruta, segundo)] en orden temporal."""
    os.makedirs(out_dir, exist_ok=True)
    duration = probe_duration(video_path)
    eff_fps = fps
    if duration is not None and duration * fps > max_candidates:
        eff_fps = max_candidates / duration
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", video_path,
        "-vf", f"fps={eff_fps:.6f},{scale_filter(long_edge)}",
        "-frames:v", str(max_candidates),
        "-q:v", "2",
        os.path.join(out_dir, "%05d.jpg"),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    files = sorted(f for f in os.listdir(out_dir) if f.endswith(".jpg"))
    if proc.returncode != 0 and not files:
        raise VideoSamplingError(proc.stderr.strip()[-400:] or f"ffmpeg terminó con código {proc.returncode}")
    return [(os.path.join(out_dir, name), i / eff_fps) for i, name in enumerate(files)]


def laplacian_sharpness(path: str) -> float:
    """Varianza del laplaciano en gris a ~480 px: más alto = más nítido. -1 si no se puede leer."""
    import cv2  # solo en la imagen de GPU

    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        return -1.0
    h, w = img.shape[:2]
    scale = 480.0 / max(h, w)
    if scale < 1:
        img = cv2.resize(img, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(img, cv2.CV_64F).var())


def with_sharpness(
    cands: Sequence[FrameCandidate], scorer: Callable[[str], float] = laplacian_sharpness
) -> list[FrameCandidate]:
    return [replace(c, sharpness=scorer(c.local_path)) for c in cands]
