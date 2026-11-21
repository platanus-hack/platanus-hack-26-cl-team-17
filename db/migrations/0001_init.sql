-- ═══════════════════════════════════════════════════════════════════════════
-- Vigía — esquema inicial (Postgres 17 puro; Cloud SQL o cualquier Postgres ≥ 14)
--
-- La aplica src/lib/store/pg-migrate.ts dentro de una transacción y bajo
-- pg_advisory_lock, y la registra en schema_migrations. No está pensada para
-- ejecutarse dos veces a mano.
--
-- Los nombres de columna son los mismos que los campos de src/lib/domain.ts.
-- Columnas internas que no salen del servidor: media_seq/comm_seq/mission_seq,
-- rev_xact (incidents), seq (media, drone_missions), ord (events),
-- upload_token_hash (media) e ingest_token_hash (drone_missions).
--
-- No hay roles, RLS ni publicaciones: solo el servidor de Vigía habla con la
-- base (vecinos y personal pasan siempre por /api).
-- ═══════════════════════════════════════════════════════════════════════════

-- La crea también el migrador antes de leerla; aquí queda documentada.
create table if not exists schema_migrations (
  name        text primary key,
  applied_at  timestamptz not null default now()
);

-- ───────────────────────────── 1. Tablas ─────────────────────────────

