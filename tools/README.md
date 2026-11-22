# Herramientas

## `drone_bridge.py` — puente de dron

Conecta un dron (o algo que lo imite) con una misión de Vigía: envía la telemetría cada 2 segundos y cuadros JPEG, y obedece las órdenes que da el puesto de mando (**Retornar** y **Abortar**). Solo usa la biblioteca estándar de Python 3; para `--video`, `--rtmp` y `--stream` hace falta `ffmpeg` y para `--mavlink`, `pymavlink`.

### Antes de empezar

1. En el puesto de mando, abre el incidente y, en el panel **Dron**, elige **Desplegar dron → Dron real por API**.
2. El diálogo muestra **una sola vez** el comando del puente con el id de la misión y el token. Cópialo: el token no se vuelve a mostrar. Si lo pierdes, aborta la misión y crea otra.

### Fuentes

| Opción | Qué hace |
|---|---|
| `--simulate` | Vuelo sintético sin cámara: despega unos 300 m al sur, vuela a la órbita y gira alrededor del incidente mirando al centro. Necesita `--lat` y `--lng`. |
| `--video ARCHIVO` | Igual que `--simulate`, pero además reproduce el video y envía un cuadro cada `--every` segundos (5 por defecto) al ritmo real de reproducción, con el lado mayor a 1280 px. Sirve para mostrar en una demo un video aéreo real. |
| `--mavlink CONEXIÓN` | Lee posición y batería de un dron MAVLink (p. ej. `udp:127.0.0.1:14550`). **Retornar** pone el dron en modo RTL y **Abortar** en LAND. Es una **referencia que no se ha probado con hardware**: revísala y pruébala en simulador (SITL) antes de volar. |
| `--rtmp [ESCUCHA]` | Servidor RTMP local para la **transmisión en vivo de DJI Fly** (por defecto `rtmp://0.0.0.0:1935/live/dron`). Manda solo video en vivo al puesto de mando (no queda guardado en el incidente); `--every N` agrega un cuadro cada N s a lotes de análisis. La posición es la órbita sintética. Sin `--mission`, va sola a la emergencia que atiende Vigía. Ver [Video en vivo desde DJI Fly](#video-en-vivo-desde-dji-fly-rtmp). |
| `--stream URL` | Igual que `--rtmp`, pero lee el video de una URL que ffmpeg sepa abrir (RTSP, RTMP, SRT…), p. ej. la de un MediaMTX. |

### Ejemplos

```bash
# Órbita sintética (sin cámara)
python3 tools/drone_bridge.py --url http://localhost:3000 --mission <ID> --token <TOKEN> \
  --simulate --lat -33.4569 --lng -70.5987

# Reproducir un video aéreo como cámara del dron, un cuadro cada 4 s
python3 tools/drone_bridge.py --url https://<tu-servicio> --mission <ID> --token <TOKEN> \
  --video aereo.mp4 --every 4 --lat -33.4569 --lng -70.5987

# Dron MAVLink (referencia no probada)
python3 -m pip install pymavlink
python3 tools/drone_bridge.py --url https://<tu-servicio> --mission <ID> --token <TOKEN> \
  --mavlink udp:127.0.0.1:14550
```

Otras opciones: `--radius` (60 m), `--alt` (45 m), `--speed` (8 m/s), `--live-fps` (8 cuadros/s del video en vivo, máximo 10), `--ffmpeg` (ruta del ejecutable). `python3 tools/drone_bridge.py --help` las lista todas.

### Video en vivo desde DJI Fly (RTMP)

DJI Fly transmite por RTMP a un servidor que uno elige. El puente hace de ese servidor en el notebook y reenvía el video a Vigía (local o Cloud Run) por HTTPS, por el mismo canal que el teléfono sensor.

**Lo más simple (probado con el dron real):** `tools/dron-dji.sh` levanta MediaMTX como servidor RTMP (Docker), muestra la URL para DJI Fly y corre el puente en modo automático leyendo de MediaMTX. Pide el correo y la contraseña del puesto de mando. `tools/dron-dji.sh http://localhost:3000` lo apunta a un Vigía local.

Los pasos de abajo usan el servidor RTMP de ffmpeg integrado en el puente (`--rtmp`, sin Docker); con DJI Fly solo se probó el camino de MediaMTX.

1. Corre el puente **sin `--mission`** (modo automático) y déjalo abierto:
   ```bash
   python3 tools/drone_bridge.py --url https://<tu-servicio> --rtmp
   ```
   Contra Cloud Run pide el correo y la contraseña del puesto de mando (o tómalos de `VIGIA_EMAIL` y `VIGIA_PASSWORD`). En modo local abierto no pide nada.
2. El puente muestra la URL que hay que poner en DJI Fly, con la IP del notebook:
   `Servidor RTMP escuchando. En DJI Fly (Transmisión en vivo → RTMP) usa:  rtmp://172.16.1.45:1935/live/dron`
3. En DJI Fly, desde la vista de cámara, abre los ajustes y busca **Transmisión en vivo → RTMP** (el nombre exacto del menú cambia según la versión y el dron). Pega la URL e inicia. A los 1–2 s el puente escribe `Llega video` y, cada 10 s, cuántos cuadros por segundo llegan a Vigía.

**Modo automático.** El video va siempre a la emergencia que atiende Vigía, igual que el agente y el puente Zello. Vigía atiende una emergencia a la vez: la elegida en el selector discreto del tablero (arriba a la derecha, junto a los contadores) o, en «Automático», la abierta (activa o controlada) más nueva. Con `--incident VG-XXXX` el puente queda fijo en esa e ignora el selector. El puente despliega ahí un dron «real por API» (aparece como `D<n>` en el panel Dron) y revisa cada 10 s. Si la elegida cambia, se crea una más nueva (en Automático) o la actual se cierra, cierra esa misión y se cambia sola. Si el mando pulsa **Retornar** o **Abortar**, el puente deja de mandar a esa emergencia y espera una nueva. Sin emergencias abiertas, el video llega al notebook pero no se envía. La misión en curso queda en `~/.cache/vigia/drone-bridge.json` (solo para tu usuario) para retomarla al reiniciar el puente.

**Con una misión fija.** Si prefieres elegir la emergencia: en el puesto de mando, **Desplegar dron → Dron real por API**, copia el comando y cambia `--simulate` por `--rtmp`.

**Red.** El teléfono con DJI Fly y el notebook tienen que estar en la misma red. Las redes de eventos suelen aislar a los clientes entre sí: si DJI Fly no conecta, conecta el notebook al hotspot del teléfono (o al revés) y usa la IP que muestre el puente. En Fedora la zona `FedoraWorkstation` ya deja entrar el puerto 1935/TCP. El video en vivo sube unos 2–3 Mbit/s.

**Qué llega al puesto de mando.**
- Video en vivo: 640 px a 8 cuadros/s (`--live-fps`), con YOLO si hay detector y el observador de Claude cada 15 s. Con red lenta bajan los cuadros por segundo; nunca se acumula atraso.
- Nada queda guardado como imagen en el incidente: solo cuenta el video en vivo. Para guardar lotes de análisis (un cuadro de 1280 px cada N s, en lotes de 6, que quedan en la línea de tiempo), agrega `--every N`.
- Posición: la órbita sintética alrededor del incidente, porque DJI Fly no manda telemetría por RTMP. La batería aparece como desconocida y no fuerza el retorno.

**Cortes.** Si DJI Fly deja de transmitir, el puente cierra el lote en curso y vuelve a esperar; al reanudar sigue solo. Si el teléfono pierde la red sin cerrar la conexión, a los 15 s sin cuadros reinicia la recepción.

**Detenerlo.** `Ctrl+C` **no** cierra la misión (igual que con `--mavlink`): vuelve a correr el mismo comando para retomar el video en la misma misión (la órbita sintética parte de nuevo desde el despegue). La misión se termina desde el puesto de mando.

**Cloud Run con varias instancias.** El video en vivo vive en la memoria de la instancia que recibe los cuadros. Si el puesto de mando cae en otra, ve un cuadro cada 2 s (copia en el storage). Para una demo conviene una sola instancia:
```bash
gcloud run services update vigia --region southamerica-west1 --max-instances 1   # después: --max-instances 4
```

**Si DJI Fly no conecta con el servidor de ffmpeg**, usa MediaMTX como servidor RTMP y que el puente lea de ahí:
```bash
docker run --rm -it --network=host bluenviron/mediamtx:1      # DJI Fly → rtmp://<IP>:1935/live/dron
python3 tools/drone_bridge.py --url … --mission … --token … \
  --stream rtsp://127.0.0.1:8554/live/dron --lat … --lng …
```

### Qué ocurre en el puesto de mando

- La telemetría aparece en vivo en el panel **Dron** (altura, rumbo, velocidad, batería, distancia al incidente y antigüedad del último dato).
- Los cuadros se agrupan en lotes de 6. Cada lote llega como un medio nuevo (`M<n>`), se analiza igual que los videos de vecinos y alimenta el informe de situación. Al terminar el video se cierra el lote con lo que haya.
- Si el mando ordena **Retornar**, el vuelo sintético vuelve al punto de despegue y aterriza; con **Abortar** se detiene de inmediato.

### Detenerlo

`Ctrl+C` detiene el puente de forma ordenada. En los modos `--simulate` y `--video` envía el último cuadro pendiente e informa aterrizaje para cerrar la misión. En `--mavlink`, `--rtmp` y `--stream` no cambia el estado de la misión ni del dron real.

### Errores frecuentes

- **401 — token rechazado**: revisa `--mission` y `--token` (el token se entrega una sola vez al crear la misión).
- **409 — la misión ya no acepta datos**: la misión fue abortada en el puesto de mando. Crea otra.
- **Sin conexión**: el puente reintenta solo, con espera creciente; sigue volando mientras tanto.

## `zello-bridge/` — puente Zello (la única vía de voz)

Proceso aparte (notebook o Jetson) que mantiene abierta la conexión con la Zello Channel API.
No corre dentro de Next.js: Cloud Run atiende pedidos cortos y tiene varias instancias.

```bash
npm run zello                                    # contra http://localhost:3000, la emergencia que atiende Vigía
npm run zello -- --url https://vigia.example     # contra el despliegue (con VIGIA_BRIDGE_TOKEN)
npm run zello -- --incident VG-XXXX              # solo una emergencia
npm run zello -- --listen-only                   # Vigía no habla
```

### Antes de empezar
- En `.env.local`: `ZELLO_USERNAME` (el *username* de Zello, no el correo), `ZELLO_PASSWORD`, y
  `ZELLO_AUTH_TOKEN` (token de desarrollo de developers.zello.com) o `ZELLO_ISSUER` + `ZELLO_PRIVATE_KEY`.
  `ZELLO_CHANNEL` (por defecto `demo-platanus`) y `ZELLO_OBAC_USERNAME`.
- `ELEVENLABS_API_KEY` para transcribir y para la voz (`ELEVENLABS_VOICE_ID`; vacío = voz de prueba).
- `ffmpeg` con libopus (para codificar la voz de Vigía).
- Contra un servidor con Postgres, el mismo `VIGIA_BRIDGE_TOKEN` en el servidor y en el puente.
- La cuenta del bot no puede estar abierta en la app de Zello: Zello permite una sesión por cuenta
  y expulsa al puente («otra sesión con la misma cuenta de Zello tomó la conexión»).

### Qué hace
- **Escucha** el canal: cada transmisión (Opus → Ogg, sin decodificar) se transcribe
  siempre con ElevenLabs (la transcripción de Zello no se pide ni se usa) y entra a la bitácora de **la emergencia
  que atiende Vigía** (la elegida en el tablero o la abierta más nueva; o la de `--incident`) con su grabación (speaker = usuario de Zello, source `zello`).
- **Pregunta del OBAC**: lo que dice `ZELLO_OBAC_USERNAME`, o lo que empieza con «Vigía, …». La
  responde el agente; mientras la salida del agente no exista, el puente usa `POST …/ask`.
- **Habla** en el canal lo que el agente marca para decir: ElevenLabs (PCM 16 kHz) → Opus en cuadros
  de 60 ms. Reglas duras de `src/lib/vigia/rules.ts` antes del audio: máximo un mensaje cada ~20 s
  salvo posible persona en riesgo, filtro de «no hay nadie», nunca órdenes a las unidades. No habla
  encima de alguien que tiene el PTT apretado.
- **Estado**: latido cada 10 s; la mesa de mando lo muestra en el panel de radio.

Detenerlo: `Ctrl+C` (la mesa ve «desconectado» de inmediato). Reconecta solo si se corta la red.
