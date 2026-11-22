#!/usr/bin/env python3
"""
Pruebas de reconstrucción 3D con fotos propias, sin pasar por la app.

    cd gpu/splat
    .venv/bin/python tools/prueba_fotos.py revisar ~/fotos/sala
    .venv/bin/python tools/prueba_fotos.py correr  ~/fotos/sala --caso sala-1 [--iteraciones 7000] [--gps]
    .venv/bin/python tools/prueba_fotos.py ver sala-1
    .venv/bin/python tools/prueba_fotos.py tabla

revisar  En segundos y sin GPU: cuántas fotos sirven, cuáles están movidas, si cada foto se
         solapa con otras (SIFT + matriz fundamental) y si hay paralaje (si todo se explica con
         una homografía, giraste en el lugar o fotografiaste una pared plana: no da profundidad).
correr   (--por-medio 12 las reparte como la app, para comparar.) Revisa, prepara las fotos (orientación EXIF, lado largo 1280 px, JPEG sin metadatos;
         el GPS de las fotos solo con --gps), las sube a gs://<bucket>/test/fotos/<caso>/<corrida>/,
         arma el manifiesto con un solo medio "fotos" y corre el job vigia-splat (el mismo de la
         app). Al terminar baja scene.splat, preview.jpg, result.json y consistency.json a
         out/fotos/<caso>/<corrida>/, escribe ver.html y agrega una fila a out/fotos/resultados.tsv.
ver      Sirve la última corrida de un caso en http://127.0.0.1:8090/ver.html (visor 3D).
tabla    Todas las corridas, para comparar.

Lee HEIC (iPhone), JPEG, PNG y WebP. Cuesta GPU (L4 en europe-west1): ~6 a 7 min con 7.000 pasos.
"""

from __future__ import annotations

import argparse
import datetime as dt
import functools
import http.server
import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "out" / "fotos"
TABLE = OUT / "resultados.tsv"

PROJECT = os.environ.get("PROJECT", "platanus-515411")
REGION = os.environ.get("SPLAT_REGION", "europe-west1")
JOB = os.environ.get("SPLAT_JOB_NAME", "vigia-splat")
BUCKET = os.environ.get("BUCKET", "platanus-515411-vigia-evidencia")
# Sin servidor que escuche: el job registra el error del aviso de progreso y sigue (deploy/SPLAT.md).
CALLBACK_URL = "https://vigia-callback-inexistente.invalid/api/internal/splat/callback"
# Sin GPS la escena queda centrada aquí con escala aproximada; el punto da lo mismo.
DEFAULT_ORIGIN = {"lat": -33.4489, "lng": -70.6693}

EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}
LONG_EDGE = 1280  # igual que FRAME_LONG_EDGE_PX del job
# Cuadros que caben en una pasada de VGGT en la L4 (vggt_frame_cap con 24 GB): el resto lo descarta el job.
VGGT_CAP = 76
MIN_PHOTOS = 8
MATCH_EDGE = 800  # lado largo para SIFT en la revisión
MIN_INLIERS = 40  # inliers de la matriz fundamental para decir que dos fotos se solapan
NO_PARALLAX_RATIO = 0.9  # inliers de la homografía / de la fundamental sobre esto = sin paralaje
BLUR_FRACTION = 0.25  # igual que el job: nitidez bajo el 25 % del percentil 90
ALL_PAIRS_UP_TO = 60  # con más fotos se compara cada una con sus vecinas en orden de captura
WINDOW = 8
CASE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")


def log(msg: str) -> None:
    print(msg, flush=True)


# ───────────────────────────── fotos ─────────────────────────────


def open_image(path: Path):
    """Imagen RGB ya enderezada según su EXIF, y el EXIF original (para fecha y GPS)."""
    from PIL import Image, ImageOps

    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except ImportError:  # sin pillow-heif no se leen los HEIC de iPhone
        pass
    img = Image.open(path)
    exif = img.getexif()
    return ImageOps.exif_transpose(img).convert("RGB"), exif


def dms_to_deg(dms: Any, ref: Any) -> float | None:
    """(grados, minutos, segundos) del EXIF → grados decimales; None si no se puede leer."""
    try:
        d, m, s = (float(x) for x in dms)
    except (TypeError, ValueError):
        return None
    value = d + m / 60 + s / 3600
    if not np.isfinite(value):
        return None
    return -value if str(ref).upper() in ("S", "W") else value


