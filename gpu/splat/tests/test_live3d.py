import math
import unittest

import cv2
import numpy as np

from splat import live3d

from .fakes import FakeEstimator
from splat.live3d import (
    Session,
    decode_points,
    display_matrix,
    robust_sim3,
    sim3_cameras,
)


def random_rotation(rng):
    q = rng.normal(size=4)
    q /= np.linalg.norm(q)
    w, x, y, z = q
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def textured_jpeg(i, w=640, h=360):
    rng = np.random.default_rng(i)
    img = (rng.random((h // 8, w // 8, 3)) * 255).astype(np.uint8)
    img = cv2.resize(img, (w, h), interpolation=cv2.INTER_NEAREST)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    assert ok
    return buf.tobytes()


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


class TestGeometry(unittest.TestCase):
    def test_robust_sim3_with_outliers(self):
        rng = np.random.default_rng(1)
        src = rng.normal(size=(5000, 3))
        r = random_rotation(rng)
        dst = 2.5 * src @ r.T + np.array([1.0, -2.0, 0.5])
        bad = rng.random(5000) < 0.2
        dst[bad] += rng.normal(scale=5.0, size=(bad.sum(), 3))
        fit = robust_sim3(src, dst, np.ones(5000))
        self.assertTrue(fit.ok)
        self.assertAlmostEqual(fit.scale, 2.5, places=2)
        np.testing.assert_allclose(fit.matrix[:3, :3] / fit.scale, r, atol=1e-2)

    def test_robust_sim3_rejects_garbage(self):
        rng = np.random.default_rng(2)
        fit = robust_sim3(rng.normal(size=(2000, 3)), rng.normal(size=(2000, 3)), np.ones(2000))
        self.assertFalse(fit.ok)

    def test_sim3_cameras_keeps_rotation_orthonormal(self):
        m = np.eye(4)
        m[:3, :3] = 3.0 * random_rotation(np.random.default_rng(3))
        out = sim3_cameras(m, np.eye(4)[None])
        np.testing.assert_allclose(out[0, :3, :3] @ out[0, :3, :3].T, np.eye(3), atol=1e-9)

    def test_display_puts_ground_up(self):
        rng = np.random.default_rng(4)
        ground = np.c_[rng.uniform(-10, 10, (4000, 2)), np.zeros(4000)]
        cams = np.stack([live3d.look_at(np.array([15.0, 0, 8]), np.zeros(3)), live3d.look_at(np.array([0, 15.0, 8]), np.zeros(3))])
        m = display_matrix(ground, cams)
        up_world = np.array([0.0, 0.0, 1.0])
        up_display = m[:3, :3] @ up_world
        up_display /= np.linalg.norm(up_display)
        self.assertGreater(up_display[1], 0.99)


class TestSession(unittest.TestCase):
    def run_session(self, n_frames=60, est=None):
        clock = Clock()
        s = Session("m1", "fake", now=clock)
        est = est or FakeEstimator(seed=5)
        for i in range(n_frames):
            clock.t += 0.35
            s.add_frame(textured_jpeg(i))
            win = s.take_window()
            if win is not None:
                s.process(win, est)
        clock.t += 10
        win = s.take_window()
        if win is not None:
            s.process(win, est)
        return s, est

    def test_trajectory_matches_ground_truth_up_to_similarity(self):
        s, est = self.run_session()
        self.assertGreater(len(s.chunks), 5)
        self.assertEqual(s.state, "running")
        est_c = np.stack([k.c2w[:3, 3] for k in s.placed])
        gt_c = np.stack([est.camera(k.index)[:3, 3] for k in s.placed])
        sc, r, t = live3d.weighted_umeyama(est_c, gt_c, np.ones(len(est_c)))
        err = np.linalg.norm(gt_c - (sc * est_c @ r.T + t), axis=1)
        self.assertLess(float(err.max()), 0.02 * est.radius, f"deriva {err.max():.3f}")

    def test_points_are_on_the_ground_and_deduplicated(self):
        s, est = self.run_session()
        xyz = np.concatenate([c.xyz for c in s.chunks]).astype(np.float64)
        self.assertGreater(len(xyz), 1000)
        # Lleva los puntos al mundo verdadero con la similitud de las cámaras.
        est_c = np.stack([k.c2w[:3, 3] for k in s.placed])
        gt_c = np.stack([est.camera(k.index)[:3, 3] for k in s.placed])
        sc, r, t = live3d.weighted_umeyama(est_c, gt_c, np.ones(len(est_c)))
        world = sc * xyz @ r.T + t
        # Relieve del doble FakeEstimator: hasta 8 % de la profundidad (~3 m a ~35 m).
        self.assertLess(float(np.median(np.abs(world[:, 2]))), 3.5)
        keys = live3d.voxel_keys(xyz.astype(np.float32), s.voxel)
        self.assertEqual(len(np.unique(keys)), len(keys))

    def test_points_roundtrip_and_status(self):
        s, _ = self.run_session(30)
        data = s.points(0, 16)
        start, end, xyz, rgb = decode_points(data)
        self.assertEqual((start, end), (0, len(s.chunks)))
        self.assertEqual(len(xyz), s.n_points)
        self.assertEqual(rgb.shape, xyz.shape)
        st = s.status(True)
        self.assertEqual(st["chunks"], len(s.chunks))
        self.assertEqual(len(st["display"]), 16)
        self.assertEqual(len(st["cameras"]), len(s.placed))
        self.assertTrue(all(len(c) == 12 for c in st["cameras"]))

    def test_drops_duplicates_and_too_fast_frames(self):
        clock = Clock()
        s = Session("m2", "fake", now=clock)
        jpg = textured_jpeg(1)
        clock.t = 1.0
        self.assertTrue(s.add_frame(jpg)["accepted"])
        clock.t = 1.1
        self.assertEqual(s.add_frame(textured_jpeg(2))["reason"], "muy seguido")
        clock.t = 1.6
        self.assertEqual(s.add_frame(jpg)["reason"], "igual al anterior")
        clock.t = 2.0
        self.assertTrue(s.add_frame(textured_jpeg(3))["accepted"])

    def test_window_that_does_not_fit_is_rejected(self):
        class Jumpy(FakeEstimator):
            calls = 0

            def __call__(self, images, ids):
                pred = super().__call__(images, ids)
                Jumpy.calls += 1
                if Jumpy.calls == 3:  # la tercera ventana: profundidad basura en las anclas
                    rng = np.random.default_rng(9)
                    depth = pred.depth.copy()
                    depth[:4] = rng.uniform(1, 100, depth[:4].shape).astype(np.float32)
                    return live3d.Prediction(depth, pred.conf, pred.c2w, pred.K)
                return pred

        s, _ = self.run_session(40, est=Jumpy(seed=6))
        self.assertGreater(len(s.chunks), 3)
        cams = np.stack([k.c2w[:3, 3] for k in s.placed])
        self.assertTrue(np.isfinite(cams).all())


if __name__ == "__main__":
    unittest.main()
