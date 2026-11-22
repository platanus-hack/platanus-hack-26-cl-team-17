# Job de GPU `vigia-splat` (3D Gaussian Splatting)

Reconstruye la escena real de un incidente a partir de todos sus videos y cuadros (vecinos + dron) y deja un `scene.splat` que el visor de la app muestra en el mapa.

- **Dónde:** Cloud Run jobs, `projects/platanus-515411/locations/europe-west1/jobs/vigia-splat`, 1 GPU `nvidia-l4`, 8 vCPU / 32 GiB, sin reintentos, timeout 45 min (los valores por defecto de `deploy/splat-job.sh`). Con cuota de RTX PRO 6000: `GPU_TYPE=nvidia-rtx-pro-6000` (20 vCPU / 80 GiB). La imagen trae los kernels para los dos tipos de GPU.
- **Imagen:** `europe-west1-docker.pkg.dev/platanus-515411/vigia/vigia-splat` (CUDA 12.8, PyTorch 2.10 cu128, gsplat compilado para sm_89 y sm_120, ffmpeg, pesos de VGGT-1B incluidos). Se construye con Cloud Build: esta máquina no necesita GPU.
- **Cuentas:** el job corre como `vigia-splat@…` (`roles/storage.objectUser` solo sobre `gs://platanus-515411-vigia-evidencia`). La app (`vigia-run@…`) tiene `roles/run.jobsExecutorWithOverrides` y `roles/run.viewer` solo sobre este job.

## Qué hace (gpu/splat/splat/main.py)
1. Lee el manifiesto (`SplatManifest` de `src/lib/contract.ts`) desde `SPLAT_MANIFEST_URI` y reporta cada etapa a `callback_url` con `Authorization: Bearer $SPLAT_CALLBACK_TOKEN` (`preparing` → `posing` → `training` cada ~5 % → `exporting` → `ready`/`failed`). Si el callback falla, registra el error y sigue; si responde `cancel: true`, termina en `failed` con "Cancelada".
2. Descarga los videos (o los cuadros ya extraídos), muestrea a `sample_fps`, descarta los cuadros movidos (nitidez bajo el 25 % del percentil 90 de su medio, dejando al menos la mitad) y reparte `max_frames` entre los medios, prefiriendo los cuadros más nítidos.
3. **Cámaras:** VGGT (Meta, CVPR 2025), feed-forward, sin COLMAP, **una pasada por medio** (cada video o set de fotos por separado; el modelo se carga una vez). Estima cámaras y profundidad en segundos. Código bajo la VGGT License; los pesos `facebook/VGGT-1B` son **CC BY-NC 4.0 (uso no comercial)**. Para uso comercial cambia a `facebook/VGGT-1B-Commercial` (`VGGT_REPO` en el Dockerfile; requiere aprobación en Hugging Face).
4. **Unión de medios y bundle adjustment** (`register.py`, CPU salvo el emparejamiento): puntos SIFT, coincidencias entre vecinos de cada medio y entre una muestra de cuadros de medios distintos, verificadas con una matriz fundamental (MAGSAC). Entre dos medios, las coincidencias con profundidad de VGGT dan pares de puntos 3D → similitud robusta (RANSAC + Umeyama). Los medios se unen por un árbol de expansión máximo; **los que no se conectan con el grupo principal quedan fuera** (y el mensaje lo dice) en vez de duplicar muebles. Después, bundle adjustment global (Levenberg–Marquardt con complemento de Schur, pérdida de Huber, poses + puntos + una focal por medio) y escala de profundidad por cuadro; se descartan los cuadros con error de reproyección alto. Si el ajuste empeora el error, se revierte; si el registro falla, se sigue con el medio más grande.
5. **Entrenamiento:** gsplat (Apache-2.0), `DefaultStrategy` con gradiente absoluto (AbsGS, `grow_grad2d` 0,0008), hasta `iterations` pasos (30.000 por defecto), con ajuste fino de cámaras y de exposición por imagen. Nube inicial: profundidad de VGGT de cada cuadro con su escala corregida, sin puntos aislados, más los puntos del bundle adjustment. El calendario (decaimiento de la tasa de aprendizaje, fin de la densificación a la mitad) sigue el avance por pasos o por tiempo, lo que vaya primero: con `SPLAT_TIME_BUDGET_S` (el timeout de la tarea, lo pone `splat-job.sh`) termina con 4 min de margen y exporta lo entrenado en vez de cortarse.
6. **Alineación al ENU local** (x Este, y Norte, z arriba, origen en el incidente): con ≥ 3 posiciones GPS distintas y separadas (dron por cuadro, teléfono una por video) → Umeyama (similitud), `alignment: "gps"`, `scale_known: true`; si no → vertical estimada desde las cámaras y escala arbitraria, `alignment: "approximate"`, `scale_known: false`. Los gaussianos se exportan ya en ENU (`transform` = identidad).
7. **Limpieza** antes de exportar: fuera las gaussianas fuera de la caja de la escena (fondo, cielo) y las desmesuradas (`cleanup.py`), y después, en hasta 3 pasadas (al quitar una capa de basura quedan expuestas las islas que colgaban de ella), según `consistency.py` (ver abajo):
   - **islas flotantes chicas** (≤ 32 gaussianas o menos del 2 % del ancho) y **gaussianas sueltas**: una gaussiana sola en el vacío no es ambigua, se borran hasta el 50 % del peso visual;
   - lo que quedó **bajo el suelo** (típicamente el reflejo de un piso brillante), si la vertical es confiable (≤ 10°) y es poco (≤ 8 % del peso);
   - **islas flotantes grandes** solo si la escena principal tiene al menos la mitad del peso y, sumadas a lo de bajo el suelo, no pasan del 30 %: podrían ser escena real mal conectada (una mesa cuyas patas no salieron). Si no se cumple, se dejan y el reporte lo dice.
