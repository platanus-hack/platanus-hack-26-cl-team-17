"""Reporte de progreso al servidor: POST callback_url con un ReconstructionUpdate (domain.ts).

Respuesta esperada: {"ok": true, "cancel": boolean}. Con cancel=true el job se detiene.
Si el callback falla (red, 4xx/5xx, URL inexistente) se registra y el job sigue.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Callable

MESSAGE_MAX = 400
ERROR_MAX = 1000
TIMEOUT_S = 10.0
# Durante el entrenamiento se reporta cada ~5 % del avance de esa etapa.
TRAINING_REPORT_STEP = 0.05


class Cancelled(Exception):
    """El puesto de mando pidió cancelar la reconstrucción."""


PostFn = Callable[[str, dict[str, Any], str], dict[str, Any] | None]


def http_post(url: str, body: dict[str, Any], token: str) -> dict[str, Any] | None:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Authorization": f"Bearer {token}",
            "User-Agent": "vigia-splat-job/1",
        },
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        raw = resp.read()
    try:
        parsed = json.loads(raw.decode("utf-8")) if raw else None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _log(msg: str, err: bool = False) -> None:
    print(f"[splat] {msg}", file=sys.stderr if err else sys.stdout, flush=True)


class Reporter:
    def __init__(
        self,
        callback_url: str,
        token: str,
        reconstruction_id: str,
        gpu: str | None,
        started_at: float | None = None,
        post: PostFn = http_post,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.url = callback_url
        self.token = token
        self.reconstruction_id = reconstruction_id
        self.gpu = gpu
        self.clock = clock
        self.started_at = clock() if started_at is None else started_at
        self.post = post
        self.progress = 0.0
        self.failures = 0
        self.sent = 0
        self.last: dict[str, Any] | None = None
        self._last_training_fraction = -1.0

    def gpu_seconds(self) -> float:
        return round(max(0.0, self.clock() - self.started_at), 1)

    def send(self, status: str, progress: float, message: str, *, final: bool = False, **fields: Any) -> None:
        """Envía una actualización. Lanza Cancelled si el servidor lo pide (salvo en la final)."""
        self.progress = max(0.0, min(1.0, float(progress)))
        body: dict[str, Any] = {
            "reconstruction_id": self.reconstruction_id,
            "status": status,
            "progress": round(self.progress, 4),
            "message": message[:MESSAGE_MAX],
            "gpu": self.gpu,
            "gpu_seconds": self.gpu_seconds(),
        }
        for k, v in fields.items():
            if v is not None or k in ("error", "transform"):
                body[k] = v
        if isinstance(body.get("error"), str):
            body["error"] = body["error"][:ERROR_MAX]
        self.last = body
        _log(f"{status} {self.progress:.0%} · {message}")
        if not self.url:
            return
        try:
            resp = self.post(self.url, body, self.token)
            self.sent += 1
        except (urllib.error.URLError, OSError, ValueError) as e:
            self.failures += 1
            _log(f"callback falló ({type(e).__name__}: {e}); el job sigue", err=True)
            return
        if not final and resp is not None and resp.get("cancel") is True:
            raise Cancelled()

    def training(self, step: int, total: int, base: float, span: float, message: str, **fields: Any) -> None:
        """Avance del entrenamiento: solo se envía cada TRAINING_REPORT_STEP (y en el último paso)."""
        fraction = step / max(1, total)
        if step < total and fraction - self._last_training_fraction < TRAINING_REPORT_STEP:
            return
        self._last_training_fraction = fraction
        self.send("training", base + span * fraction, message, **fields)

    def fail(self, error: str, **fields: Any) -> None:
        self.send("failed", self.progress, error[:MESSAGE_MAX], final=True, error=error, **fields)
