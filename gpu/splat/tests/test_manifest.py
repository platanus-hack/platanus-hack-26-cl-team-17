import copy
import unittest

from splat.manifest import ManifestError, parse_gs_uri, parse_manifest

BASE = {
    "version": 1,
    "incident_id": "inc_1",
    "reconstruction_id": "rec_1",
    "origin": {"lat": -33.45, "lng": -70.66},
    "bucket": "b",
    "output_prefix": "incidents/inc_1/reconstructions/rec_1",
    "callback_url": "https://example.invalid/api/internal/reconstruction/inc_1",
    "iterations": 7000,
    "max_frames": 160,
    "sample_fps": 3,
    "media": [
        {
            "id": "m1",
            "label": "M1",
            "source": "citizen",
            "video_path": "incidents/inc_1/media/m1/video.mp4",
            "lat": -33.4501,
            "lng": -70.6601,
            "accuracy_m": 12,
            "heading_deg": None,
            "frames": [],
        },
        {
            "id": "d1",
            "label": "D1",
            "source": "drone",
            "video_path": None,
            "lat": None,
            "lng": None,
            "accuracy_m": None,
            "heading_deg": None,
            "frames": [
                {"path": "f/0.jpg", "t_s": 0, "lat": -33.45, "lng": -70.66, "alt_m": 30, "heading_deg": 90},
                {"path": "f/1.jpg", "t_s": 2.5, "lat": None, "lng": None, "alt_m": None, "heading_deg": None},
            ],
        },
    ],
}


class ManifestTest(unittest.TestCase):
    def test_parses_contract_shape(self):
        m = parse_manifest(copy.deepcopy(BASE))
        self.assertEqual(m.reconstruction_id, "rec_1")
        self.assertEqual(m.output_prefix, "incidents/inc_1/reconstructions/rec_1/")
        self.assertEqual(m.output_path("scene.splat"), "incidents/inc_1/reconstructions/rec_1/scene.splat")
        self.assertEqual(len(m.media), 2)
        self.assertEqual(m.media[0].video_path, "incidents/inc_1/media/m1/video.mp4")
        self.assertEqual(m.media[1].frames[0].alt_m, 30.0)
        self.assertIsNone(m.media[1].frames[1].lat)
        self.assertEqual(m.sample_fps, 3.0)

    def test_clamps_numbers(self):
        raw = copy.deepcopy(BASE)
        raw["iterations"] = 10
        raw["max_frames"] = 10_000
        m = parse_manifest(raw)
        self.assertEqual(m.iterations, 100)
        self.assertEqual(m.max_frames, 400)

    def test_rejects_invalid(self):
        for mutate, needle in [
            (lambda r: r.update(version=2), "Versión"),
            (lambda r: r.pop("origin"), "origin"),
            (lambda r: r.update(media=[]), "medios"),
            (lambda r: r["media"][0].update(source="demo"), "source"),
            (lambda r: r.update(sample_fps=0), "sample_fps"),
            (lambda r: r.update(iterations="mucho"), "iterations"),
        ]:
            raw = copy.deepcopy(BASE)
            mutate(raw)
            with self.assertRaises(ManifestError) as ctx:
                parse_manifest(raw)
            self.assertIn(needle, str(ctx.exception))

    def test_ignores_partial_or_null_island_positions(self):
        raw = copy.deepcopy(BASE)
        raw["media"][0]["lat"] = 0
        raw["media"][0]["lng"] = 0
        raw["media"][1]["frames"][0]["lng"] = None
        m = parse_manifest(raw)
        self.assertIsNone(m.media[0].lat)
        self.assertIsNone(m.media[1].frames[0].lat)

    def test_gs_uri(self):
        self.assertEqual(parse_gs_uri("gs://bkt/a/b/manifest.json"), ("bkt", "a/b/manifest.json"))
        with self.assertRaises(ManifestError):
            parse_gs_uri("https://storage.googleapis.com/bkt/x")
        with self.assertRaises(ManifestError):
            parse_gs_uri("gs://bkt")


if __name__ == "__main__":
    unittest.main()
