import math
import unittest

import numpy as np

from splat.align import apply_to_cameras, similarity_matrix
from splat.depthmap import FrameDepth, to_world
from splat.register import (
    BAProblem,
    build_tracks,
    bundle_adjust,
    join_groups,
    match_descriptors,
    ransac_sim3,
    register,
    reproj_errors,
    rodrigues,
    select_pairs,
)

W, H = 400, 300
K = np.array([[320.0, 0, W / 2], [0, 320.0, H / 2], [0, 0, 1]])


def rot(axis, deg):
    rv = np.asarray(axis, dtype=float)
    rv = rv / np.linalg.norm(rv) * math.radians(deg)
    return rodrigues(rv[None])[0]


def look_at(eye, target, up=(0, 0, 1)):
    """c2w en OpenCV (x derecha, y abajo, z adelante)."""
    eye = np.asarray(eye, float)
    z = np.asarray(target, float) - eye
    z /= np.linalg.norm(z)
    x = np.cross(z, up)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    m = np.eye(4)
    m[:3, :3] = np.stack((x, y, z), axis=1)
    m[:3, 3] = eye
    return m


def texture(seed, size=512):
    """Textura con manchas y cuadrados de varios tamaños (buenos puntos SIFT)."""
    import cv2

    rng = np.random.default_rng(seed)
    img = (rng.random((size, size)) * 255).astype(np.float32)
    img = cv2.GaussianBlur(img, (0, 0), 3)
    for _ in range(400):
        x, y = rng.integers(0, size, 2)
        r = int(rng.integers(3, 18))
        c = float(rng.integers(0, 256))
        if rng.random() < 0.5:
            cv2.circle(img, (int(x), int(y)), r, c, -1)
        else:
            cv2.rectangle(img, (int(x), int(y)), (int(x) + r, int(y) + r), c, -1)
    img = (img - img.min()) / (img.max() - img.min()) * 255
    return img.astype(np.uint8)


class Scene:
    """Planos (punto, normal, eje u, eje v, textura, metros por textura)."""

    def __init__(self, seed):
        self.planes = [
            (np.array([0, 0, 0.0]), np.array([0, 0, 1.0]), np.array([1, 0, 0.0]), np.array([0, 1, 0.0]), texture(seed)),
            (np.array([0, 4, 0.0]), np.array([0, -1, 0.0]), np.array([1, 0, 0.0]), np.array([0, 0, 1.0]), texture(seed + 1)),
            (np.array([-3, 0, 0.0]), np.array([1, 0, 0.0]), np.array([0, 1, 0.0]), np.array([0, 0, 1.0]), texture(seed + 2)),
        ]
        self.extent = 8.0

    def render(self, c2w):
        us, vs = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
        dirs_c = np.stack(((us - K[0, 2]) / K[0, 0], (vs - K[1, 2]) / K[1, 1], np.ones_like(us)), axis=-1)
        dirs = dirs_c @ c2w[:3, :3].T
        o = c2w[:3, 3]
        best_t = np.full((H, W), np.inf)
        color = np.zeros((H, W))
        for p0, n, eu, ev, tex in self.planes:
            denom = dirs @ n
            with np.errstate(divide="ignore", invalid="ignore"):
                t = ((p0 - o) @ n) / denom
            hit = (t > 0.05) & (t < best_t)
            pts = o + dirs * t[..., None]
            a = ((pts - p0) @ eu) / self.extent * tex.shape[1] % tex.shape[1]
            b = ((pts - p0) @ ev) / self.extent * tex.shape[0] % tex.shape[0]
            a = np.nan_to_num(a).astype(int) % tex.shape[1]
            b = np.nan_to_num(b).astype(int) % tex.shape[0]
            color = np.where(hit, tex[b, a], color)
            best_t = np.where(hit, t, best_t)
        depth = np.where(np.isfinite(best_t), best_t, 0.0)  # z de cámara = t porque dirs_c.z = 1
        img = np.repeat(color[..., None], 3, axis=2).astype(np.uint8)
        return img, depth.astype(np.float32)


def frame_depth(depth, scale):
    d = depth / scale
    return FrameDepth(depth=d.astype(np.float32), confident=d > 0, K_small=K, sx=1.0, sy=1.0)


