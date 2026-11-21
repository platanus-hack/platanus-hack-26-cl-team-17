"""Servicio HTTP de detección de objetos para Vigía (YOLOE-26 + pose, en CPU con onnxruntime).

Lo llama el servidor Next cuadro a cuadro (videos de vecinos y video en vivo del dron). Solo usa
onnxruntime, numpy y opencv-headless: nada de torch ni ultralytics (ver export.py para eso).

Contrato:
  GET  /health  -> {"ok", "model", "labels", "input", "pose"}
  POST /detect  cuerpo = JPEG/PNG crudo (máx. 8 MB). Query: annotate=1, conf=0.25, max_side=1280
                -> {"width", "height", "ms", "detections", "counts", ["annotated_jpeg_b64"]}

Variables de entorno:
  VIGIA_DETECTOR_HOST (127.0.0.1)  VIGIA_DETECTOR_PORT (8765)
  VIGIA_DETECTOR_MODEL   ruta al ONNX de YOLOE (por defecto models/vigia-yoloe-26s.onnx, si no, -26n)
  VIGIA_DETECTOR_POSE    0 para no cargar el modelo de pose
  VIGIA_DETECTOR_THREADS hilos intra-op de onnxruntime (4)
"""

from __future__ import annotations

import base64
import json
import math
import os
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# numpy y OpenCV crean por defecto un hilo por núcleo (20 aquí); este servicio no los necesita.
for _var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402

cv2.setNumThreads(2)

HERE = Path(__file__).resolve().parent
MODELS = HERE / "models"
sys.path.insert(0, str(HERE))

from vocab import DESTACADAS, GRUPOS  # noqa: E402

MAX_BODY = 8 * 1024 * 1024
MAX_DETECTIONS = 100
POSE_CONF = 0.25  # umbral de las personas del modelo de pose
KPT_CONF = 0.5  # umbral de visibilidad de un keypoint
POSE_IOU = 0.45  # superposición mínima para asociar una persona de YOLOE con una del modelo de pose
GROUP_IOU = 0.7  # superposición a partir de la cual dos cajas del mismo grupo son el mismo objeto

# Colores BGR. Las etiquetas destacadas tienen color propio y trazo grueso.
COLORES = {
    "persona": (0, 230, 255),  # amarillo
    "fuego": (0, 0, 255),  # rojo
    "humo": (255, 0, 200),  # magenta
    "cilindro_gas": (0, 140, 255),  # naranjo
    "cable_caido": (255, 255, 0),  # cian
}
COLOR_RESTO = (190, 150, 90)


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)


class ErrorPeticion(Exception):
    """Error que se devuelve al cliente con su código HTTP y un mensaje en español."""

    def __init__(self, status: int, mensaje: str):
        super().__init__(mensaje)
        self.status = status
        self.mensaje = mensaje


def _sesion(path: Path, threads: int) -> ort.InferenceSession:
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    # Sin espera activa entre llamadas: el servicio convive con muchos otros procesos.
    so.add_session_config_entry("session.intra_op.allow_spinning", "0")
    return ort.InferenceSession(str(path), sess_options=so, providers=["CPUExecutionProvider"])


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _zona(box: list[float]) -> dict:
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    h = "izquierda" if cx < 1 / 3 else "centro" if cx < 2 / 3 else "derecha"
    v = "alto" if cy < 1 / 3 else "medio" if cy < 2 / 3 else "bajo"
    return {"h": h, "v": v}


def _pose_por_caja(w: float, h: float) -> str | None:
    """Heurística de respaldo cuando no hay keypoints útiles."""
    if w > 1.3 * h:
        return "tendido"
    if h > 1.5 * w:
        return "de_pie"
    return None