8. Exporta `scene.splat` (formato de antimatter15, 32 bytes por gaussiana, ordenado por importancia, máximo 1,5 M), `preview.jpg`, `result.json` (con `dropped_media`, `bundle_adjusted`, `cleanup` y `consistency`) y `consistency.json` (el reporte completo de las pruebas de consistencia sobre lo exportado) en `output_prefix`. Si se quitaron flotantes, el mensaje final lo dice; si quedan partes flotando o la vertical está torcida, avisa que hay que revisar la escena.

## Pruebas de consistencia (`gpu/splat/splat/consistency.py`)
Responden «¿la escena es físicamente creíble?» sin mirar las fotos. Las gaussianas están en ENU (z arriba) y, sin GPS, la escala es arbitraria: todo se mide en múltiplos del espaciado típico `h` (mediana de la distancia media a las 8 vecinas) o del tamaño de la escena. Los porcentajes son de **peso visual** (opacidad × área de los dos ejes mayores: lo que una gaussiana tapa en pantalla).

| Prueba | Qué detecta | Falla si |
|---|---|---|
| `integridad` | valores no finitos, cuaterniones nulos, escala ≤ 0, archivo truncado | hay alguna |
| `aisladas` | gaussianas lejos de sus vecinas y sin tocarse con ninguna | > 2 % del peso |
| `desprendidas` | islas a más de 4·h de la escena principal (informativa: una isla apoyada en el suelo puede ser un objeto aparte) | nunca (aviso > 10 %) |
| `flotantes` | islas separadas de la escena por más de 8·h y del 1 % del ancho que **no tocan el suelo** | > 1 % del peso, o una sola isla > 0,3 % |
| `bajo_suelo` | peso bajo el plano del suelo (reflejos, suelo doble) | > 3 % del peso |
| `vertical` | inclinación del suelo respecto de z. El suelo es el plano horizontal bajo con más peso (RANSAC sobre la capa más baja de todas las gaussianas visibles, no solo de la escena principal: así un piso brillante que quedó como isla no hace que el plano caiga sobre las mesas) | > 20° |
| `tamanos` | gaussianas desmesuradas (> 5 % de la diagonal) o agujas (eje mayor > 30× el medio) | > 15 % del peso |
| `fondo` | peso a más de 3 veces el radio de la escena | > 2 % del peso |
| `metadatos` | `result.json` incoherente con el archivo (cantidad, estado, alineación) | hay alguna |

