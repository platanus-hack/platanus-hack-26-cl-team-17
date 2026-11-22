import math
import unittest

import numpy as np

from splat import live3d, live_gs
from splat.live3d import Manager, Session
from splat.live_gs import decode_live_splat, encode_live_splat, init_from_points

from .fakes import FakeEstimator, FakeSplatTrainer
from .test_live3d import Clock, textured_jpeg


def run_session(n_frames=40):
    clock = Clock()
    s = Session("m1", "fake", now=clock)
    est = FakeEstimator(seed=5)
    for i in range(n_frames):
        clock.t += 0.35
        s.add_frame(textured_jpeg(i))
        win = s.take_window()
        if win is not None:
            s.process(win, est)
    return s, clock


class TestEncoding(unittest.TestCase):
    def test_roundtrip_within_quantization(self):
        rng = np.random.default_rng(0)
        n = 5000
        means = rng.normal(size=(n, 3)) * np.array([10.0, 5.0, 2.0])
        ls = rng.uniform(-6, -1, size=(n, 3))
        q = rng.normal(size=(n, 4))
        sh0 = rng.uniform(-1.5, 1.5, size=(n, 3))
        op = rng.uniform(-1, 4, size=n)
        data, written = encode_live_splat(means, ls, q, sh0, op, version=7)
        self.assertEqual(len(data), live_gs.HEADER.size + 17 * written)
        # Caja robusta: fuera quedan los extremos (0,2 % por lado y eje como mucho).
        self.assertGreater(written, n * 0.97)
        d = decode_live_splat(data)
        self.assertEqual(d["version"], 7)
        # Las más importantes van primero: se busca cada una por su posición.
        imp = np.exp(ls.sum(axis=1)) / (1 + np.exp(-op))
        top = int(np.argmax(imp))
        self.assertLess(np.abs(d["position"][0] - means[top]).max(), 30.0 / 65535 * 2)
        self.assertLess(np.abs(d["log_scale"][0] - ls[top]).max(), 5.0 / 255 * 0.6)
        rgb = np.clip(0.5 + live_gs.SH_C0 * sh0[top], 0, 1) * 255
        np.testing.assert_allclose(d["rgba"][0, :3], rgb, atol=0.6)
        self.assertAlmostEqual(d["rgba"][0, 3] / 255, 1 / (1 + math.exp(-op[top])), delta=0.003)
        qn = q[top] / np.linalg.norm(q[top])
        np.testing.assert_allclose(d["rot_wxyz"][0], qn, atol=0.006)

    def test_drops_transparent_far_and_caps(self):
        rng = np.random.default_rng(1)
        n = 2000
        means = rng.normal(size=(n, 3))
        means[0] = [1e6, 0, 0]  # flotador
        op = np.full(n, 2.0)
        op[1] = -10.0  # transparente
        data, written = encode_live_splat(means, np.full((n, 3), -3.0), np.tile([1.0, 0, 0, 0], (n, 1)), np.zeros((n, 3)), op, 1)
        d = decode_live_splat(data)
        self.assertLess(np.abs(d["position"]).max(), 100)
        self.assertLessEqual(written, n - 2)
        _data, capped = encode_live_splat(means, np.full((n, 3), -3.0), np.tile([1.0, 0, 0, 0], (n, 1)), np.zeros((n, 3)), op, 1, max_gaussians=100)
        self.assertEqual(capped, 100)

    def test_empty(self):
        z = np.zeros((0, 3))
        data, n = encode_live_splat(z, z, np.zeros((0, 4)), z, np.zeros(0), 3)
        self.assertEqual(n, 0)
        self.assertEqual(decode_live_splat(data)["position"].shape, (0, 3))

    def test_init_from_points(self):
        rng = np.random.default_rng(2)
        xyz = rng.uniform(0, 1, size=(4000, 3)).astype(np.float32)
        rgb = rng.integers(0, 255, size=(4000, 3), dtype=np.uint8)
        g = init_from_points(xyz, rgb, 0.01)
        self.assertEqual(g["means"].shape, (4000, 3))
        self.assertEqual(g["sh0"].shape, (4000, 1, 3))
        self.assertTrue(np.isfinite(g["scales"]).all())
        back = np.clip(0.5 + live_gs.SH_C0 * g["sh0"][:, 0, :], 0, 1) * 255
        np.testing.assert_allclose(back, rgb, atol=0.01)


