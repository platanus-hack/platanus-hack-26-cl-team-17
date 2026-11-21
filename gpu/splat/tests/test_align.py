import math
import unittest

import numpy as np

from splat.align import (
    PHONE_HEIGHT_M,
    CameraInfo,
    align_scene,
    apply_to_cameras,
    apply_to_points,
    count_distinct,
    fit_ground_plane,
    rotation_between,
    similarity_matrix,
    umeyama,
)
from splat.geo import EARTH_RADIUS_M, to_enu

ORIGIN = (-33.4489, -70.6693)


def enu_to_latlng(x, y):
    lat = ORIGIN[0] + math.degrees(y / EARTH_RADIUS_M)
    lng = ORIGIN[1] + math.degrees(x / (EARTH_RADIUS_M * math.cos(math.radians(ORIGIN[0]))))
    return lat, lng


def look_at(center, target, up=(0.0, 0.0, 1.0)):
    """Cámara→mundo OpenCV (x derecha, y abajo, z adelante)."""
    c = np.asarray(center, float)
    f = np.asarray(target, float) - c
    f /= np.linalg.norm(f)
    x = np.cross(f, up)
    if np.linalg.norm(x) < 1e-9:
        x = np.array([1.0, 0.0, 0.0])
    x /= np.linalg.norm(x)
    y = np.cross(f, x)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, y, f, c
    return m


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


def scene_points(rng):
    """Suelo de 60×60 m en z=0 más una casa de 10×8×6 m."""
    ground = np.c_[rng.uniform(-30, 30, (6000, 2)), rng.normal(0, 0.02, 6000)]
    house = np.c_[rng.uniform(-5, 5, (1500, 1)), rng.uniform(-4, 4, (1500, 1)), rng.uniform(0, 6, (1500, 1))]
    return np.vstack([ground, house])


class Scramble:
    """Lleva la escena "real" (ENU) al sistema arbitrario de VGGT con una similitud conocida."""

    def __init__(self, seed=1):
        rng = np.random.default_rng(seed)
        self.true_to_vggt = similarity_matrix(0.037, random_rotation(rng), rng.normal(size=3))

    def points(self, p):
        return apply_to_points(self.true_to_vggt, p)

    def cams(self, c2w):
        return apply_to_cameras(self.true_to_vggt, c2w)


class UmeyamaTest(unittest.TestCase):
    def test_recovers_similarity(self):
        rng = np.random.default_rng(0)
        src = rng.normal(size=(20, 3))
        r = random_rotation(rng)
        dst = 3.5 * src @ r.T + np.array([1.0, -2.0, 0.5])
        s, r2, t = umeyama(src, dst)
        self.assertAlmostEqual(s, 3.5, places=6)
        np.testing.assert_allclose(r2, r, atol=1e-6)
        np.testing.assert_allclose(t, [1.0, -2.0, 0.5], atol=1e-6)

    def test_2d(self):
        src = np.array([[0.0, 0.0], [1.0, 0.0], [0.0, 2.0]])
        a = math.radians(30)
        r = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
        dst = 2.0 * src @ r.T + [5.0, 1.0]
        s, r2, t = umeyama(src, dst)
        self.assertAlmostEqual(s, 2.0)
        np.testing.assert_allclose(r2, r, atol=1e-9)

    def test_helpers(self):
        self.assertEqual(count_distinct(np.array([[0, 0, 0], [1, 0, 0], [10, 0, 0], [10, 2, 0]], float)), 2)
        r = rotation_between(np.array([0.0, 0.0, -1.0]), np.array([0.0, 0.0, 1.0]))
        np.testing.assert_allclose(r @ [0, 0, -1.0], [0, 0, 1.0], atol=1e-9)
        self.assertAlmostEqual(np.linalg.det(r), 1.0)