def exif_gps(exif: Any) -> tuple[float | None, float | None]:
    try:
        gps = exif.get_ifd(0x8825)
    except (AttributeError, KeyError, TypeError, ValueError):
        return None, None
    lat = dms_to_deg(gps.get(2), gps.get(1)) if gps else None
    lng = dms_to_deg(gps.get(4), gps.get(3)) if gps else None
    if lat is None or lng is None or (lat == 0 and lng == 0):
        return None, None
    return lat, lng


def exif_time(exif: Any) -> dt.datetime | None:
    try:
        raw = exif.get_ifd(0x8769).get(36867) or exif.get(306)
        return dt.datetime.strptime(str(raw).strip(), "%Y:%m:%d %H:%M:%S")
    except (AttributeError, KeyError, TypeError, ValueError):
        return None


@dataclass
class Photo:
    path: Path
    width: int
    height: int
    taken: dt.datetime | None
    lat: float | None
    lng: float | None
    gray: np.ndarray  # lado largo MATCH_EDGE, para SIFT
    sharpness: float


def resized(gray: np.ndarray, long_edge: int) -> np.ndarray:
    h, w = gray.shape[:2]
    s = long_edge / max(h, w)
    if s >= 1:
        return gray
    return cv2.resize(gray, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)


def load_photos(folder: Path) -> list[Photo]:
    files = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in EXTENSIONS)
    photos: list[Photo] = []
    for f in files:
        try:
            img, exif = open_image(f)
        except (OSError, ValueError) as exc:  # una foto ilegible no frena la prueba
            log(f"  ! no pude leer {f.name}: {exc}")
            continue
        gray = cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2GRAY)
        lat, lng = exif_gps(exif)
        photos.append(
            Photo(
                path=f,
                width=img.width,
                height=img.height,
                taken=exif_time(exif),
                lat=lat,
                lng=lng,
                gray=resized(gray, MATCH_EDGE),
                # Misma resolución para todas: la nitidez es comparable entre fotos.
                sharpness=float(cv2.Laplacian(resized(gray, 1024), cv2.CV_64F).var()),
            )
        )
    # Orden de captura (si hay fecha) y después por nombre: las vecinas en el tiempo suelen solaparse.
    photos.sort(key=lambda p: (p.taken is None, p.taken or dt.datetime.min, p.path.name))
    return photos


def blurry_indices(sharpness: Sequence[float], fraction: float = BLUR_FRACTION) -> list[int]:
    if len(sharpness) < 3:
        return []
    limit = fraction * float(np.percentile(sharpness, 90))
    return [i for i, s in enumerate(sharpness) if s < limit]


# ───────────────────────────── solapamiento ─────────────────────────────


def candidate_pairs(n: int) -> list[tuple[int, int]]:
    if n <= ALL_PAIRS_UP_TO:
        return [(i, j) for i in range(n) for j in range(i + 1, n)]
    return [(i, j) for i in range(n) for j in range(i + 1, min(n, i + 1 + WINDOW))]


def match_pair(f1: tuple[Any, Any], f2: tuple[Any, Any], matcher: Any) -> tuple[int, int]:
    """(inliers de la matriz fundamental, inliers de una homografía) entre dos fotos."""
    (k1, d1), (k2, d2) = f1, f2
    if d1 is None or d2 is None or len(k1) < 8 or len(k2) < 8:
        return 0, 0
    good = []
    for pair in matcher.knnMatch(d1, d2, k=2):
        if len(pair) == 2 and pair[0].distance < 0.75 * pair[1].distance:
            good.append(pair[0])
    if len(good) < 15:
        return 0, 0
    p1 = np.float32([k1[m.queryIdx].pt for m in good])
    p2 = np.float32([k2[m.trainIdx].pt for m in good])
    _, fmask = cv2.findFundamentalMat(p1, p2, cv2.USAC_MAGSAC, 1.5, 0.999, 2000)
    _, hmask = cv2.findHomography(p1, p2, cv2.RANSAC, 4.0)
    fin = int(fmask.sum()) if fmask is not None else 0
    hin = int(hmask.sum()) if hmask is not None else 0
    return fin, hin