def _pose_por_keypoints(kpts: np.ndarray) -> str | None:
    """kpts (17, 3) en orden COCO. Compara la altura de hombros/caderas con la de tobillos/rodillas.

    Si el eje del cuerpo (de hombros o caderas a tobillos o rodillas) está más cerca de la horizontal
    que de la vertical, la persona está tendida.
    """
    vis = kpts[:, 2] >= KPT_CONF

    def media(idx: tuple[int, ...]) -> np.ndarray | None:
        sel = [i for i in idx if vis[i]]
        return kpts[sel, :2].mean(axis=0) if sel else None

    arriba = media((5, 6))  # hombros
    if arriba is None:
        arriba = media((11, 12))  # caderas
    abajo = media((15, 16))  # tobillos
    if abajo is None:
        abajo = media((13, 14))  # rodillas
    if abajo is None and arriba is not None and media((5, 6)) is not None:
        abajo = media((11, 12))  # solo torso: hombros -> caderas
    if arriba is None or abajo is None:
        return None
    dx, dy = abs(abajo[0] - arriba[0]), abs(abajo[1] - arriba[1])
    if math.hypot(dx, dy) < 8:  # puntos casi superpuestos (persona muy chica o vista cenital)
        return None
    angulo = math.degrees(math.atan2(dy, dx))  # 0 = horizontal, 90 = vertical
    if angulo < 35:
        return "tendido"
    if angulo > 55:
        return "de_pie"
    return None