class GpsAlignmentTest(unittest.TestCase):
    def test_drone_orbit_recovers_enu(self):
        rng = np.random.default_rng(2)
        pts_true = scene_points(rng)
        c2w_true, cams = [], []
        for k in range(24):
            a = 2 * math.pi * k / 24
            c = np.array([25 * math.cos(a), 25 * math.sin(a), 30.0])
            c2w_true.append(look_at(c, [0, 0, 0]))
            lat, lng = enu_to_latlng(c[0], c[1])
            cams.append(CameraInfo("drone", "d1", lat, lng, 30.0, None, True))
        c2w_true = np.array(c2w_true)
        sc = Scramble()
        al = align_scene(sc.cams(c2w_true), cams, sc.points(pts_true), *ORIGIN)
        self.assertEqual(al.mode, "gps")
        self.assertTrue(al.scale_known)
        self.assertLess(al.gps_rms_m, 0.05)
        np.testing.assert_allclose(apply_to_points(al.matrix, sc.points(pts_true)), pts_true, atol=0.05)
        cams_back = apply_to_cameras(al.matrix, sc.cams(c2w_true))
        np.testing.assert_allclose(cams_back[:, :3, :3], c2w_true[:, :3, :3], atol=1e-6)

    def test_three_phone_videos(self):
        rng = np.random.default_rng(3)
        pts_true = scene_points(rng)
        positions = [(-20.0, 0.0), (15.0, 10.0), (0.0, -25.0)]
        c2w_true, cams = [], []
        for vid, (x, y) in enumerate(positions):
            lat, lng = enu_to_latlng(x, y)
            for k in range(5):
                # La persona se mueve ±1 m alrededor de su posición GPS.
                c = np.array([x + (k - 2) * 0.5, y, PHONE_HEIGHT_M])
                c2w_true.append(look_at(c, [0, 0, 2.0]))
                cams.append(CameraInfo("citizen", f"m{vid}", lat, lng, None, None, False, accuracy_m=8.0))
        c2w_true = np.array(c2w_true)
        sc = Scramble(seed=4)
        al = align_scene(sc.cams(c2w_true), cams, sc.points(pts_true), *ORIGIN)
        self.assertEqual(al.mode, "gps")
        self.assertEqual(al.gps_positions, 3)
        np.testing.assert_allclose(apply_to_points(al.matrix, sc.points(pts_true)), pts_true, atol=0.05)

    def test_collinear_flight_falls_back_to_approximate(self):
        rng = np.random.default_rng(5)
        pts_true = scene_points(rng)
        c2w_true, cams = [], []
        for k in range(12):
            c = np.array([-30.0 + 5 * k, -20.0, 30.0])
            c2w_true.append(look_at(c, [c[0], 0.0, 0.0]))
            lat, lng = enu_to_latlng(c[0], c[1])
            cams.append(CameraInfo("drone", "d1", lat, lng, 30.0, None, True))
        sc = Scramble(seed=6)
        al = align_scene(sc.cams(np.array(c2w_true)), cams, sc.points(pts_true), *ORIGIN)
        self.assertEqual(al.mode, "approximate")
        self.assertFalse(al.scale_known)
        self.assertIn("línea recta", al.note)

    def test_bad_gps_is_rejected(self):
        rng = np.random.default_rng(7)
        pts_true = scene_points(rng)
        c2w_true, cams = [], []
        # Las posiciones informadas no tienen relación con las cámaras reales.
        fake = [(200.0, 0.0), (-150.0, 300.0), (0.0, -400.0), (90.0, 90.0)]
        real = [(-20.0, 0.0), (15.0, 10.0), (0.0, -25.0), (10.0, -10.0)]
        for vid, ((fx, fy), (x, y)) in enumerate(zip(fake, real)):
            lat, lng = enu_to_latlng(fx, fy)
            for k in range(3):
                c2w_true.append(look_at([x + k * 0.3, y, PHONE_HEIGHT_M], [0, 0, 2.0]))
                cams.append(CameraInfo("citizen", f"m{vid}", lat, lng, None, None, False))
        sc = Scramble(seed=8)
        al = align_scene(sc.cams(np.array(c2w_true)), cams, sc.points(pts_true), *ORIGIN)
        self.assertEqual(al.mode, "approximate")
        self.assertIn("no calza", al.note)


