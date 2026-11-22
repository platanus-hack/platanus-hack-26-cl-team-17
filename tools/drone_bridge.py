#!/usr/bin/env python3
"""Puente entre un dron (o una fuente que lo imita) y Vigía.

Envía telemetría cada pocos segundos y cuadros JPEG a la misión creada en el
puesto de mando, y obedece las órdenes que vuelven en cada respuesta
(RETORNAR / ABORTAR). Solo usa la biblioteca estándar de Python 3.

Fuentes (elige una):
  --simulate           órbita sintética alrededor de --lat/--lng (sin cámara).
  --video ARCHIVO      reproduce un video (ideal: un video aéreo real) y envía un
                       cuadro cada --every segundos al ritmo de reproducción;
                       la posición es la órbita sintética. Requiere ffmpeg.
  --mavlink CONEXIÓN   lee posición y batería de un dron MAVLink (pymavlink).
                       REFERENCIA NO PROBADA CON HARDWARE: revísala antes de volar.
  --rtmp [ESCUCHA]     servidor RTMP local para DJI Fly (Transmisión en vivo → RTMP):
                       manda video en vivo (~8 cuadros/s) y un cuadro cada --every
                       segundos a análisis. DJI Fly no entrega telemetría por RTMP: la
                       posición es la órbita sintética. Requiere ffmpeg.
  --stream URL         igual que --rtmp, pero lee el video de una URL (RTSP, RTMP, SRT…),
                       p. ej. la de un servidor MediaMTX.

Modo automático: --rtmp o --stream sin --mission/--token. El puente entra con una cuenta del
personal (VIGIA_EMAIL / VIGIA_PASSWORD, o las pregunta), despliega el dron en la emergencia
abierta más nueva y se cambia solo cuando se crea otra.

Ejemplos:
  python3 tools/drone_bridge.py --url https://vigia.example --mission ID --token TOKEN --simulate --lat -33.4569 --lng -70.5987
  python3 tools/drone_bridge.py --url http://localhost:3000 --mission ID --token TOKEN --video aereo.mp4 --lat -33.4569 --lng -70.5987
  python3 tools/drone_bridge.py --url https://vigia.example --mission ID --token TOKEN --rtmp --lat -33.4569 --lng -70.5987
  python3 tools/drone_bridge.py --url https://vigia.example --rtmp
"""

from __future__ import annotations

import argparse
import getpass
import http.client
import json
import math
import os
import queue
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import BinaryIO, Callable

EARTH_R = 6_371_000.0
TELEMETRY_EVERY_S = 2.0
MAX_FRAME_BYTES = 3_000_000
USER_AGENT = "vigia-drone-bridge/1"

# Video en vivo (--rtmp / --stream). Tamaños iguales a los del teléfono sensor (LIMITS en domain.ts).
DEFAULT_RTMP = "rtmp://0.0.0.0:1935/live/dron"
LIVE_LONG_EDGE = 640
LIVE_MAX_BYTES = 400_000
# El servidor acepta hasta 600 cuadros por minuto por misión.
LIVE_MAX_FPS = 10.0
LIVE_TIMEOUT_S = 8.0
LIVE_RETRY_S = 2.0
# Con el stream abierto pero sin cuadros por este tiempo, ffmpeg se reinicia (el teléfono perdió la red).
LIVE_STALL_S = 15.0
LIVE_REPORT_S = 10.0


class Fatal(Exception):
    """Error que no se arregla reintentando (token inválido, misión terminada)."""


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


_LOG_LOCK = threading.Lock()


def log(msg: str) -> None:
    # Con lock: varios hilos escriben (recepción del video, envío y bucle principal).
    with _LOG_LOCK:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ───────────────────────── Geodesia ─────────────────────────


def destination(lat: float, lng: float, bearing_deg: float, dist_m: float) -> tuple[float, float]:
    b = math.radians(bearing_deg)
    dy = math.cos(b) * dist_m
    dx = math.sin(b) * dist_m
    return (
        lat + math.degrees(dy / EARTH_R),
        lng + math.degrees(dx / (EARTH_R * math.cos(math.radians(lat)))),
    )


def bearing(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def distance(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    s = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(s)))


# ───────────────────────── Cliente HTTP ─────────────────────────


class Client:
    def __init__(self, base_url: str, mission: str, token: str) -> None:
        self.base = base_url.rstrip("/")
        self.mission = urllib.parse.quote(mission, safe="")
        self.token = token

    def _send(self, path: str, body: bytes, content_type: str) -> dict:
        req = urllib.request.Request(
            f"{self.base}/api/drone/{self.mission}/{path}",
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": content_type,
                "User-Agent": USER_AGENT,
            },
        )
        delay = 1.0
        for attempt in range(1, 6):
            try:
                with urllib.request.urlopen(req, timeout=30) as res:
                    return json.loads(res.read().decode("utf-8") or "{}")
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", "replace")[:300]
                if e.code == 401:
                    raise Fatal("El servidor rechazó el token (401). Revisa --mission y --token.") from e
                if e.code == 409:
                    raise Fatal(f"La misión ya no acepta datos (409): {detail}") from e
                if e.code in (400, 413):
                    raise Fatal(f"Solicitud rechazada ({e.code}): {detail}") from e
                log(f"Error {e.code} del servidor (intento {attempt}/5): {detail}")
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                log(f"Sin conexión con el servidor (intento {attempt}/5): {e}")
            time.sleep(delay)
            delay = min(delay * 2, 15)
        raise ConnectionError("El servidor no respondió tras 5 intentos.")

    def telemetry(self, points: list[dict], status: str | None = None) -> dict:
        payload: dict = {"points": points}
        if status:
            payload["status"] = status
        return self._send("telemetry", json.dumps(payload).encode("utf-8"), "application/json")

    def frame(self, jpeg: bytes, pos: dict, flush: bool = False) -> dict:
        q = urllib.parse.urlencode(
            {
                "lat": f"{pos['lat']:.7f}",
                "lng": f"{pos['lng']:.7f}",
                "alt": f"{pos['alt_m']:.1f}",
                "heading": f"{pos['heading_deg']:.1f}",
                "t": pos["at"],
                "flush": "1" if flush else "0",
            }
        )
        return self._send(f"frame?{q}", jpeg, "image/jpeg")


