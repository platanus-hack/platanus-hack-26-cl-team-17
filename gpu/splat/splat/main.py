"""Punto de entrada del job vigia-splat (Cloud Run jobs con GPU).

Variables de entorno (overrides de la ejecución):
  SPLAT_MANIFEST_URI    gs://<bucket>/incidents/<id>/reconstructions/<rec>/manifest.json
  SPLAT_CALLBACK_TOKEN  token Bearer para el callback (lo genera y verifica la app)
Fijas del job: SPLAT_GPU_TYPE, VGGT_WEIGHTS, SPLAT_WORKDIR, SPLAT_TIME_BUDGET_S (el timeout de la
tarea en segundos: el entrenamiento se ajusta para terminar antes).
"""

from __future__ import annotations

import os
import shutil
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any

T0 = time.monotonic()

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402

from . import gcs  # noqa: E402
from .align import CameraInfo, align_scene, apply_to_cameras, apply_to_points  # noqa: E402
from .callback import Cancelled, Reporter  # noqa: E402
from .cleanup import export_mask, remove_outliers  # noqa: E402
from .consistency import analyze, cleanup_mask  # noqa: E402
from .depthmap import FrameDepth, to_world  # noqa: E402
from .frames import (  # noqa: E402
    FRAME_LONG_EDGE_PX,
    FrameCandidate,
    VideoSamplingError,
    frame_candidates,
    laplacian_sharpness,
    plan_frames,
    sample_video,
    video_candidates,
)
from .manifest import Manifest, ManifestError, ManifestMedia, parse_gs_uri, parse_manifest  # noqa: E402
from .splat_io import DEFAULT_MAX_GAUSSIANS, encode_splat  # noqa: E402

MIN_FRAMES = 3
MIN_POINTS = 1000
MAX_INIT_POINTS = 300_000
# Tiempo reservado al final para exportar, renderizar la vista previa y subir los archivos.
EXPORT_RESERVE_S = 240.0
DEFAULT_TIME_BUDGET_S = 2700.0
# Si la limpieza de la exportación borraría más que esto, la caja de la escena está mal: no se aplica.
MAX_CLEANUP_LOSS = 0.5
IDENTITY = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]
STATIC_WARNING = (
    "Las personas y vehículos en movimiento no quedan en la reconstrucción: no la uses para descartar víctimas."
)


class PipelineError(RuntimeError):
    """Falla esperable con un mensaje en español para el puesto de mando."""


def log(msg: str) -> None:
    print(f"[splat] {msg}", flush=True)


def log_err(msg: str) -> None:
    print(f"[splat] {msg}", file=sys.stderr, flush=True)


def fmt_int(n: int) -> str:
    return f"{n:,}".replace(",", ".")


def fmt_count(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f} M".replace(".", ",")
    if n >= 10_000:
        return f"{round(n / 1000)} mil"
    return fmt_int(n)


def fmt_dec(x: float, digits: int = 1) -> str:
    return f"{x:.{digits}f}".replace(".", ",")


def quality_label(psnr: float) -> str:
    if psnr >= 25:
        return "buena"
    if psnr >= 20:
        return "media"
    return "baja"


def plural(n: int, one: str, many: str) -> str:
    return f"{fmt_int(n)} {one if n == 1 else many}"


# ───────────────────────────── preparación ─────────────────────────────


def _ext(path: str, default: str) -> str:
    base = os.path.basename(path)
    return os.path.splitext(base)[1].lower() or default


def _download_frames(m: Manifest, media: ManifestMedia, index: int, root: str) -> list[FrameCandidate]:
    items = [(f.path, os.path.join(root, f"m{index}", "frames", f"{k:05d}{_ext(f.path, '.jpg')}")) for k, f in enumerate(media.frames)]
    results = gcs.download_many(m.bucket, items)
    ok_paths: list[str] = []
    ok_frames = []
    for f, r in zip(media.frames, results):
        if isinstance(r, Exception):
            log_err(f"{media.label}: no pude descargar {f.path}: {r}")
            continue
        ok_paths.append(r)
        ok_frames.append(f)
    sub = ManifestMedia(**{**media.__dict__, "frames": tuple(ok_frames)})
    return frame_candidates(sub, index, ok_paths)