def build_case(seed=0, pose_noise=True):
    """Dos videos de la misma esquina (en sistemas y escalas distintos) y uno de otra escena."""
    rng = np.random.default_rng(seed)
    scene = Scene(10)
    other = Scene(99)
    target = np.array([-1.0, 2.5, 0.8])
    arcs = [
        [look_at([2.0 + 0.5 * k, -1.5 + 0.3 * k, 1.5], target) for k in range(8)],
        [look_at([3.0 + 0.2 * k, 0.5 + 0.4 * k, 1.6], target) for k in range(7)],
        [look_at([1.0 + 0.4 * k, -2.0, 1.4], target) for k in range(6)],
    ]
    # Sistema de cada grupo → mundo (lo que VGGT no sabe).
    t_g = [
        similarity_matrix(1.0, np.eye(3), np.zeros(3)),
        similarity_matrix(2.5, rot([0.3, 1, 0.2], 40), np.array([1.0, -2.0, 0.5])),
        similarity_matrix(0.7, rot([1, 0, 0], -25), np.array([0.0, 3.0, 1.0])),
    ]
    images, depths, c2w_local, c2w_true, group_of = [], [], [], [], []
    for g, arc in enumerate(arcs):
        sc = other if g == 2 else scene
        s = np.cbrt(np.linalg.det(t_g[g][:3, :3]))
        inv = np.linalg.inv(t_g[g])
        for c in arc:
            img, d = sc.render(c)
            images.append(img)
            depths.append(frame_depth(d, s))
            local = apply_to_cameras(inv, c[None])[0]
            if pose_noise and len([x for x in group_of if x == g]) > 0:
                local[:3, :3] = local[:3, :3] @ rot(rng.normal(size=3), 0.6)
                local[:3, 3] += rng.normal(size=3) * 0.02 / s
            c2w_local.append(local)
            c2w_true.append(c)
            group_of.append(g)
    return images, depths, np.array(c2w_local), np.array(c2w_true), np.array(group_of)


class MatchTest(unittest.TestCase):
    def test_mutual_nn_with_ratio(self):
        rng = np.random.default_rng(0)
        a = rng.normal(size=(50, 128)).astype(np.float32)
        a /= np.linalg.norm(a, axis=1, keepdims=True)
        perm = rng.permutation(50)
        b = a[perm] + rng.normal(scale=0.01, size=(50, 128)).astype(np.float32)
        b /= np.linalg.norm(b, axis=1, keepdims=True)
        m = match_descriptors(a, b)
        self.assertEqual(len(m), 50)
        self.assertTrue(np.all(perm[m[:, 1]] == m[:, 0]))

    def test_select_pairs_budget(self):
        groups = [list(range(0, 100)), list(range(100, 200)), list(range(200, 210))]
        pairs = select_pairs(groups, window=3, budget=900)
        self.assertIn((0, 1), pairs)
        self.assertIn((0, 3), pairs)
        self.assertNotIn((0, 4), pairs)
        cross = [p for p in pairs if (p[0] < 100) != (p[1] < 100)]
        self.assertTrue(len(cross) > 0)
        self.assertTrue(all(i < j for i, j in pairs))
        self.assertLessEqual(len([p for p in pairs if p[0] < 100 <= p[1] < 200]), 17 * 17)


class Sim3Test(unittest.TestCase):
    def test_recovers_similarity_with_outliers(self):
        rng = np.random.default_rng(1)
        src = rng.normal(size=(200, 3))
        s_true = similarity_matrix(1.7, rot([1, 2, 3], 33), np.array([0.5, -1, 2]))
        dst = src @ s_true[:3, :3].T + s_true[:3, 3]
        dst[:80] = rng.normal(size=(80, 3)) * 3
        s, mask = ransac_sim3(src, dst, np.full(200, 0.05))
        self.assertIsNotNone(s)
        self.assertTrue(np.allclose(s, s_true, atol=1e-6))
        self.assertEqual(int(mask[80:].sum()), 120)


class JoinTest(unittest.TestCase):
    def test_chains_and_drops_isolated(self):
        s01 = similarity_matrix(2.0, rot([0, 0, 1], 30), np.array([1, 0, 0.0]))  # 1 → 0
        s12 = similarity_matrix(0.5, rot([1, 0, 0], 10), np.array([0, 1, 0.0]))  # 2 → 1
        to_ref, dropped, ref = join_groups(4, [50, 20, 10, 60], {(0, 1): (s01, 100), (1, 2): (s12, 80)})
        # El componente {0,1,2} tiene 80 cuadros contra 60 del grupo 3 solo.
        self.assertEqual(ref, 0)
        self.assertEqual(dropped, [3])
        self.assertTrue(np.allclose(to_ref[1], s01))
        self.assertTrue(np.allclose(to_ref[2], s01 @ s12))

    def test_reference_is_largest_group_of_component(self):
        s01 = similarity_matrix(2.0, np.eye(3), np.zeros(3))
        to_ref, dropped, ref = join_groups(2, [10, 40], {(0, 1): (s01, 100)})
        self.assertEqual(ref, 1)
        self.assertEqual(dropped, [])
        self.assertTrue(np.allclose(to_ref[0], np.linalg.inv(s01)))


class TracksTest(unittest.TestCase):
    def test_union_and_conflicts(self):
        verified = {
            (0, 1): np.array([[0, 0], [1, 1]]),
            (1, 2): np.array([[0, 5], [1, 6]]),
            # Une el punto 1 del cuadro 0 con el 2 del cuadro 0 a través del cuadro 2: conflicto.
            (0, 2): np.array([[2, 6]]),
        }
        tracks = build_tracks([3, 2, 7], verified)
        as_sets = [set(t) for t in tracks]
        self.assertIn({(0, 0), (1, 0), (2, 5)}, as_sets)
        self.assertEqual(len(tracks), 1)


