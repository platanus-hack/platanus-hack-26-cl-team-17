"""Lectura y validación del manifiesto (SplatManifest de src/lib/contract.ts)."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

# Límites de cordura del job (el servidor ya valida 500..30000 iteraciones).
MIN_ITERATIONS = 100
MAX_ITERATIONS = 50_000
MIN_FRAMES = 3
MAX_FRAMES_CAP = 400
MAX_SAMPLE_FPS = 30.0

SOURCES = ("citizen", "drone", "responder")


class ManifestError(ValueError):
    """Manifiesto inválido; el mensaje va en español porque llega al puesto de mando."""


@dataclass(frozen=True)
class ManifestFrame:
    path: str
    t_s: float
    lat: float | None
    lng: float | None
    alt_m: float | None
    heading_deg: float | None


@dataclass(frozen=True)
class ManifestMedia:
    id: str
    label: str
    source: str
    video_path: str | None
    lat: float | None
    lng: float | None
    accuracy_m: float | None
    heading_deg: float | None
    frames: tuple[ManifestFrame, ...]


@dataclass(frozen=True)
class Manifest:
    incident_id: str
    reconstruction_id: str
    origin_lat: float
    origin_lng: float
    bucket: str
    output_prefix: str
    callback_url: str
    iterations: int
    max_frames: int
    sample_fps: float
    media: tuple[ManifestMedia, ...]

    def output_path(self, name: str) -> str:
        return self.output_prefix + name


def parse_gs_uri(uri: str) -> tuple[str, str]:
    """gs://bucket/ruta/objeto → (bucket, "ruta/objeto")."""
    if not isinstance(uri, str) or not uri.startswith("gs://"):
        raise ManifestError(f"La ruta del manifiesto no es gs://…: {uri!r}")
    rest = uri[len("gs://") :]
    bucket, _, name = rest.partition("/")
    if not bucket or not name:
        raise ManifestError(f"La ruta del manifiesto está incompleta: {uri!r}")
    return bucket, name


def _str(d: dict[str, Any], key: str, where: str, required: bool = True) -> str | None:
    v = d.get(key)
    if v is None:
        if required:
            raise ManifestError(f"Falta «{key}» en {where}.")
        return None
    if not isinstance(v, str) or (required and not v.strip()):
        raise ManifestError(f"«{key}» en {where} debe ser texto.")
    return v


def _num(d: dict[str, Any], key: str, where: str, required: bool = False) -> float | None:
    v = d.get(key)
    if v is None:
        if required:
            raise ManifestError(f"Falta «{key}» en {where}.")
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
        raise ManifestError(f"«{key}» en {where} debe ser un número.")
    return float(v)


def _lat_lng(d: dict[str, Any], where: str) -> tuple[float | None, float | None]:
    lat = _num(d, "lat", where)
    lng = _num(d, "lng", where)
    # Una posición a medias o fuera de rango se ignora (no invalida el medio).
    if lat is None or lng is None or not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None, None
    if lat == 0 and lng == 0:
        return None, None
    return lat, lng


def _parse_frame(raw: Any, where: str) -> ManifestFrame:
    if not isinstance(raw, dict):
        raise ManifestError(f"Un cuadro de {where} no es un objeto.")
    path = _str(raw, "path", where)
    assert path is not None
    lat, lng = _lat_lng(raw, where)
    return ManifestFrame(
        path=path,
        t_s=_num(raw, "t_s", where) or 0.0,
        lat=lat,
        lng=lng,
        alt_m=_num(raw, "alt_m", where),
        heading_deg=_num(raw, "heading_deg", where),
    )


def _parse_media(raw: Any, index: int) -> ManifestMedia:
    where = f"el medio {index + 1}"
    if not isinstance(raw, dict):
        raise ManifestError(f"{where.capitalize()} no es un objeto.")
    media_id = _str(raw, "id", where)
    assert media_id is not None
    label = _str(raw, "label", where, required=False) or media_id
    source = raw.get("source")
    if source not in SOURCES:
        raise ManifestError(f"«source» de {where} debe ser citizen, drone o responder.")
    frames_raw = raw.get("frames") or []
    if not isinstance(frames_raw, list):
        raise ManifestError(f"«frames» de {where} debe ser una lista.")
    video_path = _str(raw, "video_path", where, required=False) or None
    lat, lng = _lat_lng(raw, where)
    accuracy = _num(raw, "accuracy_m", where)
    return ManifestMedia(
        id=media_id,
        label=label,
        source=source,
        video_path=video_path,
        lat=lat,
        lng=lng,
        accuracy_m=accuracy if accuracy is not None and accuracy >= 0 else None,
        heading_deg=_num(raw, "heading_deg", where),
        frames=tuple(_parse_frame(f, where) for f in frames_raw),
    )


def parse_manifest(data: Any) -> Manifest:
    if not isinstance(data, dict):
        raise ManifestError("El manifiesto no es un objeto JSON.")
    if data.get("version") != 1:
        raise ManifestError(f"Versión de manifiesto no soportada: {data.get('version')!r}.")
    where = "el manifiesto"
    origin = data.get("origin")
    if not isinstance(origin, dict):
        raise ManifestError("Falta «origin» (ubicación del incidente) en el manifiesto.")
    o_lat, o_lng = _lat_lng(origin, "origin")
    if o_lat is None or o_lng is None:
        raise ManifestError("«origin» no tiene una latitud/longitud válida.")
    output_prefix = _str(data, "output_prefix", where)
    assert output_prefix is not None
    if not output_prefix.endswith("/"):
        output_prefix += "/"
    iterations = _num(data, "iterations", where, required=True)
    max_frames = _num(data, "max_frames", where, required=True)
    sample_fps = _num(data, "sample_fps", where, required=True)
    assert iterations is not None and max_frames is not None and sample_fps is not None
    if sample_fps <= 0:
        raise ManifestError("«sample_fps» debe ser mayor que 0.")
    media_raw = data.get("media")
    if not isinstance(media_raw, list) or not media_raw:
        raise ManifestError("El manifiesto no trae medios para reconstruir.")
    media = tuple(_parse_media(m, i) for i, m in enumerate(media_raw))
    if not any(m.video_path or m.frames for m in media):
        raise ManifestError("Ningún medio trae video ni cuadros.")
    return Manifest(
        incident_id=_str(data, "incident_id", where) or "",
        reconstruction_id=_str(data, "reconstruction_id", where) or "",
        origin_lat=o_lat,
        origin_lng=o_lng,
        bucket=_str(data, "bucket", where) or "",
        output_prefix=output_prefix,
        callback_url=_str(data, "callback_url", where) or "",
        iterations=int(min(MAX_ITERATIONS, max(MIN_ITERATIONS, round(iterations)))),
        max_frames=int(min(MAX_FRAMES_CAP, max(MIN_FRAMES, round(max_frames)))),
        sample_fps=float(min(MAX_SAMPLE_FPS, sample_fps)),
        media=media,
    )