def gather_candidates(m: Manifest, root: str) -> list[list[FrameCandidate]]:
    """Descarga y muestrea cada medio. Un medio que falla se omite (se registra) y el resto sigue."""
    videos = [(i, x) for i, x in enumerate(m.media) if x.video_path]
    video_items = [(x.video_path or "", os.path.join(root, f"m{i}", f"video{_ext(x.video_path or '', '.mp4')}")) for i, x in videos]
    video_files = dict(zip([i for i, _ in videos], gcs.download_many(m.bucket, video_items, workers=4)))

    def one(i: int, media: ManifestMedia) -> list[FrameCandidate]:
        if media.video_path:
            got = video_files.get(i)
            if isinstance(got, str):
                try:
                    samples = sample_video(got, os.path.join(root, f"m{i}", "sampled"), m.sample_fps, FRAME_LONG_EDGE_PX)
                    if samples:
                        log(f"{media.label}: {len(samples)} cuadros muestreados del video a {m.sample_fps:g} fps")
                        return video_candidates(media, i, samples)
                except VideoSamplingError as e:
                    log_err(f"{media.label}: ffmpeg no pudo leer el video: {e}")
            else:
                log_err(f"{media.label}: no pude descargar el video: {got}")
        if media.frames:
            cands = _download_frames(m, media, i, root)
            log(f"{media.label}: {len(cands)} cuadros ya extraídos")
            return cands
        return []

    with ThreadPoolExecutor(max_workers=4) as pool:
        per_media = list(pool.map(lambda p: one(*p), list(enumerate(m.media))))
    # Nitidez en paralelo (OpenCV libera el GIL).
    with ThreadPoolExecutor(max_workers=16) as pool:
        scored: list[list[FrameCandidate]] = []
        for cands in per_media:
            scores = list(pool.map(laplacian_sharpness, [c.local_path for c in cands]))
            scored.append([FrameCandidate(**{**c.__dict__, "sharpness": s}) for c, s in zip(cands, scores) if s >= 0])
    return scored


