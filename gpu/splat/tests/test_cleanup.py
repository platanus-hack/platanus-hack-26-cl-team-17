import unittest

import numpy as np

from splat.cleanup import export_mask, remove_outliers, scene_box


class CleanupTest(unittest.TestCase):
    def test_removes_isolated_points(self):
        rng = np.random.default_rng(0)
        dense = rng.uniform(0, 1, size=(5000, 3))
        far = rng.uniform(5, 50, size=(20, 3))
        pts = np.concatenate((dense, far))
        cols = np.zeros_like(pts)
        kept, kcols = remove_outliers(pts, cols)
        self.assertEqual(len(kept), len(kcols))
        self.assertGreater(len(kept), 4800)
        self.assertFalse((kept > 4).any())

    def test_box_contains_cameras_and_scene(self):
        rng = np.random.default_rng(1)
        pts = rng.uniform(-1, 1, size=(1000, 3))
        cams = np.array([[3.0, 0, 0], [0, 3.0, 0]])
        lo, hi = scene_box(pts, cams)
        self.assertTrue(np.all(lo <= cams.min(axis=0)) and np.all(hi >= cams.max(axis=0)))
        self.assertTrue(np.all(lo < -0.9) and np.all(hi > 0.9))

    def test_export_mask_drops_far_and_huge(self):
        rng = np.random.default_rng(2)
        ref = rng.uniform(-1, 1, size=(1000, 3))
        cams = np.array([[0.0, 0, -2]])
        means = np.array([[0.0, 0, 0], [100.0, 0, 0], [0.5, 0.5, 0]])
        log_scales = np.log(np.array([[0.01] * 3, [0.01] * 3, [5.0, 0.01, 0.01]]))
        self.assertEqual(export_mask(means, log_scales, ref, cams).tolist(), [True, False, False])


if __name__ == "__main__":
    unittest.main()