class BundleAdjustTest(unittest.TestCase):
    def test_reduces_error_and_keeps_gauge(self):
        rng = np.random.default_rng(3)
        pts = rng.uniform(-2, 2, size=(300, 3)) + np.array([0, 0, 6.0])
        cams = []
        for k in range(6):
            c2w = look_at([k * 0.4 - 1, 0.2 * k, 0], [0, 0, 6.0], up=(0, -1, 0))
            cams.append(np.linalg.inv(c2w))
        w2c_true = np.array(cams)
        cam_idx, pt_idx, uv = [], [], []
        for c in range(6):
            xc = pts @ w2c_true[c, :3, :3].T + w2c_true[c, :3, 3]
            u = K[0, 0] * xc[:, 0] / xc[:, 2] + K[0, 2]
            v = K[1, 1] * xc[:, 1] / xc[:, 2] + K[1, 2]
            for p in range(len(pts)):
                cam_idx.append(c)
                pt_idx.append(p)
                uv.append((u[p] + rng.normal(scale=0.3), v[p] + rng.normal(scale=0.3)))
        w2c0 = w2c_true.copy()
        for c in range(1, 6):
            w2c0[c, :3, :3] = rot(rng.normal(size=3), 1.0) @ w2c0[c, :3, :3]
            w2c0[c, :3, 3] += rng.normal(size=3) * 0.05
        prob = BAProblem(
            cam_idx=np.array(cam_idx), pt_idx=np.array(pt_idx), uv=np.array(uv), w2c=w2c0,
            Ks=np.repeat(K[None], 6, axis=0), group_of=np.zeros(6, dtype=int),
            points=pts + rng.normal(size=pts.shape) * 0.05,
        )
        e0 = np.median(reproj_errors(prob, w2c0, np.ones(1), prob.points))
        w2c, fm, p1 = bundle_adjust(prob, 0, 1)
        e1 = np.median(reproj_errors(prob, w2c, fm, p1))
        self.assertGreater(e0, 3.0)
        self.assertLess(e1, 0.6)
        self.assertTrue(np.allclose(w2c[0], w2c_true[0]))
        centers = np.array([-(w[:3, :3].T @ w[:3, 3]) for w in w2c])
        true_c = np.array([-(w[:3, :3].T @ w[:3, 3]) for w in w2c_true])
        self.assertLess(np.abs(centers - true_c).max(), 0.05)


class RegisterEndToEndTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.case = build_case()
        images, depths, c2w_local, c2w_true, group_of = cls.case
        cls.reg = register(images, group_of, c2w_local, np.repeat(K[None], len(images), axis=0), depths, log=lambda m: None)

    def test_drops_unrelated_video_and_keeps_others(self):
        _imgs, _d, _l, _t, group_of = self.case
        self.assertEqual(self.reg.dropped_groups, [2])
        self.assertFalse(self.reg.kept[group_of == 2].any())
        self.assertGreaterEqual(int(self.reg.kept[group_of != 2].sum()), 13)

    def test_second_video_lands_in_the_right_place(self):
        _imgs, _d, _l, c2w_true, group_of = self.case
        # La referencia es el grupo 0 (el más grande), cuyo sistema es el mundo.
        sel = self.reg.kept & (group_of != 2)
        err = np.linalg.norm(self.reg.c2w[sel, :3, 3] - c2w_true[sel, :3, 3], axis=1)
        self.assertLess(float(err.max()), 0.12, err)
        for c, t in zip(self.reg.c2w[sel], c2w_true[sel]):
            cosang = (np.trace(c[:3, :3].T @ t[:3, :3]) - 1) / 2
            self.assertGreater(cosang, math.cos(math.radians(1.5)))

    def test_bundle_adjustment_improves(self):
        self.assertEqual(self.reg.stats.get("ba"), "ok", self.reg.stats)
        self.assertLess(self.reg.stats["reproj_after_px"], self.reg.stats["reproj_before_px"])
        self.assertLess(self.reg.stats["reproj_after_px"], 1.5)

    def test_depth_scale_brings_dense_points_together(self):
        images, depths, _l, _t, group_of = self.case
        rng = np.random.default_rng(0)
        sel = np.nonzero(self.reg.kept & (group_of != 2))[0]
        for i in sel[[0, -1]]:
            cam, _cols = depths[i].cam_points(images[i], 500, rng)
            world = to_world(self.reg.c2w[i], cam, self.reg.depth_scale[i])
            # Cada punto debe caer sobre alguno de los tres planos de la escena.
            d_plane = np.minimum.reduce([np.abs(world[:, 2]), np.abs(world[:, 1] - 4), np.abs(world[:, 0] + 3)])
            self.assertLess(float(np.median(d_plane)), 0.05)


if __name__ == "__main__":
    unittest.main()
