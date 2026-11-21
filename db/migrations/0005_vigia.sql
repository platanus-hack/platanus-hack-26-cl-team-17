-- Memoria del agente Vigía por emergencia: sus mensajes al OBAC, lo que está haciendo,
-- su bitácora, los pendientes, los pedidos de video y hasta dónde miró cada fuente.
-- Un documento JSON por incidente; rev sube con cada cambio (sondeo de la mesa de mando).
create table if not exists vigia_state (
  incident_id uuid primary key references incidents(id) on delete cascade,
  state       jsonb not null,
  rev         integer not null default 0,
  updated_at  timestamptz not null default now()
);