class Detector:
    def __init__(self, model_path: Path, use_pose: bool, threads: int):
        meta = json.loads(model_path.with_suffix(".json").read_text())
        self.model_name: str = meta["model"]
        self.input: int = int(meta["input"])
        self.labels: list[str] = list(meta["labels"])
        self.class_labels: list[str] = [c["label"] for c in meta["classes"]]
        self.sess = _sesion(model_path, threads)
        self.in_name = self.sess.get_inputs()[0].name
        out_shape = self.sess.get_outputs()[0].shape
        if len(out_shape) != 3 or out_shape[2] < 6:
            raise RuntimeError(f"Salida inesperada del ONNX de YOLOE: {out_shape}")

        grupo_de = {lab: i for i, g in enumerate(GRUPOS) for lab in g}
        self.grupo = [grupo_de.get(lab, 1000 + self.labels.index(lab)) for lab in self.class_labels]

        self.pose_sess = None
        pose_path = MODELS / "yolo26n-pose.onnx"
        if use_pose and pose_path.exists():
            self.pose_sess = _sesion(pose_path, threads)
            self.pose_in = self.pose_sess.get_inputs()[0].name
            if self.pose_sess.get_inputs()[0].shape[2:] != [self.input, self.input]:
                raise RuntimeError("El modelo de pose debe tener la misma entrada que YOLOE")
        # onnxruntime es seguro entre hilos, pero dos inferencias simultáneas con 4 hilos cada una
        # solo compiten por la CPU: se serializan.
        self.lock = threading.Lock()
        self._calentar()

    def _calentar(self) -> None:
        x = np.zeros((1, 3, self.input, self.input), np.float32)
        self.sess.run(None, {self.in_name: x})
        if self.pose_sess is not None:
            self.pose_sess.run(None, {self.pose_in: x})

    def _letterbox(self, img: np.ndarray) -> tuple[np.ndarray, float, float, float]:
        h, w = img.shape[:2]
        s = self.input
        r = min(s / h, s / w)
        nw, nh = round(w * r), round(h * r)
        px, py = (s - nw) / 2, (s - nh) / 2
        if (nw, nh) != (w, h):
            img = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
        top, left = round(py - 0.1), round(px - 0.1)
        out = cv2.copyMakeBorder(
            img, top, s - nh - top, left, s - nw - left, cv2.BORDER_CONSTANT, value=(114, 114, 114)
        )
        # BGR HWC uint8 -> RGB CHW float32 en [0, 1], con eje de lote: (1, 3, s, s)
        blob = np.ascontiguousarray(out[:, :, ::-1].transpose(2, 0, 1))[None].astype(np.float32) / 255.0
        return blob, r, left, top

    def detect(self, img: np.ndarray, conf: float) -> list[dict]:
        h, w = img.shape[:2]
        blob, r, left, top = self._letterbox(img)
        with self.lock:
            pred = self.sess.run(None, {self.in_name: blob})[0][0]  # (300, 6 + 32)
        pred = pred[pred[:, 4] >= conf]
        pred = pred[np.argsort(-pred[:, 4])]

        # Pasar cajas a píxeles de la imagen original.
        boxes = pred[:, :4].copy()
        boxes[:, [0, 2]] = (boxes[:, [0, 2]] - left) / r
        boxes[:, [1, 3]] = (boxes[:, [1, 3]] - top) / r
        boxes[:, [0, 2]] = boxes[:, [0, 2]].clip(0, w)
        boxes[:, [1, 3]] = boxes[:, [1, 3]].clip(0, h)

        # La cabeza e2e no repite cajas dentro de una clase, pero sí entre clases: sinónimos de una
        # misma etiqueta o etiquetas del mismo grupo (persona/bombero, vehículos). Gana la de mayor conf.
        kept: list[int] = []
        for i in range(len(pred)):
            b = boxes[i]
            if b[2] - b[0] < 1 or b[3] - b[1] < 1:
                continue
            g = self.grupo[int(pred[i, 5])]
            if any(self.grupo[int(pred[j, 5])] == g and _iou(boxes[j], b) > GROUP_IOU for j in kept):
                continue
            kept.append(i)
            if len(kept) >= MAX_DETECTIONS:
                break

        dets = []
        for i in kept:
            x1, y1, x2, y2 = (float(v) for v in boxes[i])
            box = [round(x1 / w, 4), round(y1 / h, 4), round(x2 / w, 4), round(y2 / h, 4)]
            dets.append(
                {
                    "label": self.class_labels[int(pred[i, 5])],
                    "conf": round(float(pred[i, 4]), 3),
                    "box": box,
                    "zone": _zona(box),
                    "pose": None,
                    "_px": (x1, y1, x2, y2),
                }
            )

        personas = [d for d in dets if d["label"] == "persona"]
        if personas:
            self._asignar_pose(personas, blob, r, left, top)
        for d in dets:
            del d["_px"]
        return dets

    def _asignar_pose(self, personas: list[dict], blob: np.ndarray, r: float, left: float, top: float) -> None:
        cand = np.zeros((0, 57), np.float32)
        if self.pose_sess is not None:
            with self.lock:
                out = self.pose_sess.run(None, {self.pose_in: blob})[0][0]  # (300, 6 + 17*3)
            cand = out[out[:, 4] >= POSE_CONF].copy()
            cand[:, [0, 2]] = (cand[:, [0, 2]] - left) / r
            cand[:, [1, 3]] = (cand[:, [1, 3]] - top) / r
            cand[:, 6::3] = (cand[:, 6::3] - left) / r
            cand[:, 7::3] = (cand[:, 7::3] - top) / r
        usados: set[int] = set()
        for d in personas:  # ya vienen ordenadas por confianza
            x1, y1, x2, y2 = d["_px"]
            caja = np.array([x1, y1, x2, y2], np.float32)
            mejor, mejor_iou = -1, POSE_IOU
            for j in range(len(cand)):
                if j in usados:
                    continue
                iou = _iou(caja, cand[j, :4])
                if iou >= mejor_iou:
                    mejor, mejor_iou = j, iou
            pose = None
            if mejor >= 0:
                usados.add(mejor)
                pose = _pose_por_keypoints(cand[mejor, 6:].reshape(17, 3))
            d["pose"] = pose or _pose_por_caja(x2 - x1, y2 - y1)