class ApproximateAlignmentTest(unittest.TestCase):
    def phone_walk(self, heading=None, gps=None):
        rng = np.random.default_rng(9)
        pts_true = scene_points(rng)
        c2w_true, cams = [], []
        for k in range(15):
            c = np.array([-6.0 + k, -18.0, PHONE_HEIGHT_M])
            c2w_true.append(look_at(c, [0.0, 0.0, 2.0]))
            lat, lng = gps if gps else (None, None)
            cams.append(CameraInfo("citizen", "m1", lat, lng, None, heading, False))
        return pts_true, np.array(c2w_true), cams

    def test_vertical_ground_and_scale_from_phone_height(self):
        pts_true, c2w_true, cams = self.phone_walk()
        sc = Scramble(seed=10)
        al = align_scene(sc.cams(c2w_true), cams, sc.points(pts_true), *ORIGIN)
        self.assertEqual(al.mode, "approximate")
        self.assertFalse(al.scale_known)
        out = apply_to_points(al.matrix, sc.points(pts_true))
        ground = out[:6000]
        self.assertLess(abs(float(np.median(ground[:, 2]))), 0.1)
        # La casa queda de pie y con su altura real (la escala sale de la altura del teléfono).
        house_h = float(np.percentile(out[6000:, 2], 99) - np.median(ground[:, 2]))
        self.assertAlmostEqual(house_h, 6.0, delta=0.3)
        cams_out = apply_to_cameras(al.matrix, sc.cams(c2w_true))
        self.assertTrue(np.all(-cams_out[:, 2, 1] > 0.9))  # "arriba" de la imagen ≈ +z

    def test_heading_sets_yaw(self):
        # Cámaras mirando al norte en la realidad; la brújula dice 90° (este): se respeta la brújula.
        pts_true, c2w_true, cams = self.phone_walk(heading=90.0)
        sc = Scramble(seed=11)
        al = align_scene(sc.cams(c2w_true), cams, sc.points(pts_true), *ORIGIN)
        cams_out = apply_to_cameras(al.matrix, sc.cams(c2w_true))
        fwd = cams_out[:, :3, 2].mean(axis=0)
        self.assertGreater(fwd[0], 0.8)

    def test_single_gps_places_camera(self):
        lat, lng = enu_to_latlng(40.0, -60.0)
        pts_true, c2w_true, cams = self.phone_walk(gps=(lat, lng))
        sc = Scramble(seed=12)
        al = align_scene(sc.cams(c2w_true), cams, sc.points(pts_true), *ORIGIN)
        cams_out = apply_to_cameras(al.matrix, sc.cams(c2w_true))
        center = cams_out[:, :2, 3].mean(axis=0)
        np.testing.assert_allclose(center, [40.0, -60.0], atol=0.5)
        self.assertIn("única posición GPS", al.note)

    def test_ground_plane(self):
        rng = np.random.default_rng(13)
        pts = scene_points(rng)
        plane = fit_ground_plane(pts, np.array([0.1, 0.0, 1.0]))
        self.assertIsNotNone(plane)
        self.assertGreater(plane.normal[2], 0.999)
        self.assertLess(abs(plane.point[2]), 0.05)


class GeoTest(unittest.TestCase):
    def test_matches_app_projection(self):
        # Mismo cálculo que toLocal() de src/lib/geo.ts: 0,001° de latitud ≈ 111,19 m.
        x, y = to_enu(ORIGIN[0], ORIGIN[1], ORIGIN[0] + 0.001, ORIGIN[1])
        self.assertAlmostEqual(y, 111.19, places=2)
        self.assertAlmostEqual(x, 0.0)


if __name__ == "__main__":
    unittest.main()
