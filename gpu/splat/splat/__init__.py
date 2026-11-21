"""Job de GPU de Vigía: reconstrucción 3D Gaussian Splatting de la escena de un incidente.

Módulos sin GPU (se prueban localmente): manifest, geo, frames, align, splat_io, callback,
depthmap, register (unión de medios y bundle adjustment), cleanup, consistency (pruebas de
consistencia de la escena y limpieza de flotantes).
Módulos con GPU (solo en la imagen CUDA): posing (VGGT), train (gsplat), main.
"""
