-- Origen "zello": transmisiones del canal de Zello recibidas y transcritas en el servidor.
alter table comms drop constraint if exists comms_source_check;
alter table comms add constraint comms_source_check
  check (source in ('manual','dictation','simulated','import','zello'));
