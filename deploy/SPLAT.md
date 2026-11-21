# Job de GPU `vigia-splat` (3D Gaussian Splatting)

Reconstruye la escena real de un incidente a partir de todos sus videos y cuadros (vecinos + dron) y deja un `scene.splat` que el visor de la app muestra en el mapa.

- **Dónde:** Cloud Run jobs, `projects/platanus-515411/locations/us-central1/jobs/vigia-splat`, 1 GPU `nvidia-rtx-pro-6000` (96 GB, Blackwell sm_120), 20 vCPU / 80 GiB (el mínimo de esa GPU), sin reintentos, timeout 45 min. Si no hay cuota de esa GPU: `GPU_TYPE=nvidia-l4` (8 vCPU / 32 GiB). La imagen trae los kernels para los dos tipos de GPU.
- **Imagen:** `us-central1-docker.pkg.dev/platanus-515411/vigia/vigia-splat` (CUDA 12.8, PyTorch 2.10 cu128, gsplat compilado para sm_89 y sm_120, ffmpeg, pesos de VGGT-1B incluidos). Se construye con Cloud Build: esta máquina no necesita GPU.
- **Cuentas:** el job corre como `vigia-splat@…` (`roles/storage.objectUser` solo sobre `gs://platanus-515411-vigia-evidencia`). La app (`vigia-run@…`) tiene `roles/run.jobsExecutorWithOverrides` y `roles/run.viewer` solo sobre este job.

## Qué hace (gpu/splat/splat/main.py)
1. Lee el manifiesto (`SplatManifest` de `src/lib/contract.ts`) desde `SPLAT_MANIFEST_URI` y reporta cada etapa a `callback_url` con `Authorization: Bearer $SPLAT_CALLBACK_TOKEN` (`preparing` → `posing` → `training` cada ~5 % → `exporting` → `ready`/`failed`). Si el callback falla, registra el error y sigue; si responde `cancel: true`, termina en `failed` con "Cancelada".
2. Descarga los videos (o los cuadros ya extraídos), muestrea a `sample_fps`, descarta los cuadros movidos (nitidez bajo el 25 % del percentil 90 de su medio, dejando al menos la mitad) y reparte `max_frames` entre los medios, prefiriendo los cuadros más nítidos.
3. **Cámaras:** VGGT (Meta, CVPR 2025), feed-forward, sin COLMAP, **una pasada por medio** (cada video o set de fotos por separado; el modelo se carga una vez). Estima cámaras y profundidad en segundos. Código bajo la VGGT License; los pesos `facebook/VGGT-1B` son **CC BY-NC 4.0 (uso no comercial)**. Para uso comercial cambia a `facebook/VGGT-1B-Commercial` (`VGGT_REPO` en el Dockerfile; requiere aprobación en Hugging Face).
4. **Unión de medios y bundle adjustment** (`register.py`, CPU salvo el emparejamiento): puntos SIFT, coincidencias entre vecinos de cada medio y entre una muestra de cuadros de medios distintos, verificadas con una matriz fundamental (MAGSAC). Entre dos medios, las coincidencias con profundidad de VGGT dan pares de puntos 3D → similitud robusta (RANSAC + Umeyama). Los medios se unen por un árbol de expansión máximo; **los que no se conectan con el grupo principal quedan fuera** (y el mensaje lo dice) en vez de duplicar muebles. Después, bundle adjustment global (Levenberg–Marquardt con complemento de Schur, pérdida de Huber, poses + puntos + una focal por medio) y escala de profundidad por cuadro; se descartan los cuadros con error de reproyección alto. Si el ajuste empeora el error, se revierte; si el registro falla, se sigue con el medio más grande.
5. **Entrenamiento:** gsplat (Apache-2.0), `DefaultStrategy` con gradiente absoluto (AbsGS, `grow_grad2d` 0,0008), hasta `iterations` pasos (30.000 por defecto), con ajuste fino de cámaras y de exposición por imagen. Nube inicial: profundidad de VGGT de cada cuadro con su escala corregida, sin puntos aislados, más los puntos del bundle adjustment. El calendario (decaimiento de la tasa de aprendizaje, fin de la densificación a la mitad) sigue el avance por pasos o por tiempo, lo que vaya primero: con `SPLAT_TIME_BUDGET_S` (el timeout de la tarea, lo pone `splat-job.sh`) termina con 4 min de margen y exporta lo entrenado en vez de cortarse.
6. **Alineación al ENU local** (x Este, y Norte, z arriba, origen en el incidente): con ≥ 3 posiciones GPS distintas y separadas (dron por cuadro, teléfono una por video) → Umeyama (similitud), `alignment: "gps"`, `scale_known: true`; si no → vertical estimada desde las cámaras y escala arbitraria, `alignment: "approximate"`, `scale_known: false`. Los gaussianos se exportan ya en ENU (`transform` = identidad).
7. Exporta `scene.splat` (formato de antimatter15, 32 bytes por gaussiana, ordenado por importancia, máximo 1,5 M) sin las gaussianas fuera de la caja de la escena (fondo, cielo, flotantes) ni las desmesuradas, más `preview.jpg` y `result.json` (con `dropped_media` y `bundle_adjusted`) en `output_prefix`.

**Qué grabar para un buen resultado:** caminar alrededor de lo que importa (girar en el lugar no da profundidad), lento, con exposición y enfoque bloqueados; si son varios videos, que se solapen bastante (idealmente cada uno empieza donde termina otro). Superficies lisas, vidrios y espejos salen mal.

La reconstrucción solo muestra lo estático: personas o vehículos en movimiento no quedan. El mensaje final lo advierte ("no la uses para descartar víctimas").

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
La imagen está construida y el job está guardado con su GPU, cuentas y permisos, pero **Cloud Run no lo deja en "Ready"**: `Project failed to initialize in this region due to quota exceeded`. No es la cuota de GPU (la de RTX PRO 6000 sin redundancia zonal en us-central1 es 3): el uso de la cuota `MaxRegionsPerProject` ("Number of regions that Cloud Run has been used in") marca 5 de 5 en cada intento. Ya hay una solicitud para subirla a 8 (concedido 5, en revisión). Cuando se resuelva, corre `SKIP_BUILD=1 CONFIRM=1 bash deploy/splat-job.sh` y luego la prueba de arriba. Mientras tanto la app muestra la vista sintética rotulada como tal (`backend: "demo"`).
