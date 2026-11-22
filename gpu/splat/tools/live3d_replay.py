#!/usr/bin/env python3
"""Reproduce un video contra el servicio de reconstrucción 3D en vivo, al ritmo real del video.

Prueba de punta a punta sin pasar por la app: manda cuadros JPEG de 640 px como lo haría el
reenvío desde `pushLiveFrame`, muestra el avance y al final guarda la nube (`.ply`) y una vista
(`.png`) para revisarla.

    .venv/bin/python tools/live3d_replay.py --url http://127.0.0.1:8790 VIDEO.mp4
    .venv/bin/python tools/live3d_replay.py --url https://vigia-live3d-….run.app --gcp VIDEO.mp4 --out out/live3d/prueba

Con --splat además pide los Gaussian splats en vivo mientras corre (eso mantiene encendido el
entrenamiento), sigue entrenando --splat-extra segundos al final y guarda `splats.splat`
(formato .splat de antimatter15, se abre con cualquier visor):

    .venv/bin/python tools/live3d_replay.py --url … --gcp --splat VIDEO.mp4

Con --app el video va a la app como si fuera el dron (POST /api/drone/<misión>/live con el token
de ingesta, 8 cuadros por segundo) y la nube se mira en la pestaña «Dron 3D» de la ficha:

    .venv/bin/python tools/live3d_replay.py --app http://localhost:3000 --mission ID --token TOKEN VIDEO.mp4 [VIDEO2.mp4…]

Requiere ffmpeg. --gcp usa `gcloud auth print-identity-token` (tu cuenta debe poder invocar el servicio).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from splat.live3d import decode_points
from splat.live_gs import decode_live_splat


def jpeg_frames(path: str, fps: float, width: int):
    cmd = [
        "ffmpeg", "-v", "error", "-i", path,
        "-vf", f"fps={fps},scale={width}:-2", "-q:v", "5", "-f", "image2pipe", "-c:v", "mjpeg", "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    buf = b""
    assert proc.stdout is not None
    while True:
        chunk = proc.stdout.read(1 << 16)
        if not chunk:
            break
        buf += chunk
        while True:
            start = buf.find(b"\xff\xd8")
            end = buf.find(b"\xff\xd9", start + 2)
            if start < 0 or end < 0:
                break
            yield buf[start : end + 2]
            buf = buf[end + 2 :]
    proc.wait()


class Client:
    def __init__(self, url: str, gcp: bool):
        self.url = url.rstrip("/")
        self.token = None
        if gcp:
            self.token = subprocess.check_output(["gcloud", "auth", "print-identity-token"], text=True).strip()

    def req(self, method: str, path: str, body: bytes | None = None, ctype: str | None = None, timeout: float = 30):
        r = urllib.request.Request(self.url + path, data=body, method=method)
        if self.token:
            r.add_header("Authorization", f"Bearer {self.token}")
        if ctype:
            r.add_header("content-type", ctype)
        with urllib.request.urlopen(r, timeout=timeout) as res:
            return res.read()

    def json(self, method: str, path: str, body: bytes | None = None, ctype: str | None = None, timeout: float = 30):
        return json.loads(self.req(method, path, body, ctype, timeout))


def write_ply(path: str, xyz: np.ndarray, rgb: np.ndarray) -> None:
    with open(path, "wb") as f:
        f.write(
            (
                "ply\nformat binary_little_endian 1.0\n"
                f"element vertex {len(xyz)}\nproperty float x\nproperty float y\nproperty float z\n"
                "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n"
            ).encode()
        )
        rec = np.zeros(len(xyz), dtype=[("p", "<f4", 3), ("c", "u1", 3)])
        rec["p"] = xyz
        rec["c"] = rgb
        f.write(rec.tobytes())


def render(path: str, xyz: np.ndarray, rgb: np.ndarray, display: np.ndarray, cams: np.ndarray) -> None:
    """Vista oblicua (desde arriba y atrás) con la trayectoria de la cámara en rojo."""
    import cv2

    m = display.reshape(4, 4)
    p = xyz.astype(np.float64) @ m[:3, :3].T + m[:3, 3]
    c = cams[:, [3, 7, 11]] @ m[:3, :3].T + m[:3, 3] if len(cams) else np.zeros((0, 3))
    # Cámara virtual: elevación 35°, mirando al origen desde +Z.
    el = np.radians(35)
    rot = np.array([[1, 0, 0], [0, np.cos(el), -np.sin(el)], [0, np.sin(el), np.cos(el)]])
    q = p @ rot.T
    qc = c @ rot.T
    w, h = 1400, 900
    f = 420
    dist = 3.2

    def proj(v):
        z = dist - v[:, 2]
        return np.stack((w / 2 + f * v[:, 0] / z, h / 2 - f * v[:, 1] / z), axis=1), z

    uv, z = proj(q)
    img = np.full((h, w, 3), 18, np.uint8)
    order = np.argsort(-z)
    for (x, y), col in zip(uv[order].astype(int), rgb[order]):
        if 0 <= x < w - 1 and 0 <= y < h - 1:
            img[y : y + 2, x : x + 2] = col[::-1]
    if len(qc) > 1:
        uvc, _ = proj(qc)
        cv2.polylines(img, [uvc.astype(np.int32)], False, (60, 60, 255), 2)
    cv2.imwrite(path, img)


def write_splat(path: str, data: bytes) -> int:
    """VGS1 → .splat (32 bytes por gaussiana). Devuelve cuántas escribió."""
    d = decode_live_splat(data)
    n = len(d["position"])
    rec = np.zeros(n, dtype=[("p", "<f4", 3), ("s", "<f4", 3), ("c", "u1", 4), ("r", "u1", 4)])
    rec["p"] = d["position"]
    rec["s"] = np.exp(d["log_scale"])
    rec["c"] = d["rgba"]
    rec["r"] = np.clip(np.round(d["rot_wxyz"] * 128 + 128), 0, 255).astype(np.uint8)
    with open(path, "wb") as f:
        f.write(rec.tobytes())
    return n


class SplatPoller:
    def __init__(self, cli: "Client", sid: str):
        self.cli = cli
        self.sid = sid
        self.version = 0
        self.data: bytes | None = None
        self.last = 0.0

    def poll(self, every: float = 2.0) -> None:
        if time.time() - self.last < every:
            return
        self.last = time.time()
        try:
            body = self.cli.req("GET", f"/sessions/{self.sid}/splat?after={self.version}", timeout=30)
        except urllib.error.HTTPError as err:
            if err.code != 404:
                print("falló /splat:", err)
            return
        except urllib.error.URLError as err:
            print("falló /splat:", err)
            return
        if body:
            self.data = body
            self.version = decode_live_splat(body)["version"]


def as_drone(a: argparse.Namespace) -> int:
    """Manda los videos a la app como video en vivo del dron, al ritmo real."""
    fps = a.fps or 8.0
    url = f"{a.app.rstrip('/')}/api/drone/{a.mission}/live"
    n = 0
    start = time.time()
    for video in a.video:
        for jpg in jpeg_frames(video, fps, a.width):
            time.sleep(max(0.0, start + n / fps / a.speed - time.time()))
            req = urllib.request.Request(
                url, data=jpg, method="POST",
                headers={"authorization": f"Bearer {a.token}", "content-type": "image/jpeg"},
            )
            try:
                urllib.request.urlopen(req, timeout=5).read()
            except urllib.error.HTTPError as err:
                if err.code in (401, 404, 409):
                    print(f"La app respondió {err.code}: la misión no recibe video (¿terminó o el token no corresponde?).")
                    return 1
                print("falló un envío:", err)
            except urllib.error.URLError as err:
                print("falló un envío:", err)
            n += 1
            if n % 80 == 0:
                print(f"{n} cuadros enviados ({time.time() - start:.0f} s)")
    print(f"listo: {n} cuadros")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", nargs="+")
    ap.add_argument("--url", help="servicio vigia-live3d (modo directo)")
    ap.add_argument("--app", help="URL de la app: manda el video como el dron (requiere --mission y --token)")
    ap.add_argument("--mission")
    ap.add_argument("--token", help="ingest_token de la misión")
    ap.add_argument("--gcp", action="store_true", help="token de identidad de gcloud")
    ap.add_argument("--session", default=f"replay-{int(time.time())}")
    ap.add_argument("--fps", type=float, default=None, help="cuadros por segundo enviados (4 directo, 8 con --app)")
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--speed", type=float, default=1.0, help="1 = tiempo real")
    ap.add_argument("--out", default="out/live3d/replay")
    ap.add_argument("--splat", action="store_true", help="pide y guarda los Gaussian splats en vivo")
    ap.add_argument("--splat-extra", type=float, default=30.0, help="segundos de entrenamiento al final")
    a = ap.parse_args()
    if a.app:
        if not (a.mission and a.token):
            ap.error("--app requiere --mission y --token")
        return as_drone(a)
    if not a.url:
        ap.error("falta --url (o --app)")
    a.fps = a.fps or 4.0
    if len(a.video) > 1:
        ap.error("en modo directo va un solo video")

    cli = Client(a.url, a.gcp)
    t0 = time.time()
    while True:
        h = cli.json("GET", "/health", timeout=120)
        if h.get("ready"):
            break
        if h.get("error"):
            print("El modelo no cargó:", h["error"])
            return 1
        print(f"esperando el modelo… ({time.time() - t0:.0f} s)")
        time.sleep(3)
    print(f"listo: motor {h['engine']}, GPU {h.get('gpu')}, en {time.time() - t0:.0f} s")

    sid = a.session
    splats = SplatPoller(cli, sid) if a.splat else None
    start = time.time()
    sent = 0
    last_print = 0.0
    for k, jpg in enumerate(jpeg_frames(a.video[0], a.fps, a.width)):
        due = start + k / a.fps / a.speed
        time.sleep(max(0.0, due - time.time()))
        try:
            cli.json("POST", f"/sessions/{sid}/frames?t={int(time.time() * 1000)}", jpg, "image/jpeg", timeout=10)
            sent += 1
        except urllib.error.URLError as err:
            print("falló un envío:", err)
        if splats:
            splats.poll()
        if time.time() - last_print > 2:
            last_print = time.time()
            st = cli.json("GET", f"/sessions/{sid}/status")
            sp = st.get("splat") or {}
            print(
                f"t={time.time() - start:5.1f}s enviados={sent} clave={st['keyframes']} pend={st['pending']} "
                f"trozos={st['chunks']} puntos={st['points']} ventana={st['last_chunk_ms']} ms {st['state']}"
                + (f" · {st['message']}" if st["message"] else "")
                + (
                    f" · splats v{sp.get('version')} {sp.get('gaussians')} gs paso {sp.get('steps')} PSNR {sp.get('psnr')}"
                    + (f" ({sp['error']})" if sp.get("error") else "")
                    if splats
                    else ""
                )
            )
    # Espera a que se vacíen los pendientes.
    for _ in range(40):
        st = cli.json("GET", f"/sessions/{sid}/status")
        if st["pending"] == 0:
            break
        time.sleep(0.5)
    time.sleep(1.5)
    if splats:
        until = time.time() + a.splat_extra
        while time.time() < until:
            splats.poll(1.0)
            time.sleep(0.5)
        splats.last = 0.0
        splats.poll()
    st = cli.json("GET", f"/sessions/{sid}/status")
    print(json.dumps({k: v for k, v in st.items() if k not in ("display", "cameras")}, ensure_ascii=False))

    xyz_all, rgb_all = [], []
    got = 0
    while got < st["chunks"]:
        s0, s1, xyz, rgb = decode_points(cli.req("GET", f"/sessions/{sid}/points?from={got}&max=16"))
        xyz_all.append(xyz)
        rgb_all.append(rgb)
        got = s1
    xyz = np.concatenate(xyz_all) if xyz_all else np.zeros((0, 3), np.float32)
    rgb = np.concatenate(rgb_all) if rgb_all else np.zeros((0, 3), np.uint8)
    os.makedirs(a.out, exist_ok=True)
    write_ply(os.path.join(a.out, "nube.ply"), xyz, rgb)
    with open(os.path.join(a.out, "status.json"), "w") as f:
        json.dump(st, f)
    render(os.path.join(a.out, "vista.png"), xyz, rgb, np.array(st["display"]), np.array(st["cameras"]))
    print(f"{len(xyz)} puntos → {a.out}/nube.ply y vista.png")
    if splats and splats.data:
        n = write_splat(os.path.join(a.out, "splats.splat"), splats.data)
        print(f"{n} gaussianas (v{splats.version}) → {a.out}/splats.splat")
    elif splats:
        print("no llegaron splats")
    return 0


if __name__ == "__main__":
    sys.exit(main())
