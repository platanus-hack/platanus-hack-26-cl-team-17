import struct
import unittest

import numpy as np

from splat.splat_io import SH_C0, SPLAT_BYTES, decode_splat, encode_splat


def logit(p):
    return float(np.log(p / (1 - p)))


class SplatWriterTest(unittest.TestCase):
    def test_exact_byte_layout(self):
        sh0 = np.array([[(1.0 - 0.5) / SH_C0, (0.0 - 0.5) / SH_C0, 0.0]])
        data, n = encode_splat(
            means=np.array([[1.5, -2.0, 3.25]]),
            log_scales=np.log(np.array([[0.1, 0.2, 0.3]])),
            quats_wxyz=np.array([[2.0, 0.0, 0.0, 0.0]]),  # sin normalizar
            sh0=sh0,
            opacity_logits=np.array([logit(0.5)]),
        )
        self.assertEqual(n, 1)
        self.assertEqual(len(data), SPLAT_BYTES)
        x, y, z, sx, sy, sz = struct.unpack("<6f", data[:24])
        self.assertEqual((x, y, z), (1.5, -2.0, 3.25))
        np.testing.assert_allclose([sx, sy, sz], [0.1, 0.2, 0.3], rtol=1e-6)
        self.assertEqual(tuple(data[24:28]), (255, 0, 128, 128))
        self.assertEqual(tuple(data[28:32]), (255, 128, 128, 128))  # w=1 → 255 (recortado)

    def test_sorted_by_importance_and_capped(self):
        rng = np.random.default_rng(0)
        n = 1000
        means = rng.normal(size=(n, 3))
        log_scales = rng.normal(-3, 1, (n, 3))
        opac = rng.normal(0, 2, n)
        data, written = encode_splat(
            means=means,
            log_scales=log_scales,
            quats_wxyz=rng.normal(size=(n, 4)),
            sh0=rng.normal(size=(n, 3)),
            opacity_logits=opac,
            max_gaussians=100,
        )
        self.assertEqual(written, 100)
        self.assertEqual(len(data), 100 * SPLAT_BYTES)
        dec = decode_splat(data)
        # Cada gaussiana escrita se identifica por su posición (única) en la entrada.
        lookup = {tuple(np.float32(m).tolist()): i for i, m in enumerate(means)}
        idx = [lookup[tuple(np.float32(p).tolist())] for p in dec["position"]]
        imp = np.exp(log_scales.sum(1)) / (1 + np.exp(-opac))
        self.assertEqual(sorted(idx), sorted(np.argsort(-imp)[:100].tolist()))
        self.assertTrue(np.all(np.diff(imp[idx]) <= 0))
        norms = np.linalg.norm(dec["rot_wxyz"], axis=1)
        np.testing.assert_allclose(norms, 1.0, atol=0.03)

    def test_drops_invalid_and_invisible(self):
        means = np.array([[0, 0, 0], [np.nan, 0, 0], [1, 1, 1], [2, 2, 2]], float)
        data, written = encode_splat(
            means=means,
            log_scales=np.zeros((4, 3)),
            quats_wxyz=np.array([[1, 0, 0, 0], [1, 0, 0, 0], [0, 0, 0, 0], [1, 0, 0, 0]], float),
            sh0=np.zeros((4, 3)),
            opacity_logits=np.array([0.0, 0.0, 0.0, -20.0]),
        )
        self.assertEqual(written, 1)
        self.assertEqual(decode_splat(data)["position"].tolist(), [[0.0, 0.0, 0.0]])


if __name__ == "__main__":
    unittest.main()