def overlap_edges(photos: Sequence[Photo]) -> dict[tuple[int, int], tuple[int, int]]:
    sift = cv2.SIFT_create(nfeatures=2000)
    feats = [sift.detectAndCompute(p.gray, None) for p in photos]
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    return {(i, j): match_pair(feats[i], feats[j], matcher) for i, j in candidate_pairs(len(photos))}


def overlap_report(n: int, edges: dict[tuple[int, int], tuple[int, int]]) -> dict[str, Any]:
    """Grupos de fotos conectadas, fotos sueltas y cuánto del set no tiene paralaje. Pura."""
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    strong = [(i, j) for (i, j), (fin, _) in edges.items() if fin >= MIN_INLIERS]
    degree = [0] * n
    for i, j in strong:
        degree[i] += 1
        degree[j] += 1
        parent[find(i)] = find(j)
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    components = sorted(groups.values(), key=len, reverse=True)
    flat = [(i, j) for i, j in strong if edges[(i, j)][1] >= NO_PARALLAX_RATIO * edges[(i, j)][0]]
    return {
        "componentes": components,
        "principal": components[0] if components else [],
        "sueltas": [i for i in range(n) if degree[i] == 0],
        "debiles": [i for i in range(n) if degree[i] == 1],
        "pares_solapados": len(strong),
        "sin_paralaje": (len(flat) / len(strong)) if strong else 0.0,
    }


def verdict(n: int, blurry: Sequence[int], rep: dict[str, Any] | None, names: Sequence[str]) -> list[tuple[str, str]]:
    """Avisos en palabras: ("error" | "aviso" | "ok", texto). Pura."""
    out: list[tuple[str, str]] = []
    listed = lambda idx: ", ".join(names[i] for i in idx[:8]) + ("…" if len(idx) > 8 else "")
    if n < MIN_PHOTOS:
        out.append(("error", f"Muy pocas fotos ({n}). Toma 20 a 60 caminando alrededor del espacio, cada una solapada con la anterior."))
        return out
    if n > VGGT_CAP:
        out.append(("aviso", f"Hay {n} fotos; en la L4 caben ~{VGGT_CAP} en una pasada de VGGT: el job usará las más nítidas."))
    if blurry:
        out.append(("aviso", f"{len(blurry)} foto(s) movida(s) (el job las descarta): {listed(list(blurry))}."))
    if rep is not None:
        main = rep["principal"]
        if len(main) < 0.8 * n:
            sizes = " + ".join(str(len(c)) for c in rep["componentes"] if len(c) > 1) or "ninguno"
            out.append(
                (
                    "error",
                    (
                        f"El set se parte: el grupo principal tiene {len(main)} de {n} fotos (grupos de {sizes}). "
                        "Faltan fotos de transición que unan las zonas; así saldrían pedazos sueltos o encimados."
                    ),
                )
            )
        lone = [i for i in rep["sueltas"] if i in main or len(main) >= 0.8 * n]
        if lone:
            out.append(("aviso", f"{len(lone)} foto(s) no se solapan con ninguna otra (quedan fuera): {listed(lone)}."))
        if rep["sin_paralaje"] > 0.6:
            out.append(
                (
                    "aviso",
                    (
                        f"El {round(rep['sin_paralaje'] * 100)} % de los pares se explica con una homografía: parece que giraste en el "
                        "lugar o fotografiaste una superficie plana. La profundidad sale de desplazarse: camina alrededor."
                    ),
                )
            )
    if not any(level == "error" for level, _ in out):
        main_n = len(rep["principal"]) if rep else n
        out.append(("ok", f"Listo para reconstruir: {main_n} de {n} fotos conectadas."))
    return out