create table incidents (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  type          text not null default 'unknown'
                check (type in ('structure_fire','vehicle_fire','wildland_fire','vehicle_collision',
                                'hazmat','rescue','other','unknown')),
  title         text not null default '',
  address       text not null default '',
  lat           double precision not null check (lat between -90 and 90),
  lng           double precision not null check (lng between -180 and 180),
  status        text not null default 'active' check (status in ('active','controlled','closed')),
  description   text not null default '',
  origin        text not null default 'command' check (origin in ('command','citizen','demo')),
  verified      boolean not null default true,
  share_key     text not null,
  -- Sube con cualquier cambio del incidente o de sus hijos (ver sección 4).
  rev           integer not null default 1,
  -- Transacción que hizo el último incremento de rev (para subir una sola vez por transacción).
  rev_xact      xid8,
  situation                 jsonb,
  situation_engine          text check (situation_engine in ('claude','simulated')),
  situation_updated_at      timestamptz,
  scene                     jsonb,
  scene_engine              text check (scene_engine in ('claude','simulated')),
  scene_updated_at          timestamptz,
  comms_analysis            jsonb,
  comms_engine              text check (comms_engine in ('claude','simulated')),
  comms_analysis_updated_at timestamptz,
  pipeline      jsonb not null default '{"fusion_status":"idle","fusion_error":null,"fusion_requested_at":null,"fusion_started_at":null,"fusion_finished_at":null,"comms_status":"idle","comms_error":null,"comms_requested_at":null,"comms_finished_at":null}'::jsonb
                check (jsonb_typeof(pipeline) = 'object'),
  -- Contadores para las etiquetas M<n>, C<n> (seq) y D<n> (ver next_seq).
  media_seq     integer not null default 0,
  comm_seq      integer not null default 0,
  mission_seq   integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table drone_missions (
  id            uuid primary key default gen_random_uuid(),
  incident_id   uuid not null references incidents(id) on delete cascade,
  -- seq y label los asigna un trigger si vienen nulos ("D1", "D2"...).
  seq           integer not null,
  label         text not null,
  status        text not null default 'planned'
                check (status in ('planned','launching','en_route','on_station','returning','landed','aborted')),
  mode          text not null check (mode in ('simulated','device','api')),
  pattern       text not null default 'orbit' check (pattern in ('orbit','hover','grid')),
  radius_m      double precision not null,
  altitude_m    double precision not null,
  speed_ms      double precision not null,
  home_lat      double precision not null check (home_lat between -90 and 90),
  home_lng      double precision not null check (home_lng between -180 and 180),
  waypoints     jsonb not null default '[]'::jsonb check (jsonb_typeof(waypoints) = 'array'),
  command       text not null default 'continue' check (command in ('continue','recall','abort')),
  last          jsonb,
  track         jsonb not null default '[]'::jsonb check (jsonb_typeof(track) = 'array'),
  frames_received integer not null default 0 check (frames_received >= 0),
  ingest_token_hash text not null,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  ended_at      timestamptz,
  unique (incident_id, seq),
  unique (incident_id, label)
);

create table media (
  id            uuid primary key default gen_random_uuid(),
  incident_id   uuid not null references incidents(id) on delete cascade,
  -- seq y label los asigna un trigger si vienen nulos ("M1", "M2"...).
  seq           integer not null,
  label         text not null,
  source        text not null check (source in ('citizen','drone','responder','demo')),
  kind          text not null check (kind in ('video','photo','frames')),
  mission_id    uuid references drone_missions(id) on delete set null,
  video_path    text,
  video_status  text not null default 'none' check (video_status in ('none','uploading','uploaded','failed')),
  mime          text,
  size_bytes    bigint check (size_bytes is null or size_bytes >= 0),
  duration_s    double precision,
  lat           double precision check (lat is null or lat between -90 and 90),
  lng           double precision check (lng is null or lng between -180 and 180),
  accuracy_m    double precision,
  heading_deg   double precision,
  captured_at   timestamptz,
  reporter_note text not null default '',
  status        text not null default 'uploading'
                check (status in ('uploading','uploaded','analyzing','analyzed','failed')),
  error         text,
  analysis      jsonb,
  analysis_engine text check (analysis_engine in ('claude','simulated')),
  analyzed_at   timestamptz,
  -- SHA-256 (hex) del token de subida; null para medios creados por el servidor.
  upload_token_hash text,
  created_at    timestamptz not null default now(),
  unique (incident_id, seq),
  unique (incident_id, label)
);

create table media_frames (
  id            uuid primary key default gen_random_uuid(),
  media_id      uuid not null references media(id) on delete cascade,
  idx           integer not null check (idx >= 0),
  t_s           double precision not null default 0,
  storage_path  text not null,
  width         integer not null check (width > 0),
  height        integer not null check (height > 0),
  lat           double precision,
  lng           double precision,
  alt_m         double precision,
  heading_deg   double precision,
  created_at    timestamptz not null default now(),
  unique (media_id, idx)
);

create table comms (
  id            uuid primary key default gen_random_uuid(),
  incident_id   uuid not null references incidents(id) on delete cascade,
  -- Lo asigna un trigger si viene nulo; la IA lo cita como "C<seq>".
  seq           integer not null,
  at            timestamptz not null default now(),
  channel       text not null default '',
  speaker       text not null default '',
  text          text not null,
  source        text not null default 'manual' check (source in ('manual','dictation','simulated','import')),
  created_at    timestamptz not null default now(),
  unique (incident_id, seq)
);

create table events (
  id            uuid primary key default gen_random_uuid(),
  -- Orden de inserción: desempata eventos con el mismo `at`.
  ord           bigint generated always as identity,
  incident_id   uuid not null references incidents(id) on delete cascade,
  at            timestamptz not null default now(),
  kind          text not null
                check (kind in ('incident_created','incident_updated','media_received','media_analyzed',
                                'media_failed','alert','situation_updated','scene_updated','comms',
                                'comms_alert','drone','error')),
  severity      text not null default 'info' check (severity in ('info','notice','warning','critical')),
  title         text not null default '',
  detail        text not null default '',
  media_id      uuid references media(id) on delete set null,
  comm_id       uuid references comms(id) on delete set null,
  mission_id    uuid references drone_missions(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Exclusión mutua entre instancias (fusión, análisis de comunicaciones).
create table locks (
  incident_id   uuid not null references incidents(id) on delete cascade,
  name          text not null,
  expires_at    timestamptz not null,
  acquired_at   timestamptz not null default now(),
  primary key (incident_id, name)
);

-- Personal con acceso al puesto de mando (contraseña con scrypt; ver src/lib/auth).
create table staff (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique check (email = lower(email) and email <> ''),
  name          text not null,
  role          text not null default 'operator' check (role in ('admin','officer','operator')),
  password_hash text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- ───────────────────────────── 2. Índices ─────────────────────────────

create index incidents_status_created_idx   on incidents (status, created_at desc);
create index incidents_created_idx          on incidents (created_at desc);
create index media_incident_created_idx     on media (incident_id, created_at, seq);
create index media_mission_idx              on media (mission_id) where mission_id is not null;
-- Lote abierto de cuadros de dron por misión (getOpenDroneBatch).
create index media_open_drone_batch_idx     on media (mission_id, seq desc)
  where source = 'drone' and kind = 'frames' and status = 'uploading';
create index comms_incident_at_idx          on comms (incident_id, at);
create index missions_incident_created_idx  on drone_missions (incident_id, created_at, seq);
create index events_incident_at_idx         on events (incident_id, at desc, ord desc);
create index events_media_idx               on events (media_id) where media_id is not null;
create index events_comm_idx                on events (comm_id) where comm_id is not null;
create index events_mission_idx             on events (mission_id) where mission_id is not null;
create index locks_expires_idx              on locks (expires_at);

-- ───────────────────── 3. Contadores y etiquetas ─────────────────────

-- Incremento atómico de un contador del incidente: 'media' | 'comm' | 'mission'.
-- El UPDATE bloquea la fila del incidente hasta el commit, así que inserts
-- concurrentes del mismo incidente reciben números consecutivos sin repetir.
create function next_seq(p_incident uuid, p_counter text)
returns integer
language plpgsql
as $$
declare
  v integer;
begin
  if p_counter = 'media' then
    update incidents set media_seq = media_seq + 1 where id = p_incident returning media_seq into v;
  elsif p_counter = 'comm' then
    update incidents set comm_seq = comm_seq + 1 where id = p_incident returning comm_seq into v;
  elsif p_counter = 'mission' then
    update incidents set mission_seq = mission_seq + 1 where id = p_incident returning mission_seq into v;
  else
    raise exception 'next_seq: contador desconocido: %', p_counter using errcode = '22023';
  end if;
  if v is null then
    raise exception 'next_seq: el incidente % no existe', p_incident using errcode = 'P0002';
  end if;
  return v;
end;
$$;

create function tg_media_assign_label()
returns trigger
language plpgsql
as $$
begin
  if new.seq is null then
    new.seq := next_seq(new.incident_id, 'media');
  end if;
  if new.label is null or new.label = '' then
    new.label := 'M' || new.seq;
  end if;
  return new;
end;
$$;

create function tg_mission_assign_label()
returns trigger
language plpgsql
as $$
begin
  if new.seq is null then
    new.seq := next_seq(new.incident_id, 'mission');
  end if;
  if new.label is null or new.label = '' then
    new.label := 'D' || new.seq;
  end if;
  return new;
end;
$$;

create function tg_comm_assign_seq()
returns trigger
language plpgsql
as $$
begin
  if new.seq is null then
    new.seq := next_seq(new.incident_id, 'comm');
  end if;
  return new;
end;
$$;

create trigger media_assign_label before insert on media
  for each row execute function tg_media_assign_label();
create trigger missions_assign_label before insert on drone_missions
  for each row execute function tg_mission_assign_label();
create trigger comms_assign_seq before insert on comms
  for each row execute function tg_comm_assign_seq();

-- ───────────────────────── 4. Revisión (rev) ─────────────────────────
--
-- Semántica elegida: `rev` sube EXACTAMENTE UNA VEZ por transacción que
-- modifique el incidente o cualquiera de sus hijos, y `updated_at` toma now()
-- (la hora de inicio de esa transacción).
--
--  · El único lugar que incrementa es el trigger BEFORE UPDATE de incidents:
--    modifica NEW y no ejecuta otro UPDATE, así que no hay recursión.
--  · Las tablas hijas solo "tocan" al incidente dueño (UPDATE ... SET
--    updated_at = now()) desde triggers AFTER ... FOR EACH STATEMENT con
--    tablas de transición: un INSERT de 6 cuadros toca una sola vez.
--  · rev_xact guarda la transacción del último incremento. Si la fila ya se
--    incrementó en la transacción actual, los toques siguientes no vuelven a
--    sumar. Así, crear un medio (next_seq actualiza media_seq y luego el
--    trigger AFTER toca el incidente), un upsert de cuadros (dispara los
--    triggers de INSERT y de UPDATE) o varias mutaciones dentro de una misma
--    transacción suben rev en 1, no en 2 o más.
--  · Por lo mismo, next_seq llamado por sí solo también cuenta como cambio.
--  · Un UPDATE que no afecta filas de una tabla hija no toca al incidente.
--  · Los candados (locks) no son datos del incidente y no tocan rev.

create function tg_incidents_bump_rev()
returns trigger
language plpgsql
as $$
declare
  v_xact xid8 := pg_current_xact_id();
begin
  if old.rev_xact is distinct from v_xact then
    new.rev := old.rev + 1;
    new.rev_xact := v_xact;
  else
    new.rev := old.rev;
    new.rev_xact := old.rev_xact;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger incidents_bump_rev before update on incidents
  for each row execute function tg_incidents_bump_rev();

-- Tablas hijas con incident_id. Cada trigger declara solo las tablas de
-- transición que su evento tiene (new_rows y/o old_rows).
create function tg_touch_incidents()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    update incidents set updated_at = now()
     where id in (select incident_id from new_rows);
  elsif tg_op = 'UPDATE' then
    update incidents set updated_at = now()
     where id in (select incident_id from new_rows union select incident_id from old_rows);
  elsif tg_op = 'DELETE' then
    update incidents set updated_at = now()
     where id in (select incident_id from old_rows);
  end if;
  return null;
end;
$$;

-- media_frames no tiene incident_id: se llega al incidente a través de media.
create function tg_touch_incidents_from_frames()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    update incidents set updated_at = now()
     where id in (select m.incident_id from media m where m.id in (select media_id from new_rows));
  elsif tg_op = 'UPDATE' then
    update incidents set updated_at = now()
     where id in (select m.incident_id from media m
                   where m.id in (select media_id from new_rows union select media_id from old_rows));
  elsif tg_op = 'DELETE' then
    update incidents set updated_at = now()
     where id in (select m.incident_id from media m where m.id in (select media_id from old_rows));
  end if;
  return null;
end;
$$;

create trigger media_touch_ins after insert on media
  referencing new table as new_rows for each statement execute function tg_touch_incidents();
create trigger media_touch_upd after update on media
  referencing old table as old_rows new table as new_rows for each statement execute function tg_touch_incidents();
create trigger media_touch_del after delete on media
  referencing old table as old_rows for each statement execute function tg_touch_incidents();

create trigger comms_touch_ins after insert on comms
  referencing new table as new_rows for each statement execute function tg_touch_incidents();
create trigger comms_touch_upd after update on comms
  referencing old table as old_rows new table as new_rows for each statement execute function tg_touch_incidents();
create trigger comms_touch_del after delete on comms
  referencing old table as old_rows for each statement execute function tg_touch_incidents();

create trigger missions_touch_ins after insert on drone_missions
  referencing new table as new_rows for each statement execute function tg_touch_incidents();
create trigger missions_touch_upd after update on drone_missions
  referencing old table as old_rows new table as new_rows for each statement execute function tg_touch_incidents();
create trigger missions_touch_del after delete on drone_missions
  referencing old table as old_rows for each statement execute function tg_touch_incidents();

create trigger events_touch_ins after insert on events
  referencing new table as new_rows for each statement execute function tg_touch_incidents();
create trigger events_touch_upd after update on events
  referencing old table as old_rows new table as new_rows for each statement execute function tg_touch_incidents();
create trigger events_touch_del after delete on events
  referencing old table as old_rows for each statement execute function tg_touch_incidents();

create trigger media_frames_touch_ins after insert on media_frames
  referencing new table as new_rows for each statement execute function tg_touch_incidents_from_frames();
create trigger media_frames_touch_upd after update on media_frames
  referencing old table as old_rows new table as new_rows for each statement execute function tg_touch_incidents_from_frames();
create trigger media_frames_touch_del after delete on media_frames
  referencing old table as old_rows for each statement execute function tg_touch_incidents_from_frames();

-- ───────────────────────── 5. Funciones ─────────────────────────

-- Candado atómico: lo toma si no existe o si el anterior ya expiró.
-- Devuelve false si el incidente no existe. ttl en segundos (admite fracciones).
create function acquire_lock(p_incident uuid, p_name text, p_ttl_seconds double precision)
returns boolean
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_exp timestamptz := v_now + make_interval(secs => greatest(coalesce(p_ttl_seconds, 0), 0));
  got   boolean;
begin
  if not exists (select 1 from incidents where id = p_incident) then
    return false;
  end if;
  insert into locks as l (incident_id, name, expires_at, acquired_at)
  values (p_incident, p_name, v_exp, v_now)
  on conflict (incident_id, name) do update
    set expires_at = excluded.expires_at, acquired_at = excluded.acquired_at
    where l.expires_at <= v_now
  returning true into got;
  return coalesce(got, false);
end;
$$;

create function release_lock(p_incident uuid, p_name text)
returns void
language sql
as $$
  delete from locks where incident_id = p_incident and name = p_name;
$$;

-- Agrega puntos a la traza (acotada a los últimos 300) y deja `last` en el
-- último punto. Sin puntos devuelve la misión sin modificarla; si la misión no
-- existe no devuelve filas. FOR NO KEY UPDATE no choca con los inserts de
-- cuadros del mismo dron (que toman KEY SHARE por la FK de media.mission_id).
create function append_telemetry(p_mission uuid, p_points jsonb)
returns setof drone_missions
language plpgsql
as $$
declare
  m      drone_missions;
  merged jsonb;
  n      integer;
begin
  select * into m from drone_missions where id = p_mission for no key update;
  if not found then
    return;
  end if;
  if p_points is null or jsonb_typeof(p_points) <> 'array' or jsonb_array_length(p_points) = 0 then
    return next m;
    return;
  end if;
  merged := coalesce(m.track, '[]'::jsonb) || p_points;
  n := jsonb_array_length(merged);
  if n > 300 then
    select coalesce(jsonb_agg(t.elem order by t.ord), '[]'::jsonb) into merged
      from jsonb_array_elements(merged) with ordinality as t(elem, ord)
     where t.ord > n - 300;
  end if;
  update drone_missions
     set track = merged, last = merged -> -1
   where id = p_mission
  returning * into m;
  return next m;
end;
$$;
