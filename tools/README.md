# Herramientas

## `drone_bridge.py` — puente de dron

Conecta un dron (o algo que lo imite) con una misión de Vigía: envía la telemetría cada 2 segundos y cuadros JPEG, y obedece las órdenes que da el puesto de mando (**Retornar** y **Abortar**). Solo usa la biblioteca estándar de Python 3; para `--video` hace falta `ffmpeg` y para `--mavlink`, `pymavlink`.

### Antes de empezar

1. En el puesto de mando, abre el incidente y, en el panel **Dron**, elige **Desplegar dron → Dron real por API**.
2. El diálogo muestra **una sola vez** el comando del puente con el id de la misión y el token. Cópialo: el token no se vuelve a mostrar. Si lo pierdes, aborta la misión y crea otra.

### Fuentes

| Opción | Qué hace |
|---|---|
| `--simulate` | Vuelo sintético sin cámara: despega unos 300 m al sur, vuela a la órbita y gira alrededor del incidente mirando al centro. Necesita `--lat` y `--lng`. |
| `--video ARCHIVO` | Igual que `--simulate`, pero además reproduce el video y envía un cuadro cada `--every` segundos (5 por defecto) al ritmo real de reproducción, con el lado mayor a 1280 px. Sirve para mostrar en una demo un video aéreo real. |
| `--mavlink CONEXIÓN` | Lee posición y batería de un dron MAVLink (p. ej. `udp:127.0.0.1:14550`). **Retornar** pone el dron en modo RTL y **Abortar** en LAND. Es una **referencia que no se ha probado con hardware**: revísala y pruébala en simulador (SITL) antes de volar. |

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

Otras opciones: `--radius` (60 m), `--alt` (45 m), `--speed` (8 m/s), `--ffmpeg` (ruta del ejecutable). `python3 tools/drone_bridge.py --help` las lista todas.

### Qué ocurre en el puesto de mando

- La telemetría aparece en vivo en el panel **Dron** (altura, rumbo, velocidad, batería, distancia al incidente y antigüedad del último dato).
- Los cuadros se agrupan en lotes de 6. Cada lote llega como un medio nuevo (`M<n>`), se analiza igual que los videos de vecinos y alimenta el informe de situación. Al terminar el video se cierra el lote con lo que haya.
- Si el mando ordena **Retornar**, el vuelo sintético vuelve al punto de despegue y aterriza; con **Abortar** se detiene de inmediato.

### Detenerlo

`Ctrl+C` detiene el puente de forma ordenada. En los modos `--simulate` y `--video` envía el último cuadro pendiente e informa aterrizaje para cerrar la misión. En `--mavlink` no cambia el estado del dron real.

### Errores frecuentes

- **401 — token rechazado**: revisa `--mission` y `--token` (el token se entrega una sola vez al crear la misión).
- **409 — la misión ya no acepta datos**: la misión fue abortada en el puesto de mando. Crea otra.
- **Sin conexión**: el puente reintenta solo, con espera creciente; sigue volando mientras tanto.

## `zello-bridge/` — puente Zello (la única vía de voz)

Proceso aparte (notebook o Jetson) que mantiene abierta la conexión con la Zello Channel API.
No corre dentro de Next.js: Cloud Run atiende pedidos cortos y tiene varias instancias.

```bash
npm run zello                                    # contra http://localhost:3000, todas las emergencias abiertas
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
- **Escucha** el canal: cada transmisión (Opus → Ogg, sin decodificar) se transcribe con
  `on_transcription` si Zello la manda, o con ElevenLabs, y entra a la bitácora de **todas las
  emergencias abiertas** con su grabación (speaker = usuario de Zello, source `zello`).
- **Pregunta del OBAC**: lo que dice `ZELLO_OBAC_USERNAME`, o lo que empieza con «Vigía, …». La
  responde el agente; mientras la salida del agente no exista, el puente usa `POST …/ask`.
- **Habla** en el canal lo que el agente marca para decir: ElevenLabs (PCM 16 kHz) → Opus en cuadros
  de 60 ms. Reglas duras de `src/lib/vigia/rules.ts` antes del audio: máximo un mensaje cada ~20 s
  salvo posible persona en riesgo, filtro de «no hay nadie», nunca órdenes a las unidades. No habla
  encima de alguien que tiene el PTT apretado.
- **Estado**: latido cada 10 s; la mesa de mando lo muestra en el panel de radio.

Detenerlo: `Ctrl+C` (la mesa ve «desconectado» de inmediato). Reconecta solo si se corta la red.