La conectividad usa todas las gaussianas con opacidad ≥ 0,05 (en una escena entrenada la mayoría es semitransparente y ese tejido es el que une las superficies) y considera el alcance de cada una (≈ 2σ del eje mayor, unida a sus 32 vecinas más cercanas dentro de él), así una gaussiana grande de una pared toca a las que cubre. Memoria: ~1,5 GB para 900 mil gaussianas; en una máquina chica analiza una escena por proceso.

```bash
cd gpu/splat
.venv/bin/python -m splat.consistency scene.splat --result result.json --json reporte.json --png vistas.png
.venv/bin/python -m unittest discover -s tests -t .     # pruebas del job sin GPU
```
`--png` dibuja la planta y el costado de la escena coloreados por clase (gris escena, azul isla en el suelo, rojo flotante, naranjo bajo el suelo, magenta suelta, línea verde el suelo): sirve para ver qué marcó cada prueba y qué va a borrar la limpieza (lo rojo, lo magenta y, con la vertical confiable, lo naranjo).

**Qué grabar para un buen resultado:** caminar alrededor de lo que importa (girar en el lugar no da profundidad), lento, con exposición y enfoque bloqueados; si son varios videos, que se solapen bastante (idealmente cada uno empieza donde termina otro). Superficies lisas, vidrios y espejos salen mal.

La reconstrucción solo muestra lo estático: personas o vehículos en movimiento no quedan. El mensaje final lo advierte ("no la uses para descartar víctimas").

## Probar con fotos propias (`gpu/splat/tools/prueba_fotos.py`)
Para medir qué tan bien reconstruye un set de fotos sin pasar por la app (mismo job, mismo manifiesto):

```bash
cd gpu/splat
uv pip install --python .venv/bin/python -r requirements-test.txt   # una vez: Pillow + HEIC
.venv/bin/python tools/prueba_fotos.py revisar ~/fotos/sala          # segundos, sin GPU
.venv/bin/python tools/prueba_fotos.py correr ~/fotos/sala --caso sala-1   # ~7 min de L4 con 7.000 pasos
.venv/bin/python tools/prueba_fotos.py ver sala-1                    # visor 3D en http://127.0.0.1:8090/ver.html
.venv/bin/python tools/prueba_fotos.py tabla                         # todas las corridas
```
- `revisar` avisa antes de gastar GPU: menos de 8 fotos, fotos movidas, fotos que no se solapan con ninguna (SIFT + matriz fundamental), un set que se parte en grupos sin fotos de transición, y falta de paralaje (si casi todos los pares se explican con una homografía, se giró en el lugar o se fotografió una superficie plana).
- `correr` endereza (EXIF), achica a 1280 px y guarda JPEG **sin metadatos**; el GPS de las fotos solo con `--gps` (al aire libre: adentro el error del GPS es del tamaño de la sala y arruina la escala). Sube a `gs://…/test/fotos/<caso>/<corrida>/`, corre el job con un solo medio de fotos y deja en `gpu/splat/out/fotos/<caso>/<corrida>/` las fotos preparadas, `scene.splat`, `preview.jpg`, `result.json`, `consistency.json` y `ver.html`; agrega una fila a `out/fotos/resultados.tsv`.
- En la L4 caben ~76 fotos en una pasada de VGGT: con más, el job usa las más nítidas.
- Cómo tomar las fotos: 20 a 60, caminando alrededor del espacio (no girando en el lugar), cada una solapada ~60 % con la anterior, a distintas alturas si se puede; exposición pareja; evitar vidrios, espejos y gente moviéndose.

