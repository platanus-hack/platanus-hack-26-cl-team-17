import math
import unittest

import numpy as np

from splat import consistency as C
from splat.splat_io import encode_splat

FLAT = (0.06, 0.06, 0.005)  # un pedazo de suelo o de pared


def grid(x0, x1, y0, y1, z, step=0.1):
    xs, ys = np.meshgrid(np.arange(x0, x1, step), np.arange(y0, y1, step))
    return np.column_stack([xs.ravel(), ys.ravel(), np.full(xs.size, z)])


def wall_x(x, y0, y1, z0, z1, step=0.1):
    ys, zs = np.meshgrid(np.arange(y0, y1, step), np.arange(z0, z1, step))
    return np.column_stack([np.full(ys.size, x), ys.ravel(), zs.ravel()])


def wall_y(y, x0, x1, z0, z1, step=0.1):
    xs, zs = np.meshgrid(np.arange(x0, x1, step), np.arange(z0, z1, step))
    return np.column_stack([xs.ravel(), np.full(xs.size, y), zs.ravel()])


def blob(center, radius, n, seed=0):
    rng = np.random.default_rng(seed)
    v = rng.normal(size=(n, 3))
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    return np.asarray(center) + v * radius * rng.uniform(0.3, 1.0, size=(n, 1))


class Scene:
    """Suelo de 6 × 6 con un edificio de 2 × 2 × 2 en el centro (z arriba)."""

    def __init__(self):
        self.parts: list[tuple[np.ndarray, tuple[float, float, float], float]] = []
        self.add(grid(0, 6, 0, 6, 0.0), FLAT, 0.8)
        for p in (wall_x(2, 2, 4, 0.1, 2), wall_x(4, 2, 4, 0.1, 2), wall_y(2, 2, 4, 0.1, 2), wall_y(4, 2, 4, 0.1, 2)):
            self.add(p, FLAT, 0.8)
        self.add(grid(2, 4, 2, 4, 2.0), FLAT, 0.8)

    def add(self, pts, scale, alpha):
        self.parts.append((np.asarray(pts, float), scale, alpha))
        return self

    def arrays(self, rot=None, k=1.0):
        pos = np.concatenate([p for p, _, _ in self.parts])
        scale = np.concatenate([np.tile(s, (len(p), 1)) for p, s, _ in self.parts])
        alpha = np.concatenate([np.full(len(p), a) for p, _, a in self.parts])
        if rot is not None:
            pos = pos @ rot.T
        return pos * k, scale * k, alpha

    def splat(self, rot=None, k=1.0) -> bytes:
        pos, scale, alpha = self.arrays(rot, k)
        n = len(pos)
        quats = np.tile([1.0, 0, 0, 0], (n, 1))
        data, _ = encode_splat(pos, np.log(scale), quats, np.zeros((n, 3)), np.log(alpha / (1 - alpha)))
        return data


def statuses(data: bytes, result=None) -> dict[str, str]:
    return C.analyze(data, result).summary()


def rot_x(deg):
    a = math.radians(deg)
    return np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])


class ConsistencyTest(unittest.TestCase):
    def test_clean_scene_passes(self):
        rep = C.analyze(Scene().splat())
        s = rep.summary()
        self.assertFalse(rep.failed, C.format_report(rep))
        for name in ("integridad", "aisladas", "flotantes", "bajo_suelo", "vertical", "tamanos", "fondo"):
            self.assertEqual(s[name], "ok", f"{name}: {C.format_report(rep)}")

    def test_floating_blob_is_detected(self):
        sc = Scene().add(blob((1.0, 1.0, 2.0), 0.25, 300), (0.05, 0.05, 0.05), 0.8)
        rep = C.analyze(sc.splat())
        flo = next(c for c in rep.checks if c.name == "flotantes")
        self.assertEqual(flo.status, "falla", C.format_report(rep))
        self.assertEqual(flo.data["total_grupos"], 1)
        g = flo.data["grupos"][0]
        self.assertAlmostEqual(g["centro"][2], 2.0, delta=0.2)
        self.assertGreater(g["altura_base"], 1.0)

    def test_object_resting_on_ground_is_not_floating(self):
        # Una caja de 0,4 m sobre el suelo, lejos del edificio: un objeto aparte, no flotante.
        box = np.concatenate([wall_x(5.0, 5.0, 5.4, 0.1, 0.5), wall_x(5.4, 5.0, 5.4, 0.1, 0.5), grid(5.0, 5.4, 5.0, 5.4, 0.5)])
        self.assertEqual(statuses(Scene().add(box, FLAT, 0.8).splat())["flotantes"], "ok")

    def test_reflection_below_floor_is_detected(self):
        sc = Scene().add(grid(0, 1, 0, 3, -1.0), FLAT, 0.8)
        self.assertEqual(statuses(sc.splat())["bajo_suelo"], "falla")

    def test_tilted_scene_fails_vertical(self):
        s = statuses(Scene().splat(rot=rot_x(30)))
        self.assertEqual(s["vertical"], "falla")

    def test_isolated_points_are_detected(self):
        rng = np.random.default_rng(3)
        loose = np.column_stack([rng.uniform(0, 6, 30), rng.uniform(0, 6, 30), rng.uniform(3, 6, 30)])
        rep = C.analyze(Scene().add(loose, (0.01, 0.01, 0.01), 0.8).splat())
        iso = next(c for c in rep.checks if c.name == "aisladas")
        self.assertGreaterEqual(iso.data["cantidad"], 25)

    def test_flat_discs_are_not_needles_but_needles_are(self):
        self.assertEqual(statuses(Scene().splat())["tamanos"], "ok")
        rng = np.random.default_rng(4)
        sticks = np.column_stack([rng.uniform(0, 6, 400), rng.uniform(0, 6, 400), np.full(400, 0.02)])
        sc = Scene().add(sticks, (0.5, 0.005, 0.005), 0.9)
        rep = C.analyze(sc.splat())
        self.assertGreaterEqual(next(c for c in rep.checks if c.name == "tamanos").data["agujas"], 400)

    def test_verdicts_do_not_depend_on_scale(self):
        sc = Scene().add(blob((1.0, 1.0, 2.0), 0.25, 300), (0.05, 0.05, 0.05), 0.8)
        self.assertEqual(statuses(sc.splat()), statuses(sc.splat(k=37.0)))

    def test_metadata_mismatch(self):
        data = Scene().splat()
        n = len(data) // 32
        good = {"status": "ready", "gaussians": n, "alignment": "approximate", "scale_known": False,
                "frame_count": 10, "frames_registered": 9, "transform": np.eye(4).flatten().tolist()}
        self.assertEqual(C.check_metadata(good, n).status, "ok")
        self.assertEqual(C.check_metadata({**good, "gaussians": n + 1}, n).status, "falla")
        self.assertEqual(C.check_metadata({**good, "scale_known": True}, n).status, "falla")
        self.assertEqual(C.check_metadata(None, n).status, "omitida")

    def test_bad_file_size(self):
        rep = C.analyze(b"\x00" * 33)
        self.assertTrue(rep.failed)
        self.assertEqual(rep.checks[0].name, "integridad")


