"""Exporta los modelos del detector de Vigía a ONNX (solo se corre una vez, o al cambiar vocab.py).

Descarga a detector/models/:
  - yoloe-26{s,n}-seg.pt   (YOLOE-26, vocabulario abierto) y su codificador de texto mobileclip2_b.ts
  - yolo26n-pose.pt        (keypoints, para marcar personas tendidas)
  - bus.jpg                (imagen de prueba)
y deja:
  - vigia-yoloe-26{s,n}.onnx + .json   (clases fijadas desde vocab.py, cabeza end-to-end sin NMS)
  - yolo26n-pose.onnx                  (cabeza end-to-end sin NMS)

Uso:  .venv/bin/python export.py [--size s|n] [--no-pose] [--imgsz 640]

Este script sí necesita torch y ultralytics (requirements-export.txt). El servidor no.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELS = HERE / "models"
sys.path.insert(0, str(HERE))

from vocab import VOCAB, prompts  # noqa: E402

BUS_URL = "https://ultralytics.com/images/bus.jpg"


def onnx_io(path: Path) -> dict:
    """Formas reales de entradas y salidas del ONNX (para registrarlas en el JSON)."""
    import onnx

    m = onnx.load(str(path), load_external_data=False)

    def shape(v):
        return [d.dim_value if d.dim_value else d.dim_param for d in v.type.tensor_type.shape.dim]

    return {
        "inputs": {i.name: shape(i) for i in m.graph.input},
        "outputs": {o.name: shape(o) for o in m.graph.output},
    }


def drop_proto_output(path: Path) -> None:
    """Quita la salida de prototipos de máscara (no usamos máscaras) y la rama que solo la alimenta."""
    import onnx

    m = onnx.load(str(path))
    if len(m.graph.output) < 2:
        return
    keep = m.graph.output[0].name
    tmp = path.with_suffix(".full.onnx")
    shutil.move(path, tmp)
    onnx.utils.extract_model(str(tmp), str(path), [i.name for i in m.graph.input], [keep])
    # extract_model no conserva metadata_props: los copiamos para no perder nombres de clases, stride, etc.
    out = onnx.load(str(path))
    del out.metadata_props[:]
    out.metadata_props.extend(m.metadata_props)
    onnx.save(out, str(path))
    tmp.unlink()


def export_yoloe(size: str, imgsz: int) -> Path:
    from ultralytics import YOLOE

    pairs = prompts()
    model = YOLOE(f"yoloe-26{size}-seg.pt")
    model.set_classes([p for p, _ in pairs])  # descarga mobileclip2_b.ts la primera vez
    out = Path(model.export(format="onnx", imgsz=imgsz, nms=False, simplify=True, dynamic=False, batch=1))
    dst = MODELS / f"vigia-yoloe-26{size}.onnx"
    shutil.move(out, dst)
    drop_proto_output(dst)
    meta = {
        "model": f"yoloe-26{size}-seg",
        "input": imgsz,
        "classes": [{"prompt": p, "label": lab} for p, lab in pairs],
        "labels": [lab for lab, _ in VOCAB],
        "onnx": onnx_io(dst),
        "output_format": "e2e: [x1, y1, x2, y2, score, class_index, 32 coef. de máscara] en píxeles de la entrada",
    }
    dst.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    print(f"OK {dst.name}: {meta['onnx']}")
    return dst


def export_pose(imgsz: int) -> Path:
    from ultralytics import YOLO

    model = YOLO("yolo26n-pose.pt")
    out = Path(model.export(format="onnx", imgsz=imgsz, nms=False, simplify=True, dynamic=False, batch=1))
    dst = MODELS / "yolo26n-pose.onnx"
    if out != dst:
        shutil.move(out, dst)
    meta = {"model": "yolo26n-pose", "input": imgsz, "onnx": onnx_io(dst)}
    dst.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    print(f"OK {dst.name}: {meta['onnx']}")
    return dst


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--size", choices=["s", "n"], default="s", help="variante de YOLOE-26 (s por defecto)")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--no-pose", action="store_true", help="no exportar el modelo de pose")
    args = ap.parse_args()

    MODELS.mkdir(exist_ok=True)
    os.chdir(MODELS)  # ultralytics descarga pesos y el .ts de CLIP al directorio actual
    if not (MODELS / "bus.jpg").exists():
        urllib.request.urlretrieve(BUS_URL, MODELS / "bus.jpg")
    export_yoloe(args.size, args.imgsz)
    if not args.no_pose:
        export_pose(args.imgsz)


if __name__ == "__main__":
    main()