def review(folder: Path) -> tuple[list[Photo], list[tuple[str, str]], dict[str, Any]]:
    log(f"Revisando {folder} …")
    photos = load_photos(folder)
    n = len(photos)
    names = [p.path.name for p in photos]
    blurry = blurry_indices([p.sharpness for p in photos])
    rep = None
    if n >= 2:
        t0 = time.time()
        rep = overlap_report(n, overlap_edges(photos))
        log(f"  {n} fotos · {rep['pares_solapados']} pares solapados · grupos {[len(c) for c in rep['componentes'] if len(c) > 1]} · {time.time() - t0:.1f} s")
    gps = sum(1 for p in photos if p.lat is not None)
    heic = sum(1 for p in photos if p.path.suffix.lower() in (".heic", ".heif"))
    sizes = sorted({(p.width, p.height) for p in photos})
    log(f"  tamaños: {', '.join(f'{w}×{h}' for w, h in sizes[:4])}{' …' if len(sizes) > 4 else ''} · con GPS: {gps} · HEIC: {heic}")
    msgs = verdict(n, blurry, rep, names)
    for level, text in msgs:
        log(f"  {'✗' if level == 'error' else '!' if level == 'aviso' else '✓'} {text}")
    summary = {
        "fotos": n,
        "movidas": len(blurry),
        "conectadas": len(rep["principal"]) if rep else n,
        "sin_paralaje": round(rep["sin_paralaje"], 2) if rep else None,
    }
    return photos, msgs, summary


# ───────────────────────────── corrida en la GPU ─────────────────────────────


def build_manifest(
    case: str, run: str, frames: Sequence[dict[str, Any]], iterations: int, origin: dict[str, float], per_media: int = 0
) -> dict[str, Any]:
    """
    Manifiesto del job (SplatManifest de src/lib/contract.ts). Pura. Con per_media = 0 todas las
    fotos van en un solo medio (una pasada de VGGT); con per_media = 12 se reparten como lo hace
    la app al subir fotos (LIMITS.MAX_FRAMES_PER_MEDIA): cada grupo se estima aparte y se unen.
    """
    base = f"test/fotos/{case}/{run}/"
    size = per_media if per_media > 0 else max(1, len(frames))
    chunks = [list(frames[i : i + size]) for i in range(0, len(frames), size)] or [[]]

    def medium(k: int, chunk: Sequence[dict[str, Any]]) -> dict[str, Any]:
        return {
            "id": "fotos" if len(chunks) == 1 else f"fotos-{k + 1}",
            "label": f"Fotos {case}" if len(chunks) == 1 else f"Fotos {case} ({k + 1}/{len(chunks)})",
            "source": "responder",
            "video_path": None,
            "lat": None,
            "lng": None,
            "accuracy_m": None,
            "heading_deg": None,
            "frames": [
                {
                    "path": f"{base}fotos/{f['file']}",
                    "t_s": f["t_s"],
                    "lat": f.get("lat"),
                    "lng": f.get("lng"),
                    "alt_m": None,
                    "heading_deg": None,
                }
                for f in chunk
            ],
        }

    return {
        "version": 1,
        "incident_id": f"test-fotos-{case}",
        "reconstruction_id": f"fotos-{case}-{run}",
        "origin": origin,
        "bucket": BUCKET,
        "output_prefix": f"{base}out/",
        "callback_url": CALLBACK_URL,
        "iterations": iterations,
        "max_frames": min(300, max(1, len(frames))),
        "sample_fps": 2,
        "media": [medium(k, chunk) for k, chunk in enumerate(chunks)],
    }


def prepare(photos: Sequence[Photo], dest: Path, use_gps: bool) -> list[dict[str, Any]]:
    """JPEG enderezados, lado largo ≤ 1280, sin EXIF (sin GPS ni modelo del teléfono)."""
    from PIL import Image

    dest.mkdir(parents=True, exist_ok=True)
    t0 = next((p.taken for p in photos if p.taken), None)
    frames = []
    for i, p in enumerate(photos):
        img, _ = open_image(p.path)
        img.thumbnail((LONG_EDGE, LONG_EDGE), Image.Resampling.LANCZOS)
        name = f"{i:03d}.jpg"
        img.save(dest / name, "JPEG", quality=92)  # sin exif=…: Pillow no copia los metadatos
        t_s = (p.taken - t0).total_seconds() if (p.taken and t0) else float(i)
        frames.append({"file": name, "t_s": round(t_s, 2), "lat": p.lat if use_gps else None, "lng": p.lng if use_gps else None})
    return frames