# ───────────────────────── Vuelo sintético ─────────────────────────


@dataclass
class SyntheticFlight:
    """Despega ~300 m al sur, vuela a la órbita, orbita mirando al centro y vuelve si se lo piden."""

    lat: float
    lng: float
    radius_m: float = 60.0
    alt_m: float = 45.0
    speed_ms: float = 8.0
    # False con un dron real (--rtmp/--stream): la batería no se conoce, no se inventa ni fuerza el retorno.
    synthetic_battery: bool = True
    phase: str = "launching"
    battery: float = 100.0
    pos: tuple[float, float] = field(default=(0.0, 0.0))
    alt: float = 0.0
    heading: float = 0.0
    speed: float = 0.0
    home: tuple[float, float] = field(default=(0.0, 0.0))

    def __post_init__(self) -> None:
        self.home = destination(self.lat, self.lng, 180, 300)
        self.pos = self.home
        self.heading = bearing(*self.home, self.lat, self.lng)

    def _fly_to(self, target: tuple[float, float], dt: float) -> bool:
        d = distance(*self.pos, *target)
        step = self.speed_ms * dt
        self.heading = bearing(*self.pos, *target) if d > 0.5 else self.heading
        if d <= step:
            self.pos = target
            self.speed = d / dt if dt > 0 else 0
            return True
        self.pos = destination(*self.pos, self.heading, step)
        self.speed = self.speed_ms
        return False

    def step(self, dt: float) -> None:
        if self.phase in ("landed", "aborted"):
            self.speed = 0
            return
        if self.synthetic_battery and (self.alt > 0 or self.phase == "launching"):
            self.battery = max(0.0, self.battery - dt / 20.0)
        if self.phase == "launching":
            self.speed = 0
            self.alt = min(self.alt_m, self.alt + 3 * dt)
            if self.alt >= self.alt_m:
                self.phase = "en_route"
        elif self.phase == "en_route":
            entry = destination(self.lat, self.lng, bearing(self.lat, self.lng, *self.home), self.radius_m)
            if self._fly_to(entry, dt):
                self.phase = "on_station"
        elif self.phase == "on_station":
            ang = bearing(self.lat, self.lng, *self.pos) + math.degrees(self.speed_ms * dt / self.radius_m)
            self.pos = destination(self.lat, self.lng, ang, self.radius_m)
            self.heading = bearing(*self.pos, self.lat, self.lng)
            self.speed = self.speed_ms
            if self.battery < 25:
                log(f"Batería {self.battery:.0f} %: retornando.")
                self.phase = "returning"
        elif self.phase == "returning":
            if self._fly_to(self.home, dt):
                self.speed = 0
                self.alt = max(0.0, self.alt - 2 * dt)
                if self.alt <= 0:
                    self.phase = "landed"

    def point(self) -> dict:
        return {
            "at": iso_now(),
            "lat": round(self.pos[0], 7),
            "lng": round(self.pos[1], 7),
            "alt_m": round(self.alt, 1),
            "heading_deg": round(self.heading % 360, 1),
            "speed_ms": round(self.speed, 1),
            "battery_pct": round(self.battery, 1) if self.synthetic_battery else None,
        }


# ───────────────────────── Video con ffmpeg ─────────────────────────


def scale_to(long_edge: int) -> str:
    """Filtro de ffmpeg que deja el lado mayor en `long_edge` px y conserva la proporción."""
    return f"scale='if(gt(iw,ih),{long_edge},-2)':'if(gt(iw,ih),-2,{long_edge})'"


def read_jpegs(stream: BinaryIO, on_frame: Callable[[bytes], None], stop: threading.Event | None = None) -> None:
    """Separa las imágenes del MJPEG que escribe ffmpeg hasta que se cierre la salida.

    El MJPEG de ffmpeg no trae miniaturas: cada imagen va de FF D8 a FF D9. Se lee con
    read1 para entregar cada cuadro apenas llega (read(n) esperaría a juntar n bytes).
    """
    buf = b""
    while stop is None or not stop.is_set():
        chunk = stream.read1(65536)
        if not chunk:
            return
        buf += chunk
        while True:
            start = buf.find(b"\xff\xd8")
            end = buf.find(b"\xff\xd9", start + 2) if start >= 0 else -1
            if start < 0 or end < 0:
                break
            on_frame(buf[start : end + 2])
            buf = buf[end + 2 :]


def video_frames(path: str, every_s: float, ffmpeg: str, out: "queue.Queue[bytes | None]", stop: threading.Event) -> None:
    """Extrae un JPEG cada `every_s` segundos al ritmo de reproducción (-re) con lado mayor 1280."""
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-re", "-i", path,
        "-vf", f"fps=1/{every_s},{scale_to(1280)}", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4", "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        assert proc.stdout is not None
        read_jpegs(proc.stdout, out.put, stop)
    finally:
        if proc.poll() is None:
            proc.terminate()
        err = proc.stderr.read().decode("utf-8", "replace").strip() if proc.stderr else ""
        proc.wait()
        if proc.returncode not in (0, None, -15) and err:
            log(f"ffmpeg terminó con error: {err[:300]}")
        out.put(None)


# ───────────────────────── Video en vivo (--rtmp / --stream) ─────────────────────────


