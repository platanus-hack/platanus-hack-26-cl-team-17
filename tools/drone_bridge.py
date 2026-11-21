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

Ejemplos:
  python3 tools/drone_bridge.py --url https://vigia.example --mission ID --token TOKEN --simulate --lat -33.4569 --lng -70.5987
  python3 tools/drone_bridge.py --url http://localhost:3000 --mission ID --token TOKEN --video aereo.mp4 --lat -33.4569 --lng -70.5987
"""

from __future__ import annotations

import argparse
import json
import math
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone

EARTH_R = 6_371_000.0
TELEMETRY_EVERY_S = 2.0
MAX_FRAME_BYTES = 3_000_000
USER_AGENT = "vigia-drone-bridge/1"


class Fatal(Exception):
    """Error que no se arregla reintentando (token inválido, misión terminada)."""


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def log(msg: str) -> None:
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
        if self.alt > 0 or self.phase == "launching":
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
            "battery_pct": round(self.battery, 1),
        }


# ───────────────────────── Video con ffmpeg ─────────────────────────


def video_frames(path: str, every_s: float, ffmpeg: str, out: "queue.Queue[bytes | None]", stop: threading.Event) -> None:
    """Extrae un JPEG cada `every_s` segundos al ritmo de reproducción (-re) con lado mayor 1280."""
    scale = "scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)'"
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-re", "-i", path,
        "-vf", f"fps=1/{every_s},{scale}", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4", "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    buf = b""
    try:
        assert proc.stdout is not None
        while not stop.is_set():
            chunk = proc.stdout.read(65536)
            if not chunk:
                break
            buf += chunk
            # El MJPEG de ffmpeg no trae miniaturas: cada imagen va de FF D8 a FF D9.
            while True:
                start = buf.find(b"\xff\xd8")
                end = buf.find(b"\xff\xd9", start + 2) if start >= 0 else -1
                if start < 0 or end < 0:
                    break
                out.put(buf[start : end + 2])
                buf = buf[end + 2 :]
    finally:
        if proc.poll() is None:
            proc.terminate()
        err = proc.stderr.read().decode("utf-8", "replace").strip() if proc.stderr else ""
        proc.wait()
        if proc.returncode not in (0, None, -15) and err:
            log(f"ffmpeg terminó con error: {err[:300]}")
        out.put(None)


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


def run_synthetic(client: Client, args: argparse.Namespace, stop: threading.Event) -> int:
    flight = SyntheticFlight(args.lat, args.lng, args.radius, args.alt, args.speed)
    frames: "queue.Queue[bytes | None]" = queue.Queue()
    video_done = args.video is None
    held: bytes | None = None
    sent_frames = 0
    if args.video:
        ffmpeg = shutil.which(args.ffmpeg) or args.ffmpeg
        threading.Thread(target=video_frames, args=(args.video, args.every, ffmpeg, frames, stop), daemon=True).start()
        log(f"Reproduciendo {args.video}: un cuadro cada {args.every:g} s.")
    else:
        log("Modo simulado: solo telemetría, sin cámara.")

    last = time.monotonic()
    reported = None
    command = "continue"
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
                    client.frame(held, flight.point(), flush=True)
                    sent_frames += 1
                    held = None
                log(f"Fin del video: {sent_frames} cuadros enviados.")
                break
            if len(item) > MAX_FRAME_BYTES:
                log("Cuadro de más de 3 MB descartado.")
                continue
            if held is not None and flight.phase in ("on_station", "en_route", "returning"):
                res = client.frame(held, flight.point())
                sent_frames += 1
                if res.get("flushed"):
                    log(f"Lote cerrado ({res.get('media_id')}) y enviado a análisis.")
            held = item
        stop.wait(TELEMETRY_EVERY_S)

    try:
        if held is not None and command != "abort":
            client.frame(held, flight.point(), flush=True)
        if stop.is_set() and flight.phase not in ("landed", "aborted"):
            # Fuente sintética detenida a mano: se informa aterrizaje para cerrar la misión.
            flight.alt, flight.speed = 0.0, 0.0
            client.telemetry([flight.point()], "landed")
            log("Se informó aterrizaje al puesto de mando.")
    except (Fatal, ConnectionError) as e:
        log(f"No se pudo cerrar la misión limpiamente: {e}")
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Puente de dron para Vigía: telemetría + cuadros, obedece RETORNAR/ABORTAR.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Ejemplos:", 1)[1] if "Ejemplos:" in __doc__ else None,
    )
    p.add_argument("--url", required=True, help="URL base de Vigía, p. ej. https://vigia.example")
    p.add_argument("--mission", required=True, help="Id de la misión (aparece en el panel de dron).")
    p.add_argument("--token", required=True, help="Token de ingesta entregado al desplegar el dron.")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--simulate", action="store_true", help="Órbita sintética sin cámara.")
    src.add_argument("--video", metavar="ARCHIVO", help="Video a reproducir como cámara del dron (requiere ffmpeg).")
    src.add_argument("--mavlink", metavar="CONEXIÓN", help="Conexión MAVLink, p. ej. udp:127.0.0.1:14550 (referencia no probada).")
    p.add_argument("--lat", type=float, help="Latitud del incidente (para --simulate y --video).")
    p.add_argument("--lng", type=float, help="Longitud del incidente (para --simulate y --video).")
    p.add_argument("--radius", type=float, default=60.0, help="Radio de la órbita en metros (60).")
    p.add_argument("--alt", type=float, default=45.0, help="Altura de vuelo en metros (45).")
    p.add_argument("--speed", type=float, default=8.0, help="Velocidad en m/s (8).")
    p.add_argument("--every", type=float, default=5.0, help="Segundos de video entre cuadros enviados (5).")
    p.add_argument("--ffmpeg", default="ffmpeg", help="Ejecutable de ffmpeg (ffmpeg).")
    args = p.parse_args(argv)
    if (args.simulate or args.video) and (args.lat is None or args.lng is None):
        p.error("--simulate y --video necesitan --lat y --lng del incidente.")
    if args.every <= 0 or args.radius <= 0 or args.speed <= 0 or args.alt <= 0:
        p.error("--every, --radius, --speed y --alt deben ser positivos.")
    if args.video and not (shutil.which(args.ffmpeg) or os.path.exists(args.ffmpeg)):
        p.error(f"No se encontró ffmpeg ({args.ffmpeg}). Instálalo o indica la ruta con --ffmpeg.")
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    client = Client(args.url, args.mission, args.token)
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    try:
        code = run_mavlink(client, args.mavlink, stop) if args.mavlink else run_synthetic(client, args, stop)
    except Fatal as e:
        log(str(e))
        return 1
    except ConnectionError as e:
        log(f"{e} Revisa la red y vuelve a ejecutar el puente.")
        return 1
    if stop.is_set():
        log("Detenido por el usuario (Ctrl+C).")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