def gcloud(args: Sequence[str], check: bool = True, quiet: bool = False) -> subprocess.CompletedProcess[str]:
    res = subprocess.run(["gcloud", *args, f"--project={PROJECT}"], text=True, capture_output=quiet, check=False)
    if check and res.returncode != 0:
        raise SystemExit(f"Falló: gcloud {' '.join(args)}{(chr(10) + res.stderr[-800:]) if quiet and res.stderr else ''}")
    return res


def summarize(result: dict[str, Any], consistency: dict[str, Any] | None) -> list[str]:
    """Resumen en palabras de una corrida. Pura."""
    lines = [f"Estado: {result.get('status')} — {result.get('message') or result.get('error') or ''}".strip()]
    if result.get("status") == "ready":
        lines.append(
            f"Fotos usadas {result.get('frames_registered')}/{result.get('frame_count')} · "
            f"PSNR {result.get('psnr_db')} dB · {round((result.get('gaussians') or 0) / 1000)} mil gaussianas · "
            f"GPU {round(result.get('gpu_seconds') or 0)} s · alineación {result.get('alignment')}"
        )
        cleanup = result.get("cleanup") or {}
        if cleanup.get("aplicada"):
            lines.append(
                f"Limpieza: quitó {round(100 * (cleanup.get('peso_quitado') or 0), 1)} % del peso visual; "
                f"la escena principal queda con {round(100 * (cleanup.get('peso_principal') or 0))} %."
            )
    if result.get("dropped_media"):
        lines.append(f"Medios descartados: {result['dropped_media']}")
    for c in (consistency or {}).get("checks", []):
        if c.get("status") != "ok":
            lines.append(f"  {'✗' if c.get('status') == 'falla' else '!'} {c.get('name')}: {c.get('detail')}")
    if consistency is not None:
        lines.append("Consistencia: " + ("FALLA (revisar la escena)" if consistency.get("failed") else "todas las pruebas OK"))
    return lines


def table_row(case: str, run: str, review_summary: dict[str, Any], result: dict[str, Any], consistency: dict[str, Any] | None, minutes: float) -> list[str]:
    fails = [c["name"] for c in (consistency or {}).get("checks", []) if c.get("status") == "falla"]
    return [
        dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
        case,
        run,
        str(review_summary.get("fotos")),
        str(review_summary.get("conectadas")),
        str(result.get("frames_registered", "")),
        str(result.get("psnr_db", "")),
        str(result.get("gaussians", "")),
        str(result.get("iterations", "")),
        f"{minutes:.1f}",
        str(result.get("status")),
        ",".join(fails) or "ok",
    ]


TABLE_HEADER = ["fecha", "caso", "corrida", "fotos", "conectadas", "registradas", "psnr_db", "gaussianas", "pasos", "min", "estado", "fallas_consistencia"]