def anotar(img: np.ndarray, dets: list[dict], max_side: int) -> str:
    h, w = img.shape[:2]
    s = min(1.0, max_side / max(h, w))
    if s < 1.0:
        img = cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
    else:
        img = img.copy()
    h, w = img.shape[:2]
    base = max(1, round(max(h, w) / 640))
    font_scale = 0.45 * base
    # Primero las no destacadas, para que las importantes queden encima.
    for d in sorted(dets, key=lambda d: (d["label"] in DESTACADAS, d["conf"])):
        x1, y1, x2, y2 = d["box"]
        p1 = (round(x1 * w), round(y1 * h))
        p2 = (round(x2 * w), round(y2 * h))
        destacada = d["label"] in DESTACADAS
        color = COLORES.get(d["label"], COLOR_RESTO)
        grosor = base * (3 if destacada else 1)
        cv2.rectangle(img, p1, p2, color, grosor, cv2.LINE_AA)
        texto = f"{d['label']} {round(d['conf'] * 100)}%"
        if d.get("pose") == "tendido":
            texto += " TENDIDO"
        (tw, th), bl = cv2.getTextSize(texto, cv2.FONT_HERSHEY_SIMPLEX, font_scale, base)
        ty = p1[1] - 2 if p1[1] - th - bl - 2 >= 0 else p1[1] + th + bl + 2
        tx = max(0, min(p1[0], w - tw - 3))  # que la etiqueta no se salga por la derecha
        cv2.rectangle(img, (tx, ty - th - bl), (tx + tw + 2, ty + bl // 2), color, -1)
        cv2.putText(img, texto, (tx + 1, ty - bl // 2), cv2.FONT_HERSHEY_SIMPLEX, font_scale,
                    (0, 0, 0), base, cv2.LINE_AA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
    if not ok:
        raise RuntimeError("No se pudo codificar la imagen anotada")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def _param_float(qs: dict, name: str, default: float, lo: float, hi: float) -> float:
    if name not in qs:
        return default
    try:
        v = float(qs[name][-1])
    except ValueError:
        raise ErrorPeticion(400, f"El parámetro '{name}' debe ser un número") from None
    if not math.isfinite(v):
        raise ErrorPeticion(400, f"El parámetro '{name}' debe ser un número")
    return min(hi, max(lo, v))


class Handler(BaseHTTPRequestHandler):
    server_version = "VigiaDetector/1.0"
    protocol_version = "HTTP/1.1"
    detector: Detector  # se asigna en main()

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        pass  # cada petición se registra en _responder

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _responder(self, fn) -> None:
        t0 = time.perf_counter()
        status, extra = 500, ""
        try:
            status, payload, extra = fn()
        except ErrorPeticion as e:
            status, payload = e.status, {"error": e.mensaje}
        except Exception as e:  # nunca un 500 sin JSON
            status, payload = 500, {"error": f"Error interno del detector: {type(e).__name__}: {e}"}
            log(f"ERROR {self.command} {self.path}: {e!r}")
        try:
            self._json(status, payload)
        except (BrokenPipeError, ConnectionResetError):
            return
        log(f"{self.command} {self.path} -> {status} {(time.perf_counter() - t0) * 1000:.0f} ms {extra}")

    def _leer_cuerpo(self) -> bytes:
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            partes, total = [], 0
            while True:
                linea = self.rfile.readline(1024)
                try:
                    n = int(linea.split(b";")[0].strip() or b"0", 16)
                except ValueError:
                    self.close_connection = True
                    raise ErrorPeticion(400, "Cuerpo chunked mal formado") from None
                if n == 0:
                    while self.rfile.readline(1024) not in (b"\r\n", b"\n", b""):
                        pass
                    break
                total += n
                if total > MAX_BODY:
                    self.close_connection = True
                    raise ErrorPeticion(413, "La imagen supera el máximo de 8 MB")
                partes.append(self.rfile.read(n))
                self.rfile.readline(1024)
            return b"".join(partes)
        largo = self.headers.get("Content-Length")
        if largo is None:
            self.close_connection = True
            raise ErrorPeticion(400, "Falta el cuerpo de la petición (Content-Length)")
        try:
            n = int(largo)
        except ValueError:
            self.close_connection = True
            raise ErrorPeticion(400, "Content-Length inválido") from None
        if n > MAX_BODY:
            # Se descarta lo enviado (hasta un límite) para que el cliente alcance a leer la respuesta.
            restante = min(n, 64 * 1024 * 1024)
            while restante > 0:
                trozo = self.rfile.read(min(restante, 1 << 20))
                if not trozo:
                    break
                restante -= len(trozo)
            self.close_connection = True
            raise ErrorPeticion(413, "La imagen supera el máximo de 8 MB")
        return self.rfile.read(n) if n > 0 else b""

    def do_GET(self) -> None:  # noqa: N802
        def fn():
            if urlparse(self.path).path != "/health":
                raise ErrorPeticion(404, "Ruta no encontrada")
            d = self.detector
            return 200, {
                "ok": True,
                "model": d.model_name,
                "labels": d.labels,
                "input": d.input,
                "pose": d.pose_sess is not None,
            }, ""

        self._responder(fn)

    def do_POST(self) -> None:  # noqa: N802
        def fn():
            url = urlparse(self.path)
            if url.path != "/detect":
                self._descartar_cuerpo()
                raise ErrorPeticion(404, "Ruta no encontrada")
            datos = self._leer_cuerpo()
            qs = parse_qs(url.query)
            conf = _param_float(qs, "conf", 0.25, 0.01, 1.0)
            max_side = int(_param_float(qs, "max_side", 1280, 64, 4096))
            annotate = qs.get("annotate", ["0"])[-1].lower() in ("1", "true", "si", "sí", "yes")
            if not datos:
                raise ErrorPeticion(400, "El cuerpo está vacío: envía la imagen JPEG o PNG cruda")

            t0 = time.perf_counter()
            img = cv2.imdecode(np.frombuffer(datos, np.uint8), cv2.IMREAD_COLOR)
            if img is None or img.size == 0:
                raise ErrorPeticion(400, "No se pudo leer la imagen: envía un JPEG o PNG válido")
            h, w = img.shape[:2]
            dets = self.detector.detect(img, conf)
            counts: dict[str, int] = {}
            for d in dets:
                counts[d["label"]] = counts.get(d["label"], 0) + 1
            payload = {"width": w, "height": h, "ms": 0.0, "detections": dets, "counts": counts}
            if annotate:
                payload["annotated_jpeg_b64"] = anotar(img, dets, max_side)
            payload["ms"] = round((time.perf_counter() - t0) * 1000, 1)
            return 200, payload, f"{w}x{h} {len(dets)} det"

        self._responder(fn)

    def _descartar_cuerpo(self) -> None:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if 0 < n <= MAX_BODY:
            self.rfile.read(n)
        elif n:
            self.close_connection = True

    def _no_permitido(self) -> None:
        self._descartar_cuerpo()

        def fn():
            raise ErrorPeticion(405, "Método no permitido")

        self._responder(fn)

    do_PUT = do_DELETE = do_PATCH = _no_permitido


class Servidor(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def elegir_modelo() -> Path:
    env = os.environ.get("VIGIA_DETECTOR_MODEL")
    if env:
        return Path(env).resolve()
    for nombre in ("vigia-yoloe-26s.onnx", "vigia-yoloe-26n.onnx"):
        if (MODELS / nombre).exists():
            return MODELS / nombre
    raise SystemExit("No hay modelo en detector/models/. Corre primero: .venv/bin/python export.py")


def main() -> None:
    host = os.environ.get("VIGIA_DETECTOR_HOST", "127.0.0.1")
    port = int(os.environ.get("VIGIA_DETECTOR_PORT", "8765"))
    threads = int(os.environ.get("VIGIA_DETECTOR_THREADS", "4"))
    use_pose = os.environ.get("VIGIA_DETECTOR_POSE", "1") not in ("0", "false", "no")
    t0 = time.perf_counter()
    Handler.detector = Detector(elegir_modelo(), use_pose, threads)
    d = Handler.detector
    log(f"modelo {d.model_name} ({len(d.class_labels)} clases, {len(d.labels)} etiquetas), "
        f"pose={'sí' if d.pose_sess else 'no'}, hilos={threads}, cargado en {time.perf_counter() - t0:.1f} s")
    srv = Servidor((host, port), Handler)
    log(f"escuchando en http://{host}:{port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
