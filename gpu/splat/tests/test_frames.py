import os
import shutil
import subprocess
import tempfile
import unittest

from splat.frames import (
    FrameCandidate,
    allocate,
    drop_blurry,
    frame_candidates,
    gps_for_time,
    pick_sharpest,
    plan_frames,
    sample_video,
    video_candidates,
)
from splat.manifest import ManifestFrame, ManifestMedia


def media(**kw):
    base = dict(
        id="m1",
        label="M1",
        source="citizen",
        video_path=None,
        lat=-33.45,
        lng=-70.66,
        accuracy_m=10.0,
        heading_deg=None,
        frames=(),
    )
    base.update(kw)
    return ManifestMedia(**base)


def cand(media_index, t, sharp=1.0):
    return FrameCandidate(
        media_index=media_index,
        media_id=f"m{media_index}",
        source="citizen",
        local_path=f"/x/{media_index}/{t}.jpg",
        t_s=t,
        lat=None,
        lng=None,
        alt_m=None,
        heading_deg=None,
        per_frame_gps=False,
        sharpness=sharp,
    )


class AllocateTest(unittest.TestCase):
    def test_fair_share_with_redistribution(self):
        self.assertEqual(allocate([100, 10, 50], 60), [25, 10, 25])
        self.assertEqual(sum(allocate([100, 10, 50], 60)), 60)

    def test_total_larger_than_available(self):
        self.assertEqual(allocate([3, 0, 5], 160), [3, 0, 5])

    def test_many_media_small_total(self):
        a = allocate([10] * 7, 5)
        self.assertEqual(sum(a), 5)
        self.assertTrue(all(x in (0, 1) for x in a))

    def test_edge_cases(self):
        self.assertEqual(allocate([], 10), [])
        self.assertEqual(allocate([4, 4], 0), [0, 0])


class PickTest(unittest.TestCase):
    def test_sharpest_per_window_covers_whole_sequence(self):
        scores = [1, 9, 1, 1, 1, 8, 7, 1, 1, 1, 1, 6]
        picked = pick_sharpest(scores, 3)
        self.assertEqual(picked, [1, 5, 11])

    def test_all_when_k_large(self):
        self.assertEqual(pick_sharpest([3, 2, 1], 10), [0, 1, 2])
        self.assertEqual(pick_sharpest([3, 2, 1], 0), [])

    def test_plan_spreads_across_media_in_time_order(self):
        per_media = [[cand(0, t, sharp=t % 3) for t in range(30)], [cand(1, t) for t in range(4)]]
        chosen = plan_frames(per_media, 10)
        self.assertEqual(len(chosen), 10)
        self.assertEqual(sum(1 for c in chosen if c.media_index == 1), 4)
        times0 = [c.t_s for c in chosen if c.media_index == 0]
        self.assertEqual(times0, sorted(times0))
        self.assertGreater(max(times0) - min(times0), 20)

    def test_plan_respects_per_media_cap(self):
        per_media = [[cand(0, t) for t in range(50)], [cand(1, t) for t in range(50)]]
        chosen = plan_frames(per_media, 80, per_media_cap=30)
        self.assertEqual(sum(1 for c in chosen if c.media_index == 0), 30)
        self.assertEqual(sum(1 for c in chosen if c.media_index == 1), 30)

    def test_drop_blurry_removes_moved_frames(self):
        cands = [cand(0, t, sharp=100.0) for t in range(10)] + [cand(0, 10 + t, sharp=5.0) for t in range(3)]
        self.assertEqual([c.t_s for c in drop_blurry(cands)], list(range(10)))

    def test_drop_blurry_keeps_sharpest_half_of_a_bad_video(self):
        sharp = [1.0, 50.0, 2.0, 60.0, 1.5, 55.0, 1.0, 1.2, 1.1, 1.3]
        kept = drop_blurry([cand(0, t, sharp=s) for t, s in enumerate(sharp)])
        self.assertEqual(len(kept), 5)
        self.assertEqual([c.t_s for c in kept], sorted(c.t_s for c in kept))
        self.assertTrue({1, 3, 5} <= {c.t_s for c in kept})


class GpsTest(unittest.TestCase):
    def test_drone_frame_gps_nearest_in_time(self):
        m = media(
            source="drone",
            lat=None,
            lng=None,
            frames=(
                ManifestFrame("a.jpg", 0.0, -33.0, -70.0, 30.0, 10.0),
                ManifestFrame("b.jpg", 5.0, -33.1, -70.1, 35.0, 20.0),
            ),
        )
        self.assertEqual(gps_for_time(m, 4.2), (-33.1, -70.1, 35.0, 20.0, True))
        # Lejos de cualquier cuadro con GPS: cae a la posición del medio (aquí ninguna).
        self.assertEqual(gps_for_time(m, 60.0), (None, None, None, None, False))

    def test_phone_video_uses_media_position(self):
        m = media(heading_deg=45.0)
        cands = video_candidates(m, 0, [("/a.jpg", 0.0), ("/b.jpg", 0.33)])
        self.assertEqual([c.lat for c in cands], [-33.45, -33.45])
        self.assertFalse(cands[0].per_frame_gps)
        self.assertEqual(cands[1].heading_deg, 45.0)

    def test_extracted_frames(self):
        m = media(
            source="drone",
            frames=(
                ManifestFrame("a.jpg", 0.0, -33.0, -70.0, 30.0, None),
                ManifestFrame("b.jpg", 1.0, None, None, None, None),
            ),
        )
        c = frame_candidates(m, 2, ["/l/a.jpg", "/l/b.jpg"])
        self.assertTrue(c[0].per_frame_gps)
        self.assertEqual(c[0].alt_m, 30.0)
        self.assertFalse(c[1].per_frame_gps)
        self.assertEqual(c[1].lat, -33.45)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "requiere ffmpeg")
class SampleVideoTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="splat-test-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def make_video(self, w, h, seconds, name="v.mp4"):
        path = os.path.join(self.dir, name)
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
             "-i", f"testsrc2=size={w}x{h}:rate=30:duration={seconds}",
             "-pix_fmt", "yuv420p", path],
            check=True,
        )
        return path

    def probe_size(self, path):
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
             "-of", "csv=p=0", path],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        w, h = out.split(",")
        return int(w), int(h)

    def test_samples_at_fps_and_limits_long_edge_portrait(self):
        video = self.make_video(1080, 1920, 4)
        samples = sample_video(video, os.path.join(self.dir, "out"), fps=3, long_edge=1280)
        self.assertIn(len(samples), (12, 13))
        self.assertAlmostEqual(samples[3][1], 1.0, places=3)
        self.assertEqual(self.probe_size(samples[0][0]), (720, 1280))

    def test_does_not_upscale_and_caps_candidates(self):
        video = self.make_video(640, 360, 4, "small.mp4")
        samples = sample_video(video, os.path.join(self.dir, "out2"), fps=10, long_edge=1280, max_candidates=8)
        self.assertLessEqual(len(samples), 8)
        self.assertGreaterEqual(len(samples), 7)
        self.assertEqual(self.probe_size(samples[0][0]), (640, 360))
        # El fps efectivo baja para cubrir todo el video con el tope.
        self.assertGreater(samples[-1][1], 3.0)


if __name__ == "__main__":
    unittest.main()
