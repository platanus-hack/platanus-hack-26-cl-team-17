-- Grabación de una transmisión de radio (ruta en el bucket); null = entrada solo de texto.
alter table comms add column if not exists audio_path text;
