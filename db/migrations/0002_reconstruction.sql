-- Última reconstrucción 3D Gaussian Splatting del incidente (JSON con estado, progreso y archivo de splats).
alter table incidents add column if not exists reconstruction jsonb;
