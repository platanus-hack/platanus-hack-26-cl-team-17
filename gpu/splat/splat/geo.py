"""Proyección local ENU, idéntica a toLocal() de src/lib/geo.ts (plano tangente, R = 6 371 km)."""

from __future__ import annotations

import math

EARTH_RADIUS_M = 6_371_000.0


def to_enu(origin_lat: float, origin_lng: float, lat: float, lng: float) -> tuple[float, float]:
    """(x Este, y Norte) en metros respecto del origen del incidente."""
    x = math.radians(lng - origin_lng) * EARTH_RADIUS_M * math.cos(math.radians(origin_lat))
    y = math.radians(lat - origin_lat) * EARTH_RADIUS_M
    return x, y


def heading_vector(bearing_deg: float) -> tuple[float, float]:
    """Rumbo (grados desde el norte, horario) → vector unitario (Este, Norte)."""
    b = math.radians(bearing_deg)
    return math.sin(b), math.cos(b)
