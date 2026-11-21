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