class LiveSender:
    """Manda a /live siempre el cuadro más nuevo, de a uno, por una conexión que queda abierta.

    Si la red se pone lenta bajan los cuadros por segundo en vez de acumularse: lo que llega
    mientras hay un envío en curso reemplaza al cuadro pendiente. La misión de destino se
    puede cambiar con set_target (modo automático); sin destino, los cuadros se descartan.
    """

    def __init__(self, base_url: str, stop: threading.Event, keep_going: bool = False) -> None:
        u = urllib.parse.urlsplit(base_url.rstrip("/"))
        self.https = u.scheme == "https"
        self.host = u.hostname or "localhost"
        self.port = u.port
        self._base_path = u.path
        self.stop = stop
        # Con keep_going (modo automático) un rechazo de la misión no detiene el video: se
        # avisa en `lost` y se espera el próximo set_target.
        self.keep_going = keep_going
        self.ended = False
        self.lost: str | None = None
        self._cond = threading.Condition()
        self._latest: bytes | None = None
        self._mission: str | None = None
        self._target: tuple[str, dict[str, str]] | None = None
        self._conn: http.client.HTTPConnection | None = None
        self._lock = threading.Lock()
        self._sent: deque[tuple[float, int, float]] = deque()  # (instante, bytes, ms del envío)
        self._errors = 0
        self._last_error = ""

    def set_target(self, mission: str | None, token: str | None) -> None:
        with self._cond:
            self._mission = mission
            self._target = None
            if mission and token:
                path = f"{self._base_path}/api/drone/{urllib.parse.quote(mission, safe='')}/live"
                headers = {"Authorization": f"Bearer {token}", "Content-Type": "image/jpeg", "User-Agent": USER_AGENT}
                self._target = (path, headers)
            self.lost = None

    def offer(self, jpeg: bytes) -> None:
        with self._cond:
            self._latest = jpeg
            self._cond.notify()

    def _post(self, target: tuple[str, dict[str, str]], jpeg: bytes) -> tuple[int, str]:
        if self._conn is None:
            cls = http.client.HTTPSConnection if self.https else http.client.HTTPConnection
            self._conn = cls(self.host, self.port, timeout=LIVE_TIMEOUT_S)
        self._conn.request("POST", target[0], body=jpeg, headers=target[1])
        res = self._conn.getresponse()
        body = res.read().decode("utf-8", "replace")
        return res.status, body[:300]

    def _fail(self, msg: str) -> None:
        with self._lock:
            self._errors += 1
            self._last_error = msg

    def run(self) -> None:
        # El primer error después de un envío bueno suele ser la conexión inactiva que el
        # servidor ya cerró: se reintenta de inmediato con una nueva.
        retry_now = True
        while not self.stop.is_set():
            with self._cond:
                while self._latest is None and not self.stop.is_set():
                    self._cond.wait(0.5)
                jpeg, self._latest = self._latest, None
                target, mission = self._target, self._mission
            if jpeg is None:
                break
            if target is None:
                continue
            if len(jpeg) > LIVE_MAX_BYTES:
                self._fail(f"cuadro de {len(jpeg) // 1000} KB descartado (máximo {LIVE_MAX_BYTES // 1000} KB)")
                continue
            t0 = time.monotonic()
            try:
                status, detail = self._post(target, jpeg)
            except (OSError, http.client.HTTPException) as e:
                if self._conn is not None:
                    self._conn.close()
                    self._conn = None
                self._fail(f"sin conexión ({e.__class__.__name__}: {e})")
                if not retry_now:
                    self.stop.wait(LIVE_RETRY_S)
                retry_now = False
                continue
            if 200 <= status < 300:
                retry_now = True
                with self._lock:
                    self._sent.append((time.monotonic(), len(jpeg), (time.monotonic() - t0) * 1000))
                continue
            retry_now = False
            if status in (401, 404, 409):
                why = {401: "token rechazado", 404: "la misión no existe", 409: "la misión terminó"}[status]
                log(f"Video en vivo detenido ({status}, {why}): {detail}")
                if not self.keep_going:
                    self.ended = True
                    return
                with self._cond:
                    if self._mission == mission:
                        self._target = None
                        self.lost = mission
                continue
            self._fail(f"{status}: {detail}")
            self.stop.wait(1.0 if status == 429 else LIVE_RETRY_S)

    def report(self) -> str:
        """Resumen de los últimos LIVE_REPORT_S segundos (y reinicia el contador de errores)."""
        now = time.monotonic()
        with self._lock:
            while self._sent and now - self._sent[0][0] > LIVE_REPORT_S:
                self._sent.popleft()
            sent = list(self._sent)
            errors, last_error = self._errors, self._last_error
            self._errors = 0
        if self._target is None:
            return "En vivo: llega video, pero no hay una emergencia abierta a la que mandarlo."
        if sent:
            ms = sorted(m for _, _, m in sent)[len(sent) // 2]
            kb = sum(b for _, b, _ in sent) / len(sent) / 1000
            msg = f"En vivo: {len(sent) / LIVE_REPORT_S:.1f} cuadros/s a Vigía · {kb:.0f} KB por cuadro · {ms:.0f} ms por envío"
        else:
            msg = f"En vivo: ningún cuadro llegó a Vigía en los últimos {LIVE_REPORT_S:g} s"
        if errors:
            msg += f" · {errors} errores (último: {last_error})"
        return msg


def lan_ip() -> str | None:
    """IP de este computador en la red local (la de la interfaz con la ruta por defecto)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))  # UDP sin enviar nada: solo elige la interfaz de salida
            return s.getsockname()[0]
    except OSError:
        return None


def dji_url(listen_url: str) -> str:
    """La URL que se escribe en DJI Fly: la de escucha con la IP local en vez de 0.0.0.0."""
    u = urllib.parse.urlsplit(listen_url)
    if u.hostname not in (None, "", "0.0.0.0", "::"):
        return listen_url
    host = lan_ip() or "<IP-de-este-computador>"
    return urllib.parse.urlunsplit((u.scheme, f"{host}:{u.port or 1935}", u.path, "", ""))


# ffmpeg en curso de live_source: main() los termina al salir por cualquier camino, para que
# ninguno quede vivo ocupando el puerto RTMP.
_CHILDREN: set[subprocess.Popen] = set()


def _keep_lines(stream: BinaryIO, keep: "deque[str]") -> None:
    """Vacía stderr de ffmpeg (si se llena, ffmpeg se bloquea) y guarda las últimas líneas."""
    for raw in iter(stream.readline, b""):
        line = raw.decode("utf-8", "replace").strip()
        if line and not line.startswith("Last message repeated"):
            keep.append(line)


def live_source(
    url: str,
    listen: bool,
    fps: float,
    every_s: float,
    ffmpeg: str,
    sender: LiveSender,
    frames: "queue.Queue[bytes | None]",
    stop: threading.Event,
) -> None:
    """Recibe el stream con ffmpeg (como servidor RTMP si `listen`) y lo reparte en dos salidas.

    - stdout: cuadros de 640 px a `fps` → video en vivo (`sender`).
    - un pipe aparte: un cuadro de 1280 px cada `every_s` s → `frames` (lotes de análisis);
      sin esta salida si every_s es 0.
    Si el stream se corta, deja b"" en `frames` (cierra el lote en curso) y vuelve a esperar.
    """
    backoff = 1.0
    waiting_shown = False
    while not stop.is_set() and not sender.ended:
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-fflags", "nobuffer", "-flags", "low_delay"]
        # Sin esto, un stream sin audio tarda ~6 s en partir: ffmpeg espera un audio que nunca llega.
        cmd += ["-probesize", "500000", "-analyzeduration", "1000000"]
        if listen:
            cmd += ["-listen", "1"]
        elif url.startswith("rtsp"):
            cmd += ["-rtsp_transport", "tcp"]
        cmd += [
            "-i", url,
            "-map", "0:v:0", "-vf", f"fps={fps:g},{scale_to(LIVE_LONG_EDGE)}",
            "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "6", "pipe:1",
        ]
        big_r = big_w = None
        if every_s > 0:
            big_r, big_w = os.pipe()
            cmd += [
                "-map", "0:v:0", "-vf", f"fps=1/{every_s:g},{scale_to(1280)}",
                "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", f"pipe:{big_w}",
            ]
        if listen and not waiting_shown:
            log(f"Servidor RTMP escuchando. En DJI Fly (Transmisión en vivo → RTMP) usa:  {dji_url(url)}")
            waiting_shown = True
        elif not listen and not waiting_shown:
            log(f"Esperando el video en {url} (se abre solo cuando DJI Fly empiece a transmitir) …")
            waiting_shown = True
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(big_w,) if big_w is not None else (),
        )
        _CHILDREN.add(proc)
        if big_w is not None:
            os.close(big_w)
        got = {"count": 0, "last": 0.0}

        def on_live(jpeg: bytes) -> None:
            got["count"] += 1
            got["last"] = time.monotonic()
            sender.offer(jpeg)

        assert proc.stdout is not None and proc.stderr is not None
        errs: deque[str] = deque(maxlen=5)
        big = os.fdopen(big_r, "rb") if big_r is not None else None
        readers = [
            threading.Thread(target=read_jpegs, args=(proc.stdout, on_live), daemon=True),
            threading.Thread(target=_keep_lines, args=(proc.stderr, errs), daemon=True),
        ]
        if big is not None:
            readers.append(threading.Thread(target=read_jpegs, args=(big, frames.put), daemon=True))
        for t in readers:
            t.start()

        connected = False
        next_report = 0.0
        while proc.poll() is None and not stop.is_set() and not sender.ended:
            stop.wait(1.0)
            now = time.monotonic()
            if got["count"] and not connected:
                connected = True
                backoff = 1.0
                next_report = now + LIVE_REPORT_S
                log("Llega video: transmitiendo en vivo a Vigía.")
            if connected and now - got["last"] > LIVE_STALL_S:
                log(f"Sin cuadros hace {LIVE_STALL_S:g} s con el stream abierto: se reinicia la recepción.")
                proc.kill()
                break
            if connected and now >= next_report:
                next_report = now + LIVE_REPORT_S
                log(sender.report())

        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        _CHILDREN.discard(proc)
        for t in readers:
            t.join(timeout=3)
        for f in (proc.stdout, proc.stderr, big):
            if f is not None:
                f.close()
        if stop.is_set() or sender.ended:
            return
        detail = errs[-1] if errs else f"ffmpeg salió con código {proc.returncode}"
        if connected:
            log(f"El stream se cortó ({detail}). Esperando que vuelva …")
            frames.put(b"")
            waiting_shown = False
            stop.wait(1.0)
        else:
            # Falló sin recibir video (puerto ocupado, URL que no responde…): espera creciente.
            # Un 404 de MediaMTX solo significa que DJI Fly todavía no transmite: no se repite.
            if "404" not in detail:
                log(f"No llegó video: {detail}. Reintento en {backoff:g} s.")
            stop.wait(backoff)
            # Como servidor, no dejar el puerto cerrado mucho rato: DJI Fly reintenta solo.
            backoff = min(backoff * 2, 3.0 if listen else 5.0)


# ───────────────────────── MAVLink (referencia) ─────────────────────────


def run_mavlink(client: Client, conn: str, stop: threading.Event) -> int:
    try:
        from pymavlink import mavutil  # type: ignore[import-not-found]
    except ImportError:
        log("Falta pymavlink: instálalo con  python3 -m pip install pymavlink")
        return 2
    log(f"Conectando a {conn} … (referencia NO probada con hardware)")
    master = mavutil.mavlink_connection(conn)
    master.wait_heartbeat(timeout=30)
    log(f"Latido recibido del sistema {master.target_system}.")
    pos: dict | None = None
    battery: float | None = None
    obeyed = "continue"
    last_sent = 0.0
    while not stop.is_set():
        msg = master.recv_match(type=["GLOBAL_POSITION_INT", "SYS_STATUS"], blocking=True, timeout=1)
        if msg is not None and msg.get_type() == "GLOBAL_POSITION_INT":
            vx, vy = msg.vx / 100.0, msg.vy / 100.0
            pos = {
                "at": iso_now(),
                "lat": msg.lat / 1e7,
                "lng": msg.lon / 1e7,
                "alt_m": msg.relative_alt / 1000.0,
                "heading_deg": (msg.hdg / 100.0) if msg.hdg != 65535 else 0.0,
                "speed_ms": round(math.hypot(vx, vy), 1),
            }
        elif msg is not None and msg.get_type() == "SYS_STATUS" and msg.battery_remaining >= 0:
            battery = float(msg.battery_remaining)
        if pos and time.monotonic() - last_sent >= TELEMETRY_EVERY_S:
            last_sent = time.monotonic()
            res = client.telemetry([{**pos, "battery_pct": battery}])
            cmd = res.get("command", "continue")
            if cmd != obeyed:
                # recall → volver a casa (RTL); abort → aterrizar donde está (LAND).
                mode = "RTL" if cmd == "recall" else "LAND" if cmd == "abort" else None
                if mode and mode in master.mode_mapping():
                    master.set_mode(master.mode_mapping()[mode])
                    log(f"Orden del mando: {cmd.upper()} → modo {mode}.")
                obeyed = cmd
            if res.get("status") in ("landed", "aborted"):
                log("La misión terminó en el puesto de mando.")
                return 0
    return 0


# ───────────────────────── Bucle principal ─────────────────────────


def fly(
    client: Client,
    flight: SyntheticFlight,
    frames: "queue.Queue[bytes | None]",
    stop: threading.Event,
    has_video: bool,
    leave: Callable[[], bool] | None = None,
) -> str:
    """Una misión: telemetría cada 2 s, órdenes del mando (RETORNAR/ABORTAR) y cuadros de análisis.

    Devuelve por qué terminó: "stop" (Ctrl+C), "ended" (aterrizó o el mando abortó) o "leave"
    (`leave()` pidió salir; en modo automático, porque hay una emergencia más nueva). Al salir
    cierra el lote de análisis en curso, salvo que el mando haya abortado.
    """
    video_done = not has_video
    held: bytes | None = None
    sent_frames = 0

    def send_frame(jpeg: bytes, flush: bool = False) -> None:
        nonlocal sent_frames
        try:
            res = client.frame(jpeg, flight.point(), flush=flush)
        except ConnectionError as e:
            log(f"Cuadro de análisis perdido: {e}")
            return
        sent_frames += 1
        if res.get("flushed"):
            log(f"Lote cerrado ({res.get('media_id')}) y enviado a análisis.")

    last = time.monotonic()
    reported = None
    command = "continue"
    reason = "stop"
    while not stop.is_set():
        now = time.monotonic()
        flight.step(now - last)
        last = now
        if command == "abort":
            flight.phase = "aborted"
        elif command == "recall" and flight.phase in ("launching", "en_route", "on_station"):
            flight.phase = "returning"
        elif command == "continue" and flight.phase == "returning" and flight.battery >= 25:
            flight.phase = "en_route"
        status = flight.phase if flight.phase != reported else None
        try:
            res = client.telemetry([flight.point()], status)
        except ConnectionError as e:
            # Sin red el dron sigue volando: se reintenta en el próximo ciclo.
            log(f"{e} Se reintenta en {TELEMETRY_EVERY_S:g} s.")
            stop.wait(TELEMETRY_EVERY_S)
            continue
        reported = flight.phase
        new_cmd = res.get("command", "continue")
        if new_cmd != command:
            log(f"Orden del mando: {new_cmd.upper()}")
            command = new_cmd
        if flight.phase in ("landed", "aborted"):
            log("Dron en tierra." if flight.phase == "landed" else "Misión abortada.")
            reason = "ended"
            break

        # Cuadros: se retiene uno para poder marcar el último con flush=1 al terminar el video.
        while not video_done:
            try:
                item = frames.get_nowait()
            except queue.Empty:
                break
            if item is None:
                video_done = True
                if held is not None:
                    send_frame(held, flush=True)
                    held = None
                log(f"Fin del video: {sent_frames} cuadros enviados.")
                break
            if item == b"":
                # El stream en vivo se cortó: se cierra el lote con lo que haya.
                if held is not None:
                    send_frame(held, flush=True)
                    held = None
                continue
            if len(item) > MAX_FRAME_BYTES:
                log("Cuadro de más de 3 MB descartado.")
                continue
            if held is not None and flight.phase in ("on_station", "en_route", "returning"):
                send_frame(held)
            held = item
        if leave is not None and leave():
            reason = "leave"
            break
        stop.wait(TELEMETRY_EVERY_S)

    if held is not None and command != "abort":
        try:
            send_frame(held, flush=True)
        except Fatal as e:
            log(f"No se pudo cerrar el último lote: {e}")
    return reason


def start_live(
    args: argparse.Namespace, stop: threading.Event, frames: "queue.Queue[bytes | None]", keep_going: bool = False
) -> LiveSender:
    """Arranca la recepción del stream (ffmpeg) y el envío del video en vivo; devuelve el emisor."""
    ffmpeg = shutil.which(args.ffmpeg) or args.ffmpeg
    sender = LiveSender(args.url, stop, keep_going=keep_going)
    threading.Thread(target=sender.run, daemon=True).start()
    threading.Thread(
        target=live_source,
        args=(args.rtmp or args.stream, args.rtmp is not None, args.live_fps, args.every, ffmpeg, sender, frames, stop),
        daemon=True,
    ).start()
    lots = f"un cuadro cada {args.every:g} s a análisis" if args.every > 0 else "sin lotes de análisis"
    log(f"Video en vivo a {args.live_fps:g} cuadros/s, {lots}. Posición: órbita sintética (DJI Fly no la entrega).")
    return sender


def run_synthetic(client: Client, args: argparse.Namespace, stop: threading.Event) -> int:
    live_url = args.rtmp or args.stream
    flight = SyntheticFlight(args.lat, args.lng, args.radius, args.alt, args.speed, synthetic_battery=not live_url)
    frames: "queue.Queue[bytes | None]" = queue.Queue()
    if args.video:
        ffmpeg = shutil.which(args.ffmpeg) or args.ffmpeg
        threading.Thread(target=video_frames, args=(args.video, args.every, ffmpeg, frames, stop), daemon=True).start()
        log(f"Reproduciendo {args.video}: un cuadro cada {args.every:g} s.")
    elif live_url:
        start_live(args, stop, frames).set_target(args.mission, args.token)
    else:
        log("Modo simulado: solo telemetría, sin cámara.")

    if fly(client, flight, frames, stop, has_video=bool(args.video or live_url)) != "stop":
        return 0
    if live_url:
        # Un dron real no aterriza porque se detuvo el puente (igual que --mavlink).
        log("La misión sigue abierta: vuelve a ejecutar el mismo comando para retomar el video, "
            "o termínala desde el puesto de mando.")
        return 0
    try:
        # Fuente sintética detenida a mano: se informa aterrizaje para cerrar la misión.
        flight.alt, flight.speed = 0.0, 0.0
        client.telemetry([flight.point()], "landed")
        log("Se informó aterrizaje al puesto de mando.")
    except (Fatal, ConnectionError) as e:
        log(f"No se pudo cerrar la misión limpiamente: {e}")
    return 0


# ───────────────────────── Modo automático (--rtmp/--stream sin --mission) ─────────────────────────

AUTO_CHECK_S = 10.0
SAVED_PATH = os.path.join(os.path.expanduser("~"), ".cache", "vigia", "drone-bridge.json")


def _error_message(body: dict) -> str:
    err = body.get("error")
    return str(err) if err else json.dumps(body)[:200]


class VigiaAccount:
    """Sesión del personal en Vigía: lee las emergencias abiertas y despliega el dron en la más nueva.

    Sin base de datos (modo local abierto) no hace falta cuenta. Con cuentas usa VIGIA_EMAIL y
    VIGIA_PASSWORD, o las pregunta en la terminal; si la sesión vence, vuelve a entrar sola.
    """

    def __init__(self, base_url: str) -> None:
        self.base = base_url.rstrip("/")
        self.email = os.environ.get("VIGIA_EMAIL", "").strip()
        self.password = os.environ.get("VIGIA_PASSWORD", "")
        self.cookie: str | None = None

    def _open(self, method: str, path: str, payload: dict | None) -> tuple[int, dict, list[str]]:
        req = urllib.request.Request(
            self.base + path,
            data=None if payload is None else json.dumps(payload).encode("utf-8"),
            method=method,
            headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        )
        if self.cookie:
            req.add_header("Cookie", self.cookie)
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                return res.status, json.loads(res.read() or b"{}"), res.headers.get_all("Set-Cookie") or []
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read() or b"{}")
            except ValueError:
                body = {}
            return e.code, body if isinstance(body, dict) else {}, []
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            raise ConnectionError(f"Sin conexión con Vigía: {e}") from e

    def _call(self, method: str, path: str, payload: dict | None = None) -> dict:
        status, body, _ = self._open(method, path, payload)
        if status == 401:
            self.login()
            status, body, _ = self._open(method, path, payload)
        if 200 <= status < 300:
            return body
        if status >= 500 or status == 429:
            raise ConnectionError(f"Vigía respondió {status}: {_error_message(body)}")
        raise Fatal(f"Vigía respondió {status} a {method} {path}: {_error_message(body)}")

    def login(self) -> None:
        if not (self.email and self.password):
            if not sys.stdin.isatty():
                raise Fatal("Vigía pide una cuenta del personal: define VIGIA_EMAIL y VIGIA_PASSWORD.")
            log("Vigía pide una cuenta del personal (la misma con que entras al puesto de mando).")
            self.email = self.email or input("Correo: ").strip()
            self.password = self.password or getpass.getpass("Contraseña: ")
        status, body, cookies = self._open("POST", "/api/auth/login", {"email": self.email, "password": self.password})
        if status in (400, 401):
            raise Fatal(f"No se pudo iniciar sesión: {_error_message(body)}")
        if not 200 <= status < 300:
            raise Fatal(f"No se pudo iniciar sesión ({status}): {_error_message(body)}")
        for c in cookies:
            pair = c.split(";", 1)[0].strip()
            if pair.startswith("vigia_session="):
                self.cookie = pair
        log(f"Sesión iniciada como {self.email}.")

    def target(self, pinned: str | None) -> dict | None:
        """La emergencia a la que va el dron: la fijada (código VG-XXXX o id) si sigue abierta, o la
        abierta (activa o controlada) más nueva; mismo criterio que el puente Zello. None si no hay."""
        incidents = self._call("GET", "/api/incidents").get("incidents", [])
        abiertas = [i for i in incidents if i.get("status") in ("active", "controlled")]
        if pinned:
            key = pinned.strip().upper()
            return next((i for i in abiertas if i.get("code", "").upper() == key or i.get("id") == pinned.strip()), None)
        return max(abiertas, key=lambda i: i.get("created_at", ""), default=None)

    def create_mission(self, incident_id: str) -> tuple[str, str, str]:
        """Despliega un dron real por API en la emergencia: (id de la misión, token, etiqueta D<n>)."""
        body = self._call("POST", f"/api/incidents/{urllib.parse.quote(incident_id, safe='')}/missions", {"mode": "api"})
        return body["mission"]["id"], body["ingest_token"], body["mission"].get("label", "")


def _read_saved() -> dict:
    try:
        with open(SAVED_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_mission(base_url: str, value: dict | None) -> None:
    """Recuerda la misión en curso (el token solo se entrega una vez) para retomarla al reiniciar."""
    data = _read_saved()
    key = base_url.rstrip("/")
    if value is None:
        data.pop(key, None)
    else:
        data[key] = value
    try:
        os.makedirs(os.path.dirname(SAVED_PATH), exist_ok=True)
        fd = os.open(SAVED_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except OSError as e:
        log(f"No se pudo guardar la misión en {SAVED_PATH}: {e}")


def deploy(account: VigiaAccount, base_url: str, incident: dict, flight: SyntheticFlight) -> tuple[Client, str, str, str] | None:
    """Misión del dron en la emergencia: la guardada si sigue abierta ahí, o una nueva. None sin red."""
    saved = _read_saved().get(base_url.rstrip("/"))
    if saved and saved.get("incident_id") == incident["id"]:
        client = Client(base_url, saved["mission_id"], saved["token"])
        try:
            res = client.telemetry([flight.point()])
            if res.get("status") not in ("landed", "aborted"):
                log(f"Se retoma la misión {saved.get('label', '')} que ya estaba abierta.")
                return client, saved["mission_id"], saved["token"], saved.get("label", "")
        except Fatal:
            pass
        except ConnectionError as e:
            log(str(e))
            return None
    elif saved:
        # Quedó abierta en otra emergencia (el puente se reinició apuntando a otra): el dron
        # está en un solo lugar, así que esa misión se cierra antes de desplegar aquí.
        old = Client(base_url, saved["mission_id"], saved["token"])
        try:
            old.telemetry([{**flight.point(), "alt_m": 0.0, "speed_ms": 0.0}], "landed")
            log(f"Misión {saved.get('label', '')} de la emergencia anterior cerrada.")
        except (Fatal, ConnectionError):
            pass
        save_mission(base_url, None)
    try:
        mission_id, token, label = account.create_mission(incident["id"])
    except ConnectionError as e:
        log(f"No se pudo desplegar el dron en {incident['code']}: {e}")
        return None
    save_mission(base_url, {"incident_id": incident["id"], "mission_id": mission_id, "token": token, "label": label})
    log(f"Dron {label} desplegado en {incident['code']} (dron real por API).")
    return Client(base_url, mission_id, token), mission_id, token, label


def run_auto(args: argparse.Namespace, stop: threading.Event) -> int:
    """Sin --mission: el video va siempre a la emergencia abierta más nueva.

    Despliega el dron (misión «dron real por API») en esa emergencia, la retoma si el puente se
    reinicia y, si aparece una emergencia más nueva o la actual se cierra, cierra la misión y se
    cambia. Si el mando termina la misión (RETORNAR o ABORTAR), no vuelve a esa emergencia.
    """
    account = VigiaAccount(args.url)
    try:
        # Antes de que ffmpeg empiece a escribir en la terminal: aquí se piden correo y contraseña.
        account.target(args.incident)
    except ConnectionError as e:
        log(str(e))
    if args.incident:
        log(f"Modo automático fijo: el video va solo a {args.incident} mientras esté abierta.")
    else:
        log("Modo automático: el video va a la emergencia abierta más nueva y se cambia sola si llega otra.")
    frames: "queue.Queue[bytes | None]" = queue.Queue()
    sender = start_live(args, stop, frames, keep_going=True)
    finished: set[str] = set()
    idle_shown = False
    while not stop.is_set():
        try:
            target = account.target(args.incident)
        except ConnectionError as e:
            log(f"{e} Reintento en {AUTO_CHECK_S:g} s.")
            stop.wait(AUTO_CHECK_S)
            continue
        if target is None or target["id"] in finished:
            sender.set_target(None, None)
            if not idle_shown:
                if target is None:
                    log(f"{args.incident} no está abierta: el video espera." if args.incident else
                        "No hay emergencias abiertas: el video espera a que se cree una.")
                else:
                    log(f"La misión en {target['code']} terminó en el puesto de mando: el video espera "
                        + ("(reinicia el puente para volver a desplegar ahí)." if args.incident else "una emergencia nueva."))
                idle_shown = True
            stop.wait(AUTO_CHECK_S)
            continue
        idle_shown = False
        flight = SyntheticFlight(target["lat"], target["lng"], args.radius, args.alt, args.speed, synthetic_battery=False)
        leg = deploy(account, args.url, target, flight)
        if leg is None:
            stop.wait(AUTO_CHECK_S)
            continue
        client, mission_id, token, label = leg
        sender.set_target(mission_id, token)
        log(f"Transmitiendo a {target['code']} · {target.get('title', '')} (dron {label}).")

        last_check = time.monotonic()

        def leave() -> bool:
            nonlocal last_check
            if sender.lost == mission_id:
                return True
            if time.monotonic() - last_check < AUTO_CHECK_S:
                return False
            last_check = time.monotonic()
            try:
                newest = account.target(args.incident)
            except (ConnectionError, Fatal):
                return False
            return newest is None or newest["id"] != target["id"]

        reason = fly(client, flight, frames, stop, has_video=True, leave=leave)
        if reason == "stop":
            log("La misión sigue abierta: al volver a ejecutar el puente se retoma la misma.")
            break
        rejected = sender.lost == mission_id
        sender.set_target(None, None)
        if reason == "ended" or rejected:
            finished.add(target["id"])
            save_mission(args.url, None)
            continue
        # Hay una emergencia más nueva (o esta se cerró): el dron deja esta misión cerrada.
        try:
            flight.alt, flight.speed = 0.0, 0.0
            client.telemetry([flight.point()], "landed")
            log(f"Dron {label} sale de {target['code']}: misión cerrada.")
        except (Fatal, ConnectionError) as e:
            log(f"No se pudo cerrar la misión en {target['code']}: {e}")
        save_mission(args.url, None)
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Puente de dron para Vigía: telemetría + cuadros, obedece RETORNAR/ABORTAR.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Ejemplos:", 1)[1] if "Ejemplos:" in __doc__ else None,
    )
    p.add_argument("--url", required=True, help="URL base de Vigía, p. ej. https://vigia.example")
    p.add_argument(
        "--mission",
        help="Id de la misión (aparece en el panel de dron). Con --rtmp/--stream se puede omitir: "
        "modo automático, el video va a la emergencia abierta más nueva.",
    )
    p.add_argument("--token", help="Token de ingesta entregado al desplegar el dron (va con --mission).")
    p.add_argument(
        "--incident", metavar="VG-XXXX",
        help="Modo automático fijo: el dron va solo a esta emergencia (código o id) en vez de seguir la más nueva.",
    )
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--simulate", action="store_true", help="Órbita sintética sin cámara.")
    src.add_argument("--video", metavar="ARCHIVO", help="Video a reproducir como cámara del dron (requiere ffmpeg).")
    src.add_argument("--mavlink", metavar="CONEXIÓN", help="Conexión MAVLink, p. ej. udp:127.0.0.1:14550 (referencia no probada).")
    src.add_argument(
        "--rtmp", nargs="?", const=DEFAULT_RTMP, metavar="ESCUCHA",
        help=f"Servidor RTMP local para DJI Fly; por defecto escucha en {DEFAULT_RTMP} (requiere ffmpeg).",
    )
    src.add_argument("--stream", metavar="URL", help="Video en vivo desde una URL (p. ej. rtsp://127.0.0.1:8554/live/dron de MediaMTX).")
    p.add_argument("--lat", type=float, help="Latitud del incidente (con --mission en --simulate, --video, --rtmp y --stream).")
    p.add_argument("--lng", type=float, help="Longitud del incidente (con --mission en --simulate, --video, --rtmp y --stream).")
    p.add_argument("--radius", type=float, default=60.0, help="Radio de la órbita en metros (60).")
    p.add_argument("--alt", type=float, default=45.0, help="Altura de vuelo en metros (45).")
    p.add_argument("--speed", type=float, default=8.0, help="Velocidad en m/s (8).")
    p.add_argument(
        "--every", type=float, default=5.0,
        help="Segundos de video entre cuadros enviados a análisis (5). Con --rtmp/--stream, 0 = solo video en vivo.",
    )
    p.add_argument(
        "--live-fps", type=float, default=8.0,
        help=f"Cuadros por segundo del video en vivo con --rtmp/--stream (8; máximo {LIVE_MAX_FPS:g}).",
    )
    p.add_argument("--ffmpeg", default="ffmpeg", help="Ejecutable de ffmpeg (ffmpeg).")
    args = p.parse_args(argv)
    live = args.rtmp is not None or args.stream is not None
    if bool(args.mission) != bool(args.token):
        p.error("--mission y --token van juntos.")
    args.auto = live and not args.mission
    if not args.mission and not args.auto:
        p.error("Faltan --mission y --token (solo --rtmp y --stream funcionan sin ellos, en modo automático).")
    if args.incident and not args.auto:
        p.error("--incident es para el modo automático (--rtmp o --stream sin --mission).")
    if (args.simulate or args.video or live) and not args.auto and (args.lat is None or args.lng is None):
        p.error("--simulate, --video, --rtmp y --stream con --mission necesitan --lat y --lng del incidente.")
    if args.radius <= 0 or args.speed <= 0 or args.alt <= 0:
        p.error("--radius, --speed y --alt deben ser positivos.")
    if args.every < 0 or (args.every == 0 and not live):
        p.error("--every debe ser positivo (0 solo vale con --rtmp o --stream).")
    if not 0 < args.live_fps <= LIVE_MAX_FPS:
        p.error(f"--live-fps debe estar entre 0 y {LIVE_MAX_FPS:g}.")
    if args.rtmp is not None and not args.rtmp.startswith("rtmp://"):
        p.error(f"--rtmp espera una dirección de escucha rtmp://, p. ej. {DEFAULT_RTMP}")
    if (args.video or live) and not (shutil.which(args.ffmpeg) or os.path.exists(args.ffmpeg)):
        p.error(f"No se encontró ffmpeg ({args.ffmpeg}). Instálalo o indica la ruta con --ffmpeg.")
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    client = None if args.auto else Client(args.url, args.mission, args.token)
    stop = threading.Event()
    interrupted = threading.Event()

    def on_signal(*_: object) -> None:
        interrupted.set()
        stop.set()

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    try:
        if client is None:
            code = run_auto(args, stop)
        elif args.mavlink:
            code = run_mavlink(client, args.mavlink, stop)
        else:
            code = run_synthetic(client, args, stop)
    except Fatal as e:
        log(str(e))
        return 1
    except ConnectionError as e:
        log(f"{e} Revisa la red y vuelve a ejecutar el puente.")
        return 1
    finally:
        stop.set()
        for proc in list(_CHILDREN):
            proc.terminate()
    if interrupted.is_set():
        log("Detenido por el usuario (Ctrl+C).")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
