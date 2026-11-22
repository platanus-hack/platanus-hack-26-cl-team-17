"""Servidor HTTP de la reconstrucción 3D en vivo (contrato en LIVE3D.md). Solo biblioteca estándar.

    PORT=8080 python -m splat.live3d_server              # VGGT en GPU (imagen de Cloud Run)
    LIVE3D_FAKE=1 PORT=8790 python -m splat.live3d_server # motor simulado, sin GPU (desarrollo)

El servidor responde de inmediato (Cloud Run exige que escuche pronto); el modelo se carga en el
hilo de GPU y /health dice `ready: false` hasta que está listo. Los cuadros que llegan antes se
guardan igual y se procesan al terminar la carga.
"""

from __future__ import annotations

import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .live3d import FakeEstimator, Manager

MAX_BODY = 3 * 1024 * 1024
SID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
ROUTE = re.compile(r"^/sessions/([^/]+)/(frames|status|points|reset)$")


def log(msg: str) -> None:
    print(msg, file=sys.stdout, flush=True)


def build_manager() -> Manager:
    if os.environ.get("LIVE3D_FAKE") == "1":
        return Manager(lambda: FakeEstimator(), "fake", log)
    weights = os.environ.get("VGGT_WEIGHTS", "/opt/models/vggt/model.safetensors")

    def make():
        from .live3d import VGGTEstimator

        return VGGTEstimator(weights)

    return Manager(make, "vggt", log)


MANAGER: Manager | None = None


class Handler(BaseHTTPRequestHandler):
    server_version = "vigia-live3d/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - firma de la clase base
        pass  # sin una línea por cuadro

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj: object) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode(), "application/json")

    def _route(self) -> tuple[str, str, dict[str, list[str]]] | None:
        url = urlparse(self.path)
        m = ROUTE.match(url.path)
        if not m or not SID.match(m.group(1)):
            return None
        return m.group(1), m.group(2), parse_qs(url.query)

    def do_GET(self) -> None:  # noqa: N802
        mgr = MANAGER
        assert mgr is not None
        if urlparse(self.path).path in ("/health", "/"):
            self._json(
                200,
                {
                    "ok": mgr.error is None,
                    "ready": mgr.ready,
                    "engine": mgr.engine,
                    "gpu": mgr.gpu,
                    "sessions": len(mgr.sessions),
                    "error": mgr.error,
                },
            )
            return
        r = self._route()
        if r is None or r[1] not in ("status", "points"):
            self._json(404, {"error": "ruta desconocida"})
            return
        sid, kind, q = r
        s = mgr.session(sid, create=False)
        if s is None:
            self._json(404, {"error": "sesión desconocida"})
            return
        if kind == "status":
            self._json(200, s.status(mgr.ready))
            return
        try:
            start = int(q.get("from", ["0"])[0])
            mx = min(16, max(1, int(q.get("max", ["8"])[0])))
        except ValueError:
            self._json(400, {"error": "from y max deben ser enteros"})
            return
        self._send(200, s.points(start, mx), "application/octet-stream")

    def do_POST(self) -> None:  # noqa: N802
        mgr = MANAGER
        assert mgr is not None
        r = self._route()
        if r is None or r[1] not in ("frames", "reset"):
            self._json(404, {"error": "ruta desconocida"})
            return
        sid, kind, _q = r
        length = int(self.headers.get("content-length") or 0)
        if length > MAX_BODY:
            self._json(413, {"error": "cuadro demasiado grande"})
            return
        body = self.rfile.read(length) if length > 0 else b""
        if kind == "reset":
            mgr.reset(sid)
            self._json(200, {"ok": True})
            return
        if len(body) < 4 or body[:2] != b"\xff\xd8":
            self._json(400, {"error": "el cuerpo debe ser un JPEG"})
            return
        s = mgr.session(sid, create=True)
        assert s is not None
        ack = s.add_frame(body)
        if ack["accepted"]:
            mgr.wake.set()
        self._json(202, ack)


def main() -> None:
    global MANAGER
    MANAGER = build_manager()
    MANAGER.start()
    port = int(os.environ.get("PORT", "8080"))
    host = os.environ.get("HOST", "0.0.0.0")
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    log(f"[live3d] escuchando en {host}:{port} (motor {MANAGER.engine})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