class CleanupTest(unittest.TestCase):
    @staticmethod
    def logits(sc: Scene, rot=None):
        pos, scale, alpha = sc.arrays(rot)
        return pos, np.log(scale), np.log(alpha / (1 - alpha))

    def test_removes_floating_blob_and_keeps_scene(self):
        base = Scene()
        n_base = len(base.arrays()[0])
        sc = Scene().add(blob((1.0, 1.0, 2.0), 0.25, 300), (0.05, 0.05, 0.05), 0.8)
        keep, stats = C.cleanup_mask(*self.logits(sc))
        self.assertTrue(stats["aplicada"])
        self.assertEqual(stats["islas_flotantes"], 1)
        self.assertTrue(keep[:n_base].mean() > 0.99)  # la escena queda
        self.assertFalse(keep[n_base:].any())          # el objeto flotante no

    def test_removes_reflection_only_with_reliable_vertical(self):
        sc = Scene().add(grid(0, 1, 0, 3, -1.0), FLAT, 0.8)
        n_base = len(Scene().arrays()[0])
        keep, stats = C.cleanup_mask(*self.logits(sc))
        self.assertTrue(stats["aplicada"])
        self.assertFalse(keep[n_base:].any())
        # Escena torcida: no se confía en el suelo y no se borra nada por estar «abajo».
        keep_t, stats_t = C.cleanup_mask(*self.logits(sc, rot_x(30)))
        self.assertEqual(stats_t["bajo_suelo"], 0)

    def test_never_deletes_the_real_scene(self):
        # Una nube basura más pesada que la escena real: sin cámaras no se sabe cuál es cuál,
        # pero la limpieza jamás puede borrar el suelo y el edificio.
        n_base = len(Scene().arrays()[0])
        sc = Scene().add(blob((3.0, 3.0, 5.0), 1.5, 6000, seed=7), (0.12, 0.12, 0.12), 0.9)
        keep, _ = C.cleanup_mask(*self.logits(sc))
        self.assertTrue(keep[:n_base].all())

    def test_does_not_gut_a_broken_scene(self):
        # Muchos flotantes que juntos pesan más que el tope: la escena está mal de raíz y se
        # exporta como está (el reporte lo dice), en vez de borrar media escena.
        sc = Scene()
        k = 0
        for x in np.linspace(0.5, 5.5, 8):
            for y in np.linspace(0.5, 5.5, 5):
                sc.add(blob((x, y, 2.6 + (k % 4) * 0.7), 0.2, 140, seed=k), (0.05, 0.05, 0.05), 0.8)
                k += 1
        keep, stats = C.cleanup_mask(*self.logits(sc))
        self.assertFalse(stats["aplicada"], stats)
        self.assertTrue(keep.all())
        self.assertIn("motivo", stats)
        self.assertEqual(C.analyze(sc.splat()).summary()["flotantes"], "falla")

    def test_removes_many_lone_floaters_beyond_the_big_island_cap(self):
        # Gaussianas grandes y solas en el aire (el flotante clásico con pocas vistas): aunque
        # pesen más que el tope de las islas grandes, no son ambiguas y se borran.
        n_base = len(Scene().arrays()[0])
        rng = np.random.default_rng(11)
        lone = np.column_stack([rng.uniform(0, 6, 150), rng.uniform(0, 6, 150), rng.uniform(3.2, 5.0, 150)])
        sc = Scene().add(lone, (0.3, 0.3, 0.3), 0.9)
        keep, stats = C.cleanup_mask(*self.logits(sc))
        self.assertTrue(stats["aplicada"], stats)
        self.assertGreater(stats["peso_islas_chicas"], C.MAX_CLEANUP_WEIGHT)
        self.assertTrue(keep[:n_base].mean() > 0.99)
        self.assertLess(keep[n_base:].mean(), 0.05)
        self.assertEqual(C.analyze(sc.splat()).summary()["flotantes"], "falla")

    def test_clean_scene_is_untouched(self):
        keep, stats = C.cleanup_mask(*self.logits(Scene()))
        self.assertGreater(keep.mean(), 0.995)
        self.assertEqual(stats["islas_flotantes"], 0)


if __name__ == "__main__":
    unittest.main()
