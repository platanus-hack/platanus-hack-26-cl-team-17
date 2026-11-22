"""Pruebas de tools/prueba_fotos.py (sin GPU ni red): revisión del set y manifiesto."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

_SPEC = importlib.util.spec_from_file_location("prueba_fotos", Path(__file__).resolve().parents[1] / "tools" / "prueba_fotos.py")
assert _SPEC and _SPEC.loader
pf = importlib.util.module_from_spec(_SPEC)
sys.modules["prueba_fotos"] = pf  # las dataclasses lo buscan ahí
_SPEC.loader.exec_module(pf)


def textured(seed: int, h: int = 900, w: int = 1400) -> np.ndarray:
    """Escena plana con mucha textura (manchas y líneas) para que SIFT encuentre puntos."""
    rng = np.random.default_rng(seed)
    img = np.full((h, w, 3), 128, np.uint8)
    for _ in range(500):
        c = tuple(int(x) for x in rng.integers(0, 255, 3))
        x, y = int(rng.integers(0, w)), int(rng.integers(0, h))
        cv2.circle(img, (x, y), int(rng.integers(4, 30)), c, -1)
        cv2.line(img, (x, y), (int(rng.integers(0, w)), int(rng.integers(0, h))), c, 2)
    return img


def save_views(folder: Path, base: np.ndarray, prefix: str, n: int) -> None:
    """Vistas de una superficie plana desde el mismo punto (solo homografías: sin paralaje)."""
    h, w = base.shape[:2]
    for i in range(n):
        dx = 30 * i
        src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        dst = np.float32([[dx, 10 * i], [w + dx - 15 * i, 0], [w + dx, h], [dx + 12 * i, h - 8 * i]])
        warped = cv2.warpPerspective(base, cv2.getPerspectiveTransform(src, dst), (w, h))
        cv2.imwrite(str(folder / f"{prefix}_{i:02d}.jpg"), warped[:, : w - 200])


class ReportTest(unittest.TestCase):
    def test_grupos_sueltas_y_paralaje(self):
        # 0-1-2 encadenadas con paralaje; 3-4 juntas pero sin paralaje (homografía); 5 suelta.
        edges = {(0, 1): (120, 30), (1, 2): (90, 20), (3, 4): (100, 98), (0, 5): (3, 3), (2, 3): (10, 9)}
        rep = pf.overlap_report(6, edges)
        self.assertEqual(rep["principal"], [0, 1, 2])
        self.assertEqual([len(c) for c in rep["componentes"]], [3, 2, 1])
        self.assertEqual(rep["sueltas"], [5])
        self.assertAlmostEqual(rep["sin_paralaje"], 1 / 3)

    def test_veredicto(self):
        names = [f"f{i}.jpg" for i in range(30)]
        self.assertEqual(pf.verdict(5, [], None, names)[0][0], "error")
        ok = {"componentes": [list(range(30))], "principal": list(range(30)), "sueltas": [], "debiles": [], "pares_solapados": 80, "sin_paralaje": 0.1}
        self.assertEqual([lvl for lvl, _ in pf.verdict(30, [], ok, names)], ["ok"])
        split = {**ok, "componentes": [list(range(15)), list(range(15, 30))], "principal": list(range(15))}
        msgs = pf.verdict(30, [3], split, names)
        self.assertIn("error", [lvl for lvl, _ in msgs])
        self.assertTrue(any("movida" in t for _, t in msgs))
        flat = {**ok, "sin_paralaje": 0.9}
        self.assertTrue(any("homografía" in t for _, t in pf.verdict(30, [], flat, names)))
        self.assertTrue(any("caben" in t for _, t in pf.verdict(90, [], {**ok, "principal": list(range(90))}, [f"x{i}" for i in range(90)])))

    def test_movidas_y_gps(self):
        self.assertEqual(pf.blurry_indices([100, 110, 90, 5, 120]), [3])
        self.assertAlmostEqual(pf.dms_to_deg((33, 26, 56.04), "S"), -33.4489, places=4)
        self.assertIsNone(pf.dms_to_deg(None, "N"))


class ManifestTest(unittest.TestCase):
    def test_un_medio_de_fotos_que_el_job_acepta(self):
        from splat.manifest import parse_manifest

        frames = [{"file": f"{i:03d}.jpg", "t_s": float(i), "lat": None, "lng": None} for i in range(12)]
        raw = pf.build_manifest("sala-1", "20261121-220000", frames, 7000, pf.DEFAULT_ORIGIN)
        self.assertEqual(raw["output_prefix"], "test/fotos/sala-1/20261121-220000/out/")
        self.assertEqual(raw["media"][0]["frames"][3]["path"], "test/fotos/sala-1/20261121-220000/fotos/003.jpg")
        m = parse_manifest(raw)  # el mismo validador que usa el job
        self.assertEqual(len(m.media), 1)
        self.assertEqual(len(m.media[0].frames), 12)
        self.assertIsNone(m.media[0].video_path)
        # Como la app: grupos de 12 fotos, cada uno un medio.
        app = parse_manifest(pf.build_manifest("sala-1", "r", frames + frames[:5], 7000, pf.DEFAULT_ORIGIN, per_media=12))
        self.assertEqual([len(x.frames) for x in app.media], [12, 5])

    def test_resumen(self):
        result = {"status": "ready", "message": "Escena 3D lista.", "frames_registered": 38, "frame_count": 40, "psnr_db": 30.2, "gaussians": 512000, "gpu_seconds": 300, "alignment": "approximate", "cleanup": {"aplicada": True, "peso_quitado": 0.05, "peso_principal": 0.9}}
        cons = {"failed": True, "checks": [{"name": "flotantes", "status": "falla", "detail": "21 % flotando"}, {"name": "vertical", "status": "ok", "detail": ""}]}
        text = "\n".join(pf.summarize(result, cons))
        self.assertIn("38/40", text)
        self.assertIn("flotantes: 21 % flotando", text)
        self.assertNotIn("vertical", text)
        self.assertIn("FALLA", text)
        html = pf.viewer_html("sala-1", "x", {**result, "message": "</script><b>"})
        self.assertNotIn("</script><b>", html)


class ReviewOnImagesTest(unittest.TestCase):
    """Con imágenes sintéticas: un set partido en dos y uno sin paralaje deben avisarse."""

    def test_set_partido_y_sin_paralaje(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            save_views(folder, textured(1), "a", 6)
            save_views(folder, textured(2), "b", 6)
            _, msgs, summary = pf.review(folder)
            text = " ".join(t for _, t in msgs)
            self.assertEqual(summary["fotos"], 12)
            self.assertIn("error", [lvl for lvl, _ in msgs])
            self.assertIn("se parte", text)
            self.assertIn("homografía", text)


if __name__ == "__main__":
    unittest.main()
