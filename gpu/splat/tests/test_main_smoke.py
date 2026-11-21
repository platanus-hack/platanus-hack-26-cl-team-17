"""Prueba de humo de main.run sin GPU: VGGT, gsplat y GCS se reemplazan por dobles; el registro
entre medios, la nube inicial, la alineación y la exportación corren de verdad sobre la escena
sintética de test_register. Se salta si torch no está instalado (gpu/splat/.venv no lo trae)."""

import os
import shutil
import sys
import tempfile
import types
import unittest
from unittest import mock

import numpy as np

try:
    import torch
except ImportError:  # pragma: no cover
    torch = None


@unittest.skipIf(torch is None, "torch no está instalado")
class MainSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import cv2

        from tests.test_register import K, build_case

        cls.tmp = tempfile.mkdtemp()
        cls.uploaded = {}
        fake_gcs = types.ModuleType("splat.gcs")
        def upload_file(bucket, name, path, ct):
            with open(path, "rb") as fh:
                cls.uploaded[name] = fh.read()

        fake_gcs.upload_file = upload_file
        fake_gcs.upload_json = lambda bucket, name, data: cls.uploaded.__setitem__(name, data)
        sys.modules["splat.gcs"] = fake_gcs
        import splat.main as main
        import splat.posing as posing
        import splat.register as register
        import splat.train as train
        from splat.frames import FrameCandidate
        from splat.manifest import Manifest, ManifestMedia
        from splat.posing import GroupPose

        images, depths, c2w_local, _true, group_of = build_case()
        per_media = []
        for g in range(3):
            cands = []
            for k in np.nonzero(group_of == g)[0]:
                path = os.path.join(cls.tmp, f"g{g}_{k:03d}.jpg")
                cv2.imwrite(path, cv2.cvtColor(images[k], cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 95])
                cands.append(
                    FrameCandidate(
                        media_index=g, media_id=f"m{g}", source="citizen", local_path=path, t_s=float(k),
                        lat=None, lng=None, alt_m=None, heading_deg=None, per_frame_gps=False, sharpness=100.0,
                    )
                )
            per_media.append(cands)

        def fake_poses(imgs, groups, weights, device, log=print):
            out = []
            for idx in groups:
                g = int(group_of[idx[0]])
                sel = np.nonzero(group_of == g)[0]
                out.append(
                    GroupPose(
                        c2w=c2w_local[sel], Ks=np.repeat(K[None], len(sel), axis=0), depths=[depths[i] for i in sel],
                        confident_fraction=np.ones(len(sel)), registered=np.ones(len(sel), dtype=bool), conf_threshold=1.0,
                    )
                )
            return out

        cls.train_args = {}

        def fake_train(imgs, c2w, ks, points, colors, iterations, device, progress, log=print, seed=0, deadline=None):
            cls.train_args.update(n=len(imgs), points=points, deadline=deadline)
            n = len(points)
            progress(iterations, iterations, n, 27.0)
            far = np.array([[1e4, 0, 0]])
            means = np.concatenate((points, far))
            return (
                train.TrainedSplats(
                    means=means, log_scales=np.full((n + 1, 3), -4.0), quats_wxyz=np.tile([1.0, 0, 0, 0], (n + 1, 1)),
                    opacity_logits=np.full(n + 1, 2.0), sh0=np.zeros((n + 1, 3)), c2w=c2w, psnr=27.0, count=n + 1,
                    steps=iterations,
                ),
                None,
            )

        props = types.SimpleNamespace(name="CPU de prueba", total_memory=96e9, major=0, minor=0)
        manifest = Manifest(
            incident_id="inc", reconstruction_id="rec", origin_lat=-33.45, origin_lng=-70.66, bucket="b",
            output_prefix="out/", callback_url="http://127.0.0.1:9/cb", iterations=30000, max_frames=300,
            sample_fps=3.0,
            media=tuple(
                ManifestMedia(id=f"m{g}", label=f"Video {'ABC'[g]}", source="citizen", video_path=None, lat=None,
                              lng=None, accuracy_m=None, heading_deg=None, frames=())
                for g in range(3)
            ),
        )
        real_match_all = register.match_all
        rep = main.Reporter(manifest.callback_url, "t", manifest.reconstruction_id, None, started_at=main.T0)
        patches = [
            mock.patch.object(main, "gather_candidates", lambda m, root: per_media),
            mock.patch.object(posing, "estimate_poses", fake_poses),
            mock.patch.object(train, "train_splats", fake_train),
            mock.patch.object(train, "render_view", lambda *a, **k: np.zeros((10, 10, 3), np.uint8)),
            # Sin GPU: el emparejamiento corre en numpy aunque main le pase device="cuda".
            mock.patch.object(register, "match_all", lambda feats, pairs, device=None, **kw: real_match_all(feats, pairs, device=None, **kw)),
            mock.patch.object(torch.cuda, "is_available", lambda: True),
            mock.patch.object(torch.cuda, "get_device_properties", lambda i: props),
            mock.patch.object(main.Reporter, "send", lambda self, status, progress, message, **kw: setattr(self, "last", {"status": status, "message": message, **kw})),
        ]
        for p in patches:
            p.start()
        try:
            cls.result = main.run(manifest, rep, cls.tmp)
        finally:
            for p in patches:
                p.stop()
            del sys.modules["splat.gcs"]

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_ready_without_the_unrelated_video(self):
        self.assertEqual(self.result["status"], "ready")
        self.assertEqual(self.result["dropped_media"], ["Video C"])
        self.assertIn("Sin «Video C»", self.result["message"])
        self.assertTrue(self.result["bundle_adjusted"])
        self.assertGreaterEqual(self.result["frames_registered"], 13)
        self.assertEqual(self.train_args["n"], self.result["frames_registered"])
        self.assertIsNotNone(self.train_args["deadline"])

    def test_export_drops_far_gaussians(self):
        from splat.splat_io import decode_splat

        data = decode_splat(self.uploaded["out/scene.splat"])
        self.assertEqual(len(data["position"]), self.result["gaussians"])
        self.assertLess(float(np.abs(data["position"]).max()), 1e3)


if __name__ == "__main__":
    unittest.main()
