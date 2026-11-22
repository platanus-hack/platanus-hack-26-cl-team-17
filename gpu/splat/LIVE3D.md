# Reconstrucción 3D en vivo (`vigia-live3d`)

Servicio HTTP con GPU que arma una nube de puntos 3D **mientras el dron vuela**, a partir de los
mismos cuadros del video en vivo que ya recibe la app (`pushLiveFrame` en `src/lib/drone/live.ts`).
No reemplaza al job `vigia-splat` (Gaussian Splatting, minutos, fotorrealista): es la vista
inmediata, que se actualiza cada uno o dos segundos.

## Cómo funciona (`splat/live3d.py`)

- **Cuadros clave:** de lo que llega (la app reenvía hasta ~4 por segundo) se quedan los nítidos y
  distintos del anterior, a lo más ~3 por segundo, redimensionados a 518 px de ancho.
- **Ventanas deslizantes con VGGT** (el mismo modelo y pesos del job): cada ventana tiene los
  cuadros clave nuevos (hasta 12) más **anclas** ya ubicadas en el mapa (los 4 últimos cuadros
  clave y 2 más antiguos). VGGT entrega cámaras y profundidad de toda la ventana en su propio
  sistema; los píxeles confiables de las anclas, que ya tienen posición en el mapa, dan pares de
  puntos 3D y una **similitud robusta** (Umeyama ponderado por confianza + IRLS de Cauchy) lleva
  la ventana al mapa. Mismo enfoque que VGGT-Long. Si la ventana no encaja (el dron se fue a una
  zona sin solape), se descarta y se avisa.
- **Nube:** puntos de los cuadros nuevos (sin cielo ni bordes de profundidad), sin repetir vóxel
  ya ocupado. Cada ventana deja un **trozo inmutable** de puntos; el cliente pide los que le faltan.
- **Orientación para mostrar:** plano del suelo (RANSAC) orientado hacia las cámaras; si no hay
  suelo claro, la vertical promedio de las cámaras. Escala arbitraria (sin GPS).
- Solo muestra lo estático; lo que se mueve deja rastros.

## API HTTP

Sesión = id de la misión (`[A-Za-z0-9_-]{1,64}`). Todo JSON salvo los puntos.

| Método y ruta | Cuerpo / respuesta |
|---|---|
| `GET /health` | `{ok: true, ready: bool, engine: "vggt"\|"fake", gpu: string\|null, sessions: n}` |
| `POST /sessions/{sid}/frames?t=<ms>` | cuerpo JPEG → `202 {accepted: bool, reason: string\|null, keyframes, pending}` |
| `GET /sessions/{sid}/status` | `Live3DStatus` (abajo); `404` si la sesión no existe |
| `GET /sessions/{sid}/points?from=<k>&max=<m>` | binario (abajo) con los trozos `[from, to)`; `max` ≤ 16 (por defecto 8) |
| `POST /sessions/{sid}/reset` | `{ok: true}`: borra la sesión |

`Live3DStatus`:
```jsonc
{
  "session": "m_123",
  "engine": "vggt",            // "fake" = simulado (sin GPU, solo para desarrollo)
  "ready": true,               // modelo cargado
  "state": "waiting" | "running" | "lost",  // lost = la última ventana no encajó
  "message": "string|null",    // aviso en español para mostrar tal cual
  "version": 12,               // sube con cada cambio
  "chunks": 9,                 // trozos de puntos disponibles (0..chunks-1)
  "points": 812345,
  "keyframes": 74,
  "frames_received": 410,
  "pending": 3,
  "last_chunk_ms": 820,        // lo que tardó la última ventana
  "updated_at": 1763770000000, // ms epoch del último trozo
  "display": [16 números],     // matriz 4x4 por filas: mundo → vista (Y arriba, centrada, ~unidades de escena = 1)
  "cameras": [[12 números], …] // c2w 3x4 por filas (mundo, OpenCV: x derecha, y abajo, z adelante) de cada cuadro clave, en orden
}
```

Binario de `/points` (little-endian):
```
bytes 0..3   "VL3D"
u32          from
u32          to            (exclusivo)
u32          n             (puntos)
f32[n*3]     x,y,z en el sistema del mundo (aplicar `display` para mostrar)
u8[n*3]      r,g,b
```

## Variables

`PORT` (8080), `LIVE3D_FAKE=1` (motor simulado sin torch, para desarrollo de la interfaz),
`VGGT_WEIGHTS` (`/opt/models/vggt/model.safetensors`).

## Desplegar y probar

```bash
bash deploy/live3d.sh                                   # capa delgada sobre vigia-splat:latest + servicio privado (pide "si")
MIN_INSTANCES=1 SKIP_BUILD=1 CONFIRM=1 bash deploy/live3d.sh   # encendida para la demo (cobra la L4 todo el rato)
MIN_INSTANCES=0 SKIP_BUILD=1 CONFIRM=1 bash deploy/live3d.sh   # después
```
- Servicio `vigia-live3d` en europe-west1 (donde hay cuota de L4), 1 GPU, máx. 1 instancia (el estado
  de las sesiones vive en memoria). La app lo llama con token de identidad de `vigia-run`
  (`roles/run.invoker`). `deploy/cloudrun.sh` encuentra el servicio solo y pone
  `VIGIA_LIVE3D_URL` / `VIGIA_LIVE3D_AUTH=gcp` en la app en cada despliegue.
- Arranque en frío: bajar la imagen (~14 GB) y cargar VGGT, del orden de minutos. Los cuadros que
  llegan antes no se pierden: se procesan al terminar la carga (`/health` → `ready`).

Prueba de punta a punta sin la app (mismo camino que los cuadros del dron):
```bash
cd gpu/splat
.venv/bin/python tools/live3d_replay.py --url "$(gcloud run services describe vigia-live3d --region=europe-west1 --project=platanus-515411 --format='value(status.url)')" --gcp VIDEO.mp4 --out out/live3d/prueba
LIVE3D_FAKE=1 PORT=8790 .venv/bin/python -m splat.live3d_server       # motor simulado local, sin GPU
.venv/bin/python -m unittest tests.test_live3d                       # pruebas sin GPU
```