## Costo aproximado
Sin ejecuciones no hay costo fijo (solo el almacenamiento de la imagen, ~14 GB en Artifact Registry). Cada ejecución cobra GPU + 20 vCPU + 80 GiB por segundo mientras corre: del orden de algunos USD por hora en total (revisa la tabla vigente de precios de Cloud Run con GPU antes de usarlo en serio). Una reconstrucción típica (≤ 300 cuadros, hasta 30.000 pasos) debería tomar 20–40 min con arranque en frío incluido y nunca pasa del timeout de la tarea (45 min); no está medido todavía (ver abajo). El bundle adjustment con 300 cámaras y 250 mil observaciones toma ~8 s en CPU (medido sin GPU). Cada build con la caché cuesta pocos minutos de Cloud Build (`E2_HIGHCPU_32`); el primero tomó ~13 min.

## Desplegar y probar
```bash
bash deploy/splat-job.sh                      # APIs, registro, cuenta, build, job, permisos (pide "si"; CONFIRM=1 lo omite)
SKIP_BUILD=1 CONFIRM=1 bash deploy/splat-job.sh   # solo redepliega :latest y reaplica permisos
RUN_MANIFEST=gs://platanus-515411-vigia-evidencia/test/splat/llangaffo/manifest.json bash deploy/splat-job.sh run
```
Caso de prueba ya subido en `gs://platanus-515411-vigia-evidencia/test/splat/llangaffo/`: dos tramos del video de dron "Drone Footage Eglwys Llangaffo" (Wikimedia Commons, Taffronaut1111, **CC0**), manifiesto con 7.000 iteraciones y un `callback_url` que no existe (el job debe seguir igual). La salida queda en `.../llangaffo/out/` (`scene.splat`, `preview.jpg`, `result.json`). Logs:
```bash
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="vigia-splat"' --project=platanus-515411 --limit=200 --order=asc --format='value(textPayload)'
```

## Estado (21-11-2026)
El job corre en europe-west1 con una L4 (en us-central1 no se pudo por la cuota `MaxRegionsPerProject` de Cloud Run). Una reconstrucción de 7.000 pasos tarda ~6,5 min: 65 % entrenamiento, 11 % VGGT, el resto arranque, descarga, registro y exportación (la limpieza y las pruebas, ~8 s). El build de la imagen tarda ~14 min, la mitad subiendo los ~14 GB (los pesos de VGGT van dentro).

Pruebas de consistencia sobre los 5 incidentes de la base con video o fotos reales (salida en `gs://…/test/consistencia/<código>/`, imagen `vigia-splat:20261121-221309`):

| Incidente | Flotantes antes de limpiar → después | Bajo el suelo después | Resultado |
|---|---|---|---|
| VG-6CP6 (1 video) | 1,5 % → 0,01 % | 0,36 % | OK |
| VG-EFU4 (2 videos, uno descartado) | 35 % → 0,08 % | 0,21 % | OK |
| VG-2ND6 (9 cuadros) | 0,6 % → 0,00 % | 0,52 % | OK |
| VG-79KV (teléfono + dron) | 25 % → 5,5 % | 0,08 % | falla: islas grandes que la limpieza no toca (la escena principal tiene 47 %) |
| VG-ZKW8 (3 videos, uno descartado) | 42 % → 21 % | 1,25 % | falla: escena muy fragmentada (principal 24 %) |

Las que fallan son salas grabadas con pocas vistas, personas caminando (dejan «fantasmas») y ventanales: el mensaje final avisa que hay que revisar la escena. Los incidentes de demostración con cuadros SVG no se pueden reconstruir. La vista previa (`preview.jpg`) se dibuja antes de la limpieza: para ver lo que quedó usa `--png` de las pruebas.