def load_image(path: str) -> np.ndarray | None:
    bgr = cv2.imread(path, cv2.IMREAD_COLOR)
    if bgr is None:
        return None
    h, w = bgr.shape[:2]
    scale = FRAME_LONG_EDGE_PX / max(h, w)
    if scale < 1:
        bgr = cv2.resize(bgr, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


# ───────────────────────────── pipeline ─────────────────────────────


def time_budget_s() -> float:
    try:
        v = float(os.environ.get("SPLAT_TIME_BUDGET_S", ""))
    except ValueError:
        return DEFAULT_TIME_BUDGET_S
    return v if v > 600 else DEFAULT_TIME_BUDGET_S


def media_list(labels: list[str]) -> str:
    quoted = [f"«{x}»" for x in labels]
    return quoted[0] if len(quoted) == 1 else ", ".join(quoted[:-1]) + " y " + quoted[-1]


def run(m: Manifest, rep: Reporter, root: str) -> dict[str, Any]:
    from .posing import estimate_poses, vggt_frame_cap
    from .register import register
    from .train import preview_camera, render_view, train_splats

    if not torch.cuda.is_available():
        raise PipelineError("El job no encontró una GPU CUDA disponible.")
    device = torch.device("cuda")
    props = torch.cuda.get_device_properties(0)
    if not rep.gpu:
        rep.gpu = props.name
    log(f"GPU {props.name} · {props.total_memory / 1e9:.0f} GB · sm_{props.major}{props.minor} · torch {torch.__version__} · CUDA {torch.version.cuda}")
    # VGGT corre por medio: el tope de memoria aplica a cada uno, no al total.
    per_media_cap = vggt_frame_cap(props.total_memory)

    n_video = sum(1 for x in m.media if x.video_path)
    n_frame_media = len(m.media) - n_video
    parts = []
    if n_video:
        parts.append(plural(n_video, "video", "videos"))
    if n_frame_media:
        parts.append(f"los cuadros de {plural(n_frame_media, 'medio', 'medios')}")
    rep.send("preparing", 0.02, f"Descargando {' y '.join(parts)}…")
    per_media = gather_candidates(m, root)
    chosen = plan_frames(per_media, m.max_frames, per_media_cap=per_media_cap)
    images: list[np.ndarray] = []
    frames: list[FrameCandidate] = []
    for c in chosen:
        im = load_image(c.local_path)
        if im is not None:
            images.append(im)
            frames.append(c)
    n = len(frames)
    if n < MIN_FRAMES:
        raise PipelineError(
            f"Hacen falta al menos {MIN_FRAMES} cuadros legibles para reconstruir y solo hay {n}. "
            "Revisa que los videos o fotos del incidente se hayan subido completos."
        )
    media_order = sorted({f.media_index for f in frames})
    groups = [[k for k, f in enumerate(frames) if f.media_index == mi] for mi in media_order]
    rep.send("preparing", 0.08, f"Usaré {plural(n, 'cuadro', 'cuadros')} de {plural(len(groups), 'medio', 'medios')}.", frame_count=n)

    # Cámaras con VGGT, un medio a la vez.
    rep.send("posing", 0.10, f"Estimando cámaras de {plural(n, 'cuadro', 'cuadros')} (VGGT)…", frame_count=n)
    t_pose = time.monotonic()
    weights = os.environ.get("VGGT_WEIGHTS", "/opt/models/vggt/model.safetensors")
    poses = estimate_poses(images, groups, weights, device, log=log)
    keep_idx: list[int] = []
    group_of: list[int] = []
    c2w_local: list[np.ndarray] = []
    ks_local: list[np.ndarray] = []
    depths: list[FrameDepth] = []
    group_media: list[int] = []
    for idx, gp in zip(groups, poses):
        ok = np.nonzero(gp.registered)[0]
        if len(ok) == 0:
            continue
        g = len(group_media)
        group_media.append(frames[idx[0]].media_index)
        for k in ok:
            keep_idx.append(idx[k])
            group_of.append(g)
            c2w_local.append(gp.c2w[k])
            ks_local.append(gp.Ks[k])
            depths.append(gp.depths[k])
    log(f"VGGT: {len(keep_idx)}/{n} cuadros confiables en {len(group_media)} medios, {time.monotonic() - t_pose:.0f} s")
    if len(keep_idx) < MIN_FRAMES:
        raise PipelineError(
            f"Solo se pudieron ubicar las cámaras de {len(keep_idx)} de {n} cuadros (hacen falta {MIN_FRAMES}). "
            "Prueba con videos más nítidos, más largos o desde más ángulos de la misma escena."
        )
    images = [images[k] for k in keep_idx]
    frames = [frames[k] for k in keep_idx]
    group_arr = np.array(group_of)
    c2w_arr = np.array(c2w_local)
    ks_arr = np.array(ks_local)

    # Unión de medios y ajuste fino de cámaras.
    msg = "Uniendo los medios y ajustando las cámaras…" if len(group_media) > 1 else "Ajustando las cámaras…"
    rep.send("posing", 0.15, msg, frame_count=n)
    t_reg = time.monotonic()
    dropped_labels: list[str] = []
    bundle_ok = False
    try:
        reg = register(images, group_arr, c2w_arr, ks_arr, depths, log=log, device=device)
        kept = reg.kept
        c2w, ks, depth_scale = reg.c2w, reg.Ks, reg.depth_scale
        ba_points, ba_colors = reg.points, reg.colors
        dropped_labels = [m.media[group_media[g]].label for g in reg.dropped_groups]
        bundle_ok = reg.stats.get("ba") == "ok"
    except Exception:  # noqa: BLE001 — sin registro se sigue con el medio más grande, sin unir
        log_err("El registro entre medios falló; sigo con el medio más grande:\n" + traceback.format_exc())
        biggest = int(np.bincount(group_arr).argmax())
        kept = group_arr == biggest
        c2w, ks, depth_scale = c2w_arr, ks_arr, np.ones(len(images))
        ba_points, ba_colors = np.zeros((0, 3)), np.zeros((0, 3))
        dropped_labels = [m.media[group_media[g]].label for g in range(len(group_media)) if g != biggest]
    log(f"Registro: {int(kept.sum())}/{len(images)} cuadros siguen, {time.monotonic() - t_reg:.0f} s")
    sel = np.nonzero(kept)[0]
    images = [images[k] for k in sel]
    frames = [frames[k] for k in sel]
    depths = [depths[k] for k in sel]
    c2w = c2w[sel]
    ks = ks[sel]
    depth_scale = depth_scale[sel]
    r = len(sel)
    if r < MIN_FRAMES:
        raise PipelineError(
            f"Solo quedaron {r} cuadros con cámaras consistentes (hacen falta {MIN_FRAMES}). "
            "Prueba con videos más nítidos o que recorran la escena con más calma."
        )

    # Nube inicial: profundidad de VGGT de cada cuadro con su escala corregida + puntos ajustados.
    rng = np.random.default_rng(0)
    per_frame = max(2000, (2 * MAX_INIT_POINTS) // r)
    pts_l: list[np.ndarray] = []
    col_l: list[np.ndarray] = []
    for k in range(r):
        cam_pts, cols = depths[k].cam_points(images[k], per_frame, rng)
        pts_l.append(to_world(c2w[k], cam_pts, depth_scale[k]))
        col_l.append(cols)
    dense = np.concatenate(pts_l) if pts_l else np.zeros((0, 3))
    dense_cols = np.concatenate(col_l) if col_l else np.zeros((0, 3))
    dense, dense_cols = remove_outliers(dense, dense_cols)
    if len(dense) > MAX_INIT_POINTS:
        pick = rng.choice(len(dense), size=MAX_INIT_POINTS, replace=False)
        dense, dense_cols = dense[pick], dense_cols[pick]
    points = np.concatenate((dense, ba_points))
    colors = np.concatenate((dense_cols, ba_colors))
    log(f"Nube inicial: {len(dense)} puntos densos + {len(ba_points)} ajustados")
    if len(points) < MIN_POINTS:
        raise PipelineError("La estimación de cámaras no dejó suficientes puntos 3D confiables para entrenar la escena.")
    del depths

    accuracy = {x.id: x.accuracy_m for x in m.media}
    cams = [
        CameraInfo(
            source=f.source,
            media_id=f.media_id,
            lat=f.lat,
            lng=f.lng,
            alt_m=f.alt_m,
            heading_deg=f.heading_deg,
            per_frame_gps=f.per_frame_gps,
            accuracy_m=accuracy.get(f.media_id),
        )
        for f in frames
    ]
    alignment = align_scene(c2w, cams, points, m.origin_lat, m.origin_lng)
    log(f"Alineación {alignment.mode}: {alignment.note}")
    c2w_enu = apply_to_cameras(alignment.matrix, c2w)
    points_enu = apply_to_points(alignment.matrix, points)
    used_media = len({f.media_id for f in frames})
    pose_msg = f"Cámaras ubicadas en {r} de {n} cuadros de {plural(used_media, 'medio', 'medios')}."
    if dropped_labels:
        pose_msg += f" Quedó fuera {media_list(dropped_labels)}: no coincide con el resto de la escena." if len(dropped_labels) == 1 else f" Quedaron fuera {media_list(dropped_labels)}: no coinciden con el resto de la escena."
    rep.send(
        "posing",
        0.20,
        f"{pose_msg} {alignment.note}",
        frame_count=n,
        frames_registered=r,
        alignment=alignment.mode,
        scale_known=alignment.scale_known,
    )

    # Entrenamiento, con plazo para que siempre quede tiempo de exportar.
    def on_progress(step: int, total: int, count: int, psnr: float) -> None:
        rep.training(
            step,
            total,
            0.22,
            0.68,
            f"Entrenando la escena: paso {fmt_int(step)} de {fmt_int(total)} · {fmt_count(count)} gaussianas",
            gaussians=count,
        )

    t_train = time.monotonic()
    deadline = T0 + time_budget_s() - EXPORT_RESERVE_S
    trained, params = train_splats(
        images, c2w_enu, ks, points_enu, colors, m.iterations, device, on_progress, log=log, deadline=deadline
    )
    log(f"gsplat: {trained.count} gaussianas, {trained.steps} pasos, PSNR {trained.psnr:.2f} dB, {time.monotonic() - t_train:.0f} s")

    # Exportación, sin el fondo lejano ni las gaussianas desmesuradas.
    rep.send("exporting", 0.92, f"Exportando la escena ({fmt_count(trained.count)} gaussianas)…", gaussians=trained.count)
    mask = export_mask(trained.means, trained.log_scales, points_enu, trained.c2w[:, :3, 3])
    if mask.sum() < (1.0 - MAX_CLEANUP_LOSS) * len(mask):
        log(f"Limpieza omitida: habría dejado {int(mask.sum())} de {len(mask)} gaussianas")
        mask = np.ones(len(mask), dtype=bool)
    else:
        log(f"Limpieza: fuera {int((~mask).sum())} gaussianas lejanas o desmesuradas")
    # Flotantes, sueltas y lo que quedó bajo el suelo (splat/consistency.py).
    clean: dict[str, Any] = {"aplicada": False}
    try:
        sub = np.nonzero(mask)[0]
        keep_sub, clean = cleanup_mask(trained.means[sub], trained.log_scales[sub], trained.opacity_logits[sub])
        if clean["aplicada"]:
            mask[sub[~keep_sub]] = False
            log(
                f"Limpieza de flotantes en {clean['pasadas']} pasadas: fuera {clean['islas_flotantes']} islas flotantes "
                f"({clean['flotantes']} gaussianas), {clean['sueltas']} sueltas y {clean['bajo_suelo']} bajo el suelo "
                f"({clean['peso_quitado']:.1%} del peso visual)"
                + (f"; {clean['motivo']}" if clean.get("motivo") else "")
            )
        else:
            log(f"Limpieza de flotantes omitida: {clean.get('motivo', 'no había nada que quitar')}")
    except Exception as e:  # noqa: BLE001 — la limpieza nunca debe tumbar la reconstrucción
        log_err(f"Limpieza de flotantes falló, se exporta sin ella: {type(e).__name__}: {e}")
        clean = {"aplicada": False, "motivo": f"error: {type(e).__name__}"}
    data, written = encode_splat(
        trained.means[mask],
        trained.log_scales[mask],
        trained.quats_wxyz[mask],
        trained.sh0[mask],
        trained.opacity_logits[mask],
        DEFAULT_MAX_GAUSSIANS,
    )
    if written == 0:
        raise PipelineError("El entrenamiento no dejó gaussianas visibles para exportar.")
    splat_file = os.path.join(root, "scene.splat")
    with open(splat_file, "wb") as fh:
        fh.write(data)
    splat_path = m.output_path("scene.splat")
    gcs.upload_file(m.bucket, splat_path, splat_file, "application/octet-stream")
    log(f"scene.splat: {written} gaussianas, {len(data) / 1e6:.1f} MB → gs://{m.bucket}/{splat_path}")

    k = preview_camera(trained.c2w)
    h, w = images[k].shape[:2]
    view = render_view(params, trained.c2w[k], ks[k], w, h, device)
    preview_file = os.path.join(root, "preview.jpg")
    cv2.imwrite(preview_file, cv2.cvtColor(view, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 88])
    gcs.upload_file(m.bucket, m.output_path("preview.jpg"), preview_file, "image/jpeg")
    del params
    torch.cuda.empty_cache()

    if alignment.mode == "gps":
        align_txt = f"alineada con GPS (error medio {fmt_dec(alignment.gps_rms_m or 0, 0)} m)"
    elif alignment.mode == "approximate":
        align_txt = "ubicación, rumbo y escala aproximados"
    else:
        align_txt = "sin alinear al mapa"
    extra = ""
    if dropped_labels:
        extra += f" Sin {media_list(dropped_labels)} (no coincide con el resto)." if len(dropped_labels) == 1 else f" Sin {media_list(dropped_labels)} (no coinciden con el resto)."
    if clean.get("aplicada") and clean.get("islas_flotantes"):
        extra += f" Se quitaron {plural(int(clean['islas_flotantes']), 'objeto flotante', 'objetos flotantes')}."
    result = dict(
        frame_count=n,
        frames_registered=r,
        splat_path=splat_path,
        splat_format="splat",
        transform=IDENTITY,
        alignment=alignment.mode,
        scale_known=alignment.scale_known,
        gaussians=written,
        iterations=trained.steps,
        error=None,
    )
    # Pruebas de consistencia sobre lo que se exportó (consistency.json, solo diagnóstico).
    checks: dict[str, str] = {}
    try:
        report = analyze(data, {**result, "status": "ready"})
        checks = report.summary()
        gcs.upload_json(m.bucket, m.output_path("consistency.json"), {**report.to_dict(), "limpieza": clean})
        failing = [c.name for c in report.checks if c.status == "falla"]
        log(f"Consistencia: {'falla en ' + ', '.join(failing) if failing else 'sin fallas'} · {checks}")
        if "flotantes" in failing or "vertical" in failing:
            extra += " Revisa la escena: quedan partes flotando o la vertical está torcida."
    except Exception as e:  # noqa: BLE001 — es solo diagnóstico
        log_err(f"No pude correr las pruebas de consistencia: {type(e).__name__}: {e}")
    message = (
        f"Escena 3D lista: {fmt_count(written)} gaussianas desde {r} de {n} cuadros, {align_txt}. "
        f"Calidad del ajuste {quality_label(trained.psnr)} (PSNR {fmt_dec(trained.psnr)} dB).{extra} {STATIC_WARNING}"
    )
    rep.send("ready", 1.0, message, final=True, **result)
    return {
        **(rep.last or {}),
        "alignment_note": alignment.note,
        "psnr_db": round(trained.psnr, 2),
        "dropped_media": dropped_labels,
        "bundle_adjusted": bundle_ok,
        "cleanup": clean,
        "consistency": checks,
    }


def _report_unparseable(raw: Any, token: str, gpu: str | None, error: str) -> None:
    """Si el manifiesto no valida pero trae callback, se avisa igual al puesto de mando."""
    if isinstance(raw, dict) and isinstance(raw.get("callback_url"), str) and isinstance(raw.get("reconstruction_id"), str):
        Reporter(raw["callback_url"], token, raw["reconstruction_id"], gpu, started_at=T0).fail(error)


def main() -> int:
    uri = os.environ.get("SPLAT_MANIFEST_URI", "").strip()
    token = os.environ.get("SPLAT_CALLBACK_TOKEN", "")
    gpu = os.environ.get("SPLAT_GPU_TYPE") or None
    root = os.environ.get("SPLAT_WORKDIR", "/tmp/splat")
    if not uri:
        log_err("Falta SPLAT_MANIFEST_URI: no hay nada que reconstruir.")
        return 2
    raw: Any = None
    try:
        bucket, name = parse_gs_uri(uri)
        raw = gcs.read_json(bucket, name)
        manifest = parse_manifest(raw)
    except ManifestError as e:
        log_err(f"Manifiesto inválido: {e}")
        _report_unparseable(raw, token, gpu, f"Manifiesto inválido: {e}")
        return 2
    except Exception as e:  # noqa: BLE001 — sin manifiesto no hay a quién avisar
        log_err(f"No pude leer el manifiesto {uri}: {type(e).__name__}: {e}")
        return 2

    log(f"Reconstrucción {manifest.reconstruction_id} del incidente {manifest.incident_id}: {len(manifest.media)} medios, {manifest.iterations} iteraciones, hasta {manifest.max_frames} cuadros a {manifest.sample_fps:g} fps")
    rep = Reporter(manifest.callback_url, token, manifest.reconstruction_id, gpu, started_at=T0)
    shutil.rmtree(root, ignore_errors=True)
    os.makedirs(root, exist_ok=True)
    try:
        result = run(manifest, rep, root)
        try:
            gcs.upload_json(manifest.bucket, manifest.output_path("result.json"), result)
        except Exception as e:  # noqa: BLE001 — es solo diagnóstico
            log_err(f"No pude subir result.json: {e}")
        log(f"Listo en {rep.gpu_seconds():.0f} s (callbacks enviados: {rep.sent}, fallidos: {rep.failures})")
        return 0
    except Cancelled:
        rep.fail("Cancelada")
    except PipelineError as e:
        rep.fail(str(e))
    except torch.cuda.OutOfMemoryError:
        log_err(traceback.format_exc())
        rep.fail("La GPU se quedó sin memoria. Prueba con menos cuadros o menos iteraciones.")
    except Exception as e:  # noqa: BLE001 — todo error termina en failed con mensaje
        log_err(traceback.format_exc())
        rep.fail(f"Error inesperado en el job de GPU ({type(e).__name__}: {str(e)[:300]}).")
    try:
        gcs.upload_json(manifest.bucket, manifest.output_path("result.json"), rep.last or {})
    except Exception as e:  # noqa: BLE001
        log_err(f"No pude subir result.json: {e}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
