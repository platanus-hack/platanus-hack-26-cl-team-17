"""Pruebas del servicio de detección (contrato HTTP + heurística de pose).

Por defecto levanta el servidor dentro del mismo proceso en un puerto libre. Para probar uno que ya
está corriendo:  VIGIA_DETECTOR_URL=http://127.0.0.1:8765 .venv/bin/python -m unittest test_server -v

Necesita los modelos exportados (export.py) y models/bus.jpg.
"""

from __future__ import annotations

import base64
import json
import os
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import cv2
import numpy as np

import server

BUS = server.MODELS / "bus.jpg"
ZONAS_H = {"izquierda", "centro", "derecha"}
ZONAS_V = {"alto", "medio", "bajo"}


def setUpModule() -> None:
    global BASE, _srv
    if not BUS.exists():
        raise unittest.SkipTest("Falta models/bus.jpg: corre export.py")
    _srv = None
    BASE = os.environ.get("VIGIA_DETECTOR_URL", "").rstrip("/")
    if BASE:
        return
    server.Handler.detector = server.Detector(server.elegir_modelo(), True, 4)
    _srv = server.Servidor(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=_srv.serve_forever, daemon=True).start()
    BASE = f"http://127.0.0.1:{_srv.server_address[1]}"


def tearDownModule() -> None:
    if _srv is not None:
        _srv.shutdown()
        _srv.server_close()


def pedir(method: str, path: str, body: bytes | None = None, ctype: str = "image/jpeg") -> tuple[int, dict]:
    req = urllib.request.Request(BASE + path, data=body, method=method)
    if body is not None:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            status, raw, tipo = r.status, r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        with e:
            status, raw, tipo = e.code, e.read(), e.headers.get("Content-Type", "")
    assert tipo.startswith("application/json"), f"respuesta sin JSON ({status}, {tipo})"
    return status, json.loads(raw)


class Contrato(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.bus = BUS.read_bytes()
        cls.labels = pedir("GET", "/health")[1]["labels"]

    def validar_respuesta(self, d: dict, w: int, h: int) -> None:
        self.assertEqual((d["width"], d["height"]), (w, h))
        self.assertIsInstance(d["width"], int)
        self.assertIsInstance(d["ms"], float)
        dets = d["detections"]
        self.assertLessEqual(len(dets), 100)
        confs = [x["conf"] for x in dets]
        self.assertEqual(confs, sorted(confs, reverse=True), "no vienen ordenadas por confianza")
        counts: dict[str, int] = {}
        for x in dets:
            self.assertEqual(set(x), {"label", "conf", "box", "zone", "pose"})
            self.assertIn(x["label"], self.labels)
            self.assertTrue(0 <= x["conf"] <= 1)
            x1, y1, x2, y2 = x["box"]
            self.assertTrue(0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1, x["box"])
            self.assertIn(x["zone"]["h"], ZONAS_H)
            self.assertIn(x["zone"]["v"], ZONAS_V)
            if x["label"] == "persona":
                self.assertIn(x["pose"], ("tendido", "de_pie", None))
            else:
                self.assertIsNone(x["pose"])
            counts[x["label"]] = counts.get(x["label"], 0) + 1
        self.assertEqual(d["counts"], counts)

    def test_health(self) -> None:
        status, d = pedir("GET", "/health")
        self.assertEqual(status, 200)
        self.assertIs(d["ok"], True)
        self.assertIsInstance(d["model"], str)
        self.assertIn("persona", d["labels"])
        self.assertIn("bus", d["labels"])
        self.assertEqual(d["input"], 640)
        self.assertIsInstance(d["pose"], bool)

    def test_bus_persona_y_bus(self) -> None:
        status, d = pedir("POST", "/detect", self.bus)
        self.assertEqual(status, 200)
        self.validar_respuesta(d, 810, 1080)
        self.assertNotIn("annotated_jpeg_b64", d)
        self.assertGreaterEqual(d["counts"].get("persona", 0), 1)
        self.assertGreaterEqual(d["counts"].get("bus", 0), 1)
        bus = next(x for x in d["detections"] if x["label"] == "bus")
        self.assertGreater(bus["box"][2] - bus["box"][0], 0.8, "el bus ocupa casi todo el ancho")
        de_pie = [x for x in d["detections"] if x["label"] == "persona" and x["pose"] == "de_pie"]
        self.assertGreaterEqual(len(de_pie), 1, "las personas de bus.jpg están de pie")

    def test_anotada(self) -> None:
        status, d = pedir("POST", "/detect?annotate=1&max_side=640", self.bus)
        self.assertEqual(status, 200)
        self.validar_respuesta(d, 810, 1080)
        jpg = base64.b64decode(d["annotated_jpeg_b64"])
        self.assertEqual(jpg[:2], b"\xff\xd8")
        img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(max(img.shape[:2]), 640)

    def test_png_y_conf(self) -> None:
        img = cv2.imdecode(np.frombuffer(self.bus, np.uint8), cv2.IMREAD_COLOR)
        ok, png = cv2.imencode(".png", img)
        self.assertTrue(ok)
        status, d = pedir("POST", "/detect?conf=0.8", png.tobytes(), "image/png")
        self.assertEqual(status, 200)
        self.validar_respuesta(d, 810, 1080)
        self.assertTrue(all(x["conf"] >= 0.8 for x in d["detections"]))

    def test_imagen_sintetica_sin_objetos(self) -> None:
        img = np.full((720, 1280, 3), 127, np.uint8)
        ok, jpg = cv2.imencode(".jpg", img)
        status, d = pedir("POST", "/detect", jpg.tobytes())
        self.assertEqual(status, 200)
        self.validar_respuesta(d, 1280, 720)
        self.assertEqual(d["detections"], [])
        self.assertEqual(d["counts"], {})

    def test_errores(self) -> None:
        status, d = pedir("POST", "/detect", b"esto no es una imagen")
        self.assertEqual(status, 400)
        self.assertIsInstance(d["error"], str)
        status, d = pedir("POST", "/detect", b"")
        self.assertEqual(status, 400)
        status, d = pedir("POST", "/detect?conf=abc", self.bus)
        self.assertEqual(status, 400)
        status, d = pedir("POST", "/detect", b"\xff" * (8 * 1024 * 1024 + 1))
        self.assertEqual(status, 413)
        self.assertIn("8 MB", d["error"])
        status, d = pedir("GET", "/nada")
        self.assertEqual(status, 404)
        self.assertIn("error", d)


class HeuristicaPose(unittest.TestCase):
    @staticmethod
    def kpts(hombros_y: float, tobillos_y: float, hombros_x: float, tobillos_x: float) -> np.ndarray:
        k = np.zeros((17, 3), np.float32)
        for i in (5, 6):
            k[i] = (hombros_x, hombros_y, 0.9)
        for i in (15, 16):
            k[i] = (tobillos_x, tobillos_y, 0.9)
        return k

    def test_keypoints(self) -> None:
        self.assertEqual(server._pose_por_keypoints(self.kpts(100, 300, 50, 55)), "de_pie")
        self.assertEqual(server._pose_por_keypoints(self.kpts(200, 215, 50, 250)), "tendido")
        self.assertIsNone(server._pose_por_keypoints(np.zeros((17, 3), np.float32)))

    def test_caja(self) -> None:
        self.assertEqual(server._pose_por_caja(200, 80), "tendido")
        self.assertEqual(server._pose_por_caja(60, 200), "de_pie")
        self.assertIsNone(server._pose_por_caja(100, 110))


if __name__ == "__main__":
    unittest.main(verbosity=2)