class TestSessionSplats(unittest.TestCase):
    def test_views_have_masks_and_cameras(self):
        s, _ = run_session()
        self.assertEqual(len(s.views), len(s.placed))
        v = s.views[-1]
        self.assertEqual(v.mask.shape, v.image.shape[:2])
        self.assertGreater(v.mask.mean(), 0.2)
        np.testing.assert_allclose(v.c2w, s.placed[-1].c2w)

    def test_manager_trains_only_when_wanted(self):
        s, clock = run_session()
        mgr = Manager(lambda: FakeEstimator(), "fake", lambda _m: None, make_trainer=lambda: FakeSplatTrainer(lambda _m: None), splat_engine="fake")
        mgr.sessions[s.sid] = s
        s.splat_engine = "fake"
        self.assertIsNone(mgr._splat_session())
        s.want_splat()
        self.assertIs(mgr._splat_session(), s)
        self.assertTrue(mgr.train_splat(s, 0.01))
        data, version = s.splat_payload()
        self.assertEqual(version, 1)
        d = decode_live_splat(data)
        self.assertGreater(len(d["position"]), 1000)
        st = s.status(True)["splat"]
        self.assertTrue(st["active"])
        self.assertEqual(st["version"], 1)
        self.assertEqual(st["engine"], "fake")
        self.assertEqual(st["views"], len(s.views))
        # Sin consultas, se apaga.
        clock.t += live3d.SPLAT_WANT_S + 1
        self.assertIsNone(mgr._splat_session())
        self.assertFalse(s.status(True)["splat"]["active"])

    def test_trainer_failure_is_reported_not_raised(self):
        s, _ = run_session(25)

        def boom():
            raise RuntimeError("sin gsplat")

        mgr = Manager(lambda: FakeEstimator(), "fake", lambda _m: None, make_trainer=boom, splat_engine="gsplat")
        s.want_splat()
        self.assertFalse(mgr.train_splat(s, 0.01))
        self.assertIn("sin gsplat", s.status(True)["splat"]["error"])
        self.assertIsNone(s.splat_payload()[0])


try:
    import torch  # noqa: F401

    HAS_TORCH = True
except Exception:  # noqa: BLE001
    HAS_TORCH = False


def toy_rasterize(means, quats, scales, opacities, colors, viewmats, Ks, width, height):
    """Rasterizador de juguete y diferenciable: cada píxel es el promedio de colores pesado por
    opacidad (más un término nulo para que todos los parámetros tengan gradiente)."""
    import torch

    w = opacities[:, None]
    rgb = (w * (0.5 + live_gs.SH_C0 * colors[:, 0, :])).sum(0) / w.sum().clamp_min(1e-6)
    zero = 0.0 * (means.sum() + quats.sum() + scales.sum())
    img = (rgb + zero).expand(1, height, width, 3)
    return img, torch.ones(1, height, width, 1)


@unittest.skipUnless(HAS_TORCH, "sin torch")
class TestTorchTrainer(unittest.TestCase):
    def test_sync_train_grow_and_prune(self):
        s, _ = run_session()
        tr = live_gs.LiveSplatTrainer("cpu", lambda _m: None, rasterize=toy_rasterize)
        chunks = [(c.xyz, c.rgb) for c in s.chunks[:2]]
        tr.sync(s.views[:5], chunks, s.voxel)
        n0 = tr.count
        self.assertGreater(n0, 0)
        self.assertEqual(tr.n_views, 5)
        self.assertEqual(tr.n_chunks, 2)
        self.assertGreater(tr.train(0.05), 0)
        self.assertIsNotNone(tr.psnr)
        # Estado de Adam con la forma de los parámetros tras crecer.
        tr.sync(s.views, [(c.xyz, c.rgb) for c in s.chunks[2:4]], s.voxel)
        self.assertGreater(tr.count, n0)
        for name, p in tr.params.items():
            st = tr.opts[name].state[p]
            self.assertEqual(st["exp_avg"].shape, p.shape, name)
        self.assertGreater(tr.train(0.05), 0)
        # Tope: se podan las más transparentes.
        old_max = live_gs.GS_MAX
        try:
            live_gs.GS_MAX = tr.count
            with __import__("torch").no_grad():
                tr.params["opacities"][:100] = -8.0
            tr.sync(s.views, [(c.xyz, c.rgb) for c in s.chunks[4:5]], s.voxel)
            self.assertLessEqual(tr.count, live_gs.GS_MAX)
            for name, p in tr.params.items():
                self.assertEqual(tr.opts[name].state[p]["exp_avg_sq"].shape, p.shape, name)
            self.assertGreater(tr.train(0.02), 0)
        finally:
            live_gs.GS_MAX = old_max
        data, n = encode_live_splat(*tr.arrays(), version=1)
        self.assertGreater(n, 0)
        # Ningún tamaño por sobre el tope de escala.
        d = decode_live_splat(data)
        self.assertLessEqual(float(d["log_scale"].max()), math.log(tr.scene_scale * live_gs.MAX_SCALE_FRAC) + 0.05)

    def test_views_are_thinned(self):
        s, _ = run_session()
        tr = live_gs.LiveSplatTrainer("cpu", lambda _m: None, rasterize=toy_rasterize)
        old = live_gs.MAX_TRAIN_VIEWS
        try:
            live_gs.MAX_TRAIN_VIEWS = 6
            tr.sync(s.views, [], s.voxel)
            self.assertLessEqual(tr.n_views, 6)
            self.assertEqual(tr.views[-1][0], s.views[-1].index)
        finally:
            live_gs.MAX_TRAIN_VIEWS = old


if __name__ == "__main__":
    unittest.main()
