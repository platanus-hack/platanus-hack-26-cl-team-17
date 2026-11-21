# Detector de objetos de Vigía

Servicio HTTP local que corre YOLOE-26 (YOLO de vocabulario abierto) en CPU con onnxruntime. El
servidor Next le manda cuadros (de videos de vecinos o del dron en vivo) y recibe detecciones en
JSON y, si se pide, el cuadro anotado. Opus razona después sobre ese texto y un solo cuadro anotado
en vez de ver el video entero.

- `vocab.py`: el vocabulario (prompt en inglés → etiqueta en español). Único lugar donde se define.
- `export.py`: descarga pesos, fija el vocabulario y exporta los ONNX a `models/` (usa torch).
- `server.py`: el servidor (solo onnxruntime + numpy + opencv-headless; no importa torch).
- `test_server.py`: pruebas del contrato HTTP y de la heurística de pose.

`models/` y `.venv/` no se versionan.

## Instalar

```bash
cd vigia/detector
uv venv --python 3.14 .venv          # 3.12 también sirve

# Solo runtime (Jetson, Cloud Run o si ya tienes los ONNX):
uv pip install --python .venv/bin/python -r requirements.txt

# Para exportar (torch solo CPU, sin CUDA):
uv pip install --python .venv/bin/python --index-url https://download.pytorch.org/whl/cpu torch torchvision
uv pip install --python .venv/bin/python -r requirements-export.txt
```

## Exportar los modelos

```bash
.venv/bin/python export.py            # YOLOE-26s + pose; --size n para el modelo nano, --no-pose sin pose
```

Deja en `models/`: `vigia-yoloe-26s.onnx` + `.json` (etiquetas en orden y forma de la salida),
`yolo26n-pose.onnx`, los `.pt`, `mobileclip2_b.ts` (codificador de texto, ~254 MB, solo para
exportar) y `bus.jpg` para probar. Hay que volver a exportar si cambia `vocab.py`. La exportación
carga torch y CLIP (más de 1 GB de RAM): no la corras junto a otros procesos pesados.

## Correr

```bash
.venv/bin/python server.py                                    # http://127.0.0.1:8765
VIGIA_DETECTOR_PORT=8766 VIGIA_DETECTOR_HOST=0.0.0.0 .venv/bin/python server.py
nohup .venv/bin/python server.py > server.log 2>&1 &          # en segundo plano
```

Variables: `VIGIA_DETECTOR_HOST` (127.0.0.1), `VIGIA_DETECTOR_PORT` (8765), `VIGIA_DETECTOR_MODEL`
(ruta a otro ONNX de YOLOE), `VIGIA_DETECTOR_POSE=0` (sin modelo de pose),
`VIGIA_DETECTOR_THREADS` (hilos de onnxruntime, 4).

## Probar

```bash
curl -s localhost:8765/health
curl -s --data-binary @models/bus.jpg -H 'Content-Type: image/jpeg' 'localhost:8765/detect?annotate=1' \
  | .venv/bin/python -c "import sys,json,base64; d=json.load(sys.stdin); open('models/check.jpg','wb').write(base64.b64decode(d.pop('annotated_jpeg_b64'))); print(json.dumps(d, ensure_ascii=False, indent=1))"

.venv/bin/python -m unittest test_server -v                   # levanta su propio servidor en un puerto libre
VIGIA_DETECTOR_URL=http://127.0.0.1:8765 .venv/bin/python -m unittest test_server -v   # contra uno ya corriendo
```

## Contrato

- `GET /health` → `{"ok": true, "model": "yoloe-26s-seg", "labels": [...], "input": 640, "pose": true}`
- `POST /detect`: cuerpo = JPEG o PNG crudo, máx. 8 MB. Query: `annotate=1`, `conf=0.25`, `max_side=1280`.
  Respuesta: `width`, `height`, `ms`, `detections` (máx. 100, por confianza descendente; cada una con
  `label`, `conf`, `box` normalizada `[x1, y1, x2, y2]`, `zone` `{h, v}` por tercios y `pose`
  `tendido`/`de_pie`/`null` solo para persona), `counts` y, con `annotate=1`, `annotated_jpeg_b64`.
- Errores en JSON `{"error": "..."}`: 400 (imagen ilegible, cuerpo vacío, parámetro inválido), 413 (más de 8 MB),
  404/405; un fallo interno responde 500 también con JSON.

## Notas

- Cada prompt es una clase del ONNX; el servidor junta los sinónimos bajo su etiqueta y fusiona cajas
  casi iguales dentro de un mismo grupo (persona/bombero, vehículos), quedándose con la de más confianza.
- Pose: se corre `yolo26n-pose` solo si hay personas. Si el eje hombros/caderas → tobillos/rodillas está a
  menos de 35° de la horizontal la persona está `tendido`; a más de 55°, `de_pie`. Sin keypoints útiles se
  usa la caja (ancho > 1,3 × alto → tendido; alto > 1,5 × ancho → de pie; si no, `null`).
- Las inferencias se serializan con un candado: peticiones simultáneas esperan su turno en vez de
  competir por la CPU.
- En CPU (Intel Core 9 270H, 4 hilos) un cuadro de 1280×720 con personas tarda ~95 ms (YOLOE-26s + pose).
- YOLOE con prompts de texto es fuerte en persona y vehículos, pero da puntajes bajos (< 0,25) a conceptos
  como fuego tras árboles, humo saliendo de una ventana, ventanas o escaleras. Si importa la sensibilidad
  para peligros, el cliente puede pedir `conf=0.1` y filtrar por etiqueta.