def run_case(folder: Path, case: str, iterations: int, use_gps: bool, force: bool, per_media: int = 0) -> Path:
    if not CASE_RE.match(case):
        raise SystemExit("El caso va en minúsculas, números y guiones (p. ej. sala-1), hasta 40 caracteres.")
    photos, msgs, review_summary = review(folder)
    if any(level == "error" for level, _ in msgs) and not force:
        raise SystemExit("No corro la GPU con este set (usa --igual para correrlo de todos modos).")
    run = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    local = OUT / case / run
    frames = prepare(photos, local / "fotos", use_gps)
    gps = [(f["lat"], f["lng"]) for f in frames if f["lat"] is not None]
    origin = {"lat": float(np.mean([g[0] for g in gps])), "lng": float(np.mean([g[1] for g in gps]))} if gps else DEFAULT_ORIGIN
    manifest = build_manifest(case, run, frames, iterations, origin, per_media)
    if len(manifest["media"]) > 1:
        log(f"Repartidas en {len(manifest['media'])} medios de hasta {per_media} fotos (como la app).")
    (local / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    prefix = f"gs://{BUCKET}/test/fotos/{case}/{run}/"
    log(f"Subiendo {len(frames)} fotos a {prefix} …")
    gcloud(["storage", "cp", "-q", *[str(local / "fotos" / f["file"]) for f in frames], f"{prefix}fotos/"])
    gcloud(["storage", "cp", "-q", str(local / "manifest.json"), f"{prefix}manifest.json"])
    log(f"Corriendo el job {JOB} ({REGION}, {iterations} pasos); espera ~6–10 min …")
    t0 = time.time()
    res = gcloud(
        [
            "run", "jobs", "execute", JOB, f"--region={REGION}", "--wait",
            f"--update-env-vars=SPLAT_MANIFEST_URI={prefix}manifest.json,SPLAT_CALLBACK_TOKEN=prueba-sin-callback",
        ],
        check=False,
    )
    minutes = (time.time() - t0) / 60
    for name in ("result.json", "consistency.json", "preview.jpg", "scene.splat"):
        gcloud(["storage", "cp", "-q", f"{prefix}out/{name}", str(local / name)], check=False, quiet=True)
    result = json.loads((local / "result.json").read_text()) if (local / "result.json").exists() else {"status": "failed", "error": "El job no dejó result.json."}
    consistency = json.loads((local / "consistency.json").read_text()) if (local / "consistency.json").exists() else None
    (local / "ver.html").write_text(viewer_html(case, run, result))
    log("")
    for line in summarize(result, consistency):
        log(line)
    if res.returncode != 0 or result.get("status") != "ready":
        log(
            "Logs: gcloud logging read 'resource.type=\"cloud_run_job\" AND resource.labels.job_name=\""
            f"{JOB}\"' --project={PROJECT} --limit=200 --order=desc --format='value(textPayload)'"
        )
    new_file = not TABLE.exists()
    TABLE.parent.mkdir(parents=True, exist_ok=True)
    with TABLE.open("a") as fh:
        if new_file:
            fh.write("\t".join(TABLE_HEADER) + "\n")
        fh.write("\t".join(table_row(case, run, review_summary, result, consistency, minutes)) + "\n")
    log(f"\nSalida: {local}\nVer en 3D: .venv/bin/python tools/prueba_fotos.py ver {case}")
    return local


# ───────────────────────────── visor ─────────────────────────────

VIEWER = """<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prueba 3D · __CASE__</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #111; color: #eee; font: 14px/1.4 system-ui, sans-serif; }
  #c { position: fixed; inset: 0; width: 100%; height: 100%; display: block; }
  #info { position: fixed; top: 12px; left: 12px; max-width: min(560px, calc(100% - 24px)); padding: 10px 12px;
          background: rgb(0 0 0 / 0.6); border-radius: 10px; }
  #info b { font-size: 15px; } #info p { margin: 4px 0 0; color: #bbb; }
</style></head>
<body>
<canvas id="c"></canvas>
<div id="info"><b>__CASE__ · __RUN__</b><p id="msg">Cargando scene.splat…</p><p>__STATS__</p><p>Arrastra para girar, rueda para acercar, clic derecho para mover.</p></div>
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.187.0/build/three.module.js",
  "three/examples/jsm/": "https://cdn.jsdelivr.net/npm/three@0.187.0/examples/jsm/",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.187.0/examples/jsm/",
  "@sparkjsdev/spark": "https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@2.4.0/dist/spark.module.js"
} }
</script>
<script type="module">
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh, SplatFileType } from "@sparkjsdev/spark";
const msg = document.getElementById("msg");
try {
  const res = await fetch("scene.splat");
  if (!res.ok) throw new Error("No hay scene.splat en esta corrida (¿falló el job?).");
  const bytes = new Uint8Array(await res.arrayBuffer());
  const canvas = document.getElementById("c");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 10000);
  scene.add(new SparkRenderer({ renderer }));
  const mesh = new SplatMesh({ fileBytes: bytes, fileType: SplatFileType.SPLAT });
  await mesh.initialized;
  // Los gaussianos vienen en ENU (x Este, y Norte, z arriba): z arriba → y arriba de three.
  mesh.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  scene.add(mesh);
  mesh.updateMatrixWorld(true);
  // Encuadre con percentiles 2–98: los flotantes no deben alejar la cámara.
  const xs = [], ys = [], zs = [], p = new THREE.Vector3();
  const total = mesh.packedSplats?.numSplats ?? mesh.numSplats;
  const stride = Math.max(1, Math.floor(total / 20000));
  mesh.forEachSplat((i, center, _s, _q, opacity) => {
    if (i % stride || opacity < 0.1) return;
    p.copy(center).applyMatrix4(mesh.matrixWorld); xs.push(p.x); ys.push(p.y); zs.push(p.z);
  });
  const q = (a, f) => { a.sort((x, y) => x - y); return a[Math.floor(f * (a.length - 1))] ?? 0; };
  const lo = new THREE.Vector3(q(xs, 0.02), q(ys, 0.02), q(zs, 0.02));
  const hi = new THREE.Vector3(q(xs, 0.98), q(ys, 0.98), q(zs, 0.98));
  const center = lo.clone().add(hi).multiplyScalar(0.5);
  const size = Math.max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z, 0.5);
  camera.position.copy(center).add(new THREE.Vector3(0.6, 0.5, 0.9).normalize().multiplyScalar(size * 1.4));
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center); controls.enableDamping = true; controls.update();
  const resize = () => { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
  addEventListener("resize", resize); resize();
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
  msg.textContent = __MESSAGE__;
} catch (err) { msg.textContent = String(err && err.message || err); }
</script>
</body></html>
"""


def viewer_html(case: str, run: str, result: dict[str, Any]) -> str:
    stats = (
        f"{result.get('frames_registered')}/{result.get('frame_count')} fotos · PSNR {result.get('psnr_db')} dB · "
        f"{round((result.get('gaussians') or 0) / 1000)} mil gaussianas"
        if result.get("status") == "ready"
        else f"Estado: {result.get('status')}"
    )
    esc = lambda s: str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return (
        VIEWER.replace("__CASE__", esc(case))
        .replace("__RUN__", esc(run))
        .replace("__STATS__", esc(stats))
        .replace("__MESSAGE__", json.dumps(result.get("message") or result.get("error") or "", ensure_ascii=False).replace("<", "\\u003c"))
    )


def latest_run(case: str) -> Path:
    runs = sorted(p for p in (OUT / case).glob("*") if p.is_dir()) if (OUT / case).exists() else []
    if not runs:
        raise SystemExit(f"No hay corridas de «{case}» en {OUT}.")
    return runs[-1]


def serve(case: str, port: int) -> None:
    folder = latest_run(case)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(folder))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        log(f"Visor de {case} ({folder.name}): http://127.0.0.1:{port}/ver.html   (Ctrl+C para cerrar)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


def print_table() -> None:
    if not TABLE.exists():
        raise SystemExit("Todavía no hay corridas.")
    rows = [line.split("\t") for line in TABLE.read_text().splitlines() if line.strip()]
    widths = [max(len(r[i]) for r in rows if i < len(r)) for i in range(len(rows[0]))]
    for r in rows:
        log("  ".join(c.ljust(w) for c, w in zip(r, widths)))


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("revisar", help="revisión local, sin GPU")
    r.add_argument("carpeta", type=Path)
    c = sub.add_parser("correr", help="reconstrucción en la GPU")
    c.add_argument("carpeta", type=Path)
    c.add_argument("--caso", required=True)
    c.add_argument("--iteraciones", type=int, default=7000)
    c.add_argument("--gps", action="store_true", help="usar el GPS de las fotos (al aire libre; adentro el GPS confunde la escala)")
    c.add_argument("--igual", action="store_true", help="correr aunque la revisión encuentre un problema grave")
    c.add_argument("--por-medio", type=int, default=0, help="repartir en medios de N fotos (12 = como la app); 0 = todas juntas")
    v = sub.add_parser("ver", help="visor 3D de la última corrida de un caso")
    v.add_argument("caso")
    v.add_argument("--puerto", type=int, default=8090)
    sub.add_parser("tabla", help="todas las corridas")
    a = ap.parse_args(list(argv) if argv is not None else None)
    if a.cmd == "revisar":
        _, msgs, _ = review(a.carpeta.expanduser())
        return 1 if any(level == "error" for level, _ in msgs) else 0
    if a.cmd == "correr":
        if not 500 <= a.iteraciones <= 30000:
            raise SystemExit("--iteraciones entre 500 y 30000.")
        run_case(a.carpeta.expanduser(), a.caso, a.iteraciones, a.gps, a.igual, max(0, a.por_medio))
        return 0
    if a.cmd == "ver":
        serve(a.caso, a.puerto)
        return 0
    print_table()
    return 0


if __name__ == "__main__":
    sys.exit(main())
