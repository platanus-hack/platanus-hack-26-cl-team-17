import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from splat.callback import Cancelled, Reporter


class Recorder(BaseHTTPRequestHandler):
    received: list = []
    cancel = False
    status = 200

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Recorder.received.append((self.path, self.headers.get("Authorization"), body))
        payload = json.dumps({"ok": True, "cancel": Recorder.cancel}).encode()
        self.send_response(Recorder.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class ReporterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Recorder)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/api/internal/reconstruction/inc_1"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Recorder.received = []
        Recorder.cancel = False
        Recorder.status = 200
        self.t = [100.0]
        self.rep = Reporter(self.url, "tok123", "rec_1", "nvidia-rtx-pro-6000", started_at=90.0, clock=lambda: self.t[0])

    def test_posts_update_with_bearer_token(self):
        self.rep.send("posing", 0.1, "Estimando cámaras de 84 cuadros…", frame_count=84, frames_registered=None)
        path, auth, body = Recorder.received[0]
        self.assertEqual(path, "/api/internal/reconstruction/inc_1")
        self.assertEqual(auth, "Bearer tok123")
        self.assertEqual(body["reconstruction_id"], "rec_1")
        self.assertEqual(body["status"], "posing")
        self.assertEqual(body["frame_count"], 84)
        self.assertNotIn("frames_registered", body)  # los None no se envían
        self.assertEqual(body["gpu"], "nvidia-rtx-pro-6000")
        self.assertEqual(body["gpu_seconds"], 10.0)

    def test_cancel_raises_except_on_final(self):
        Recorder.cancel = True
        with self.assertRaises(Cancelled):
            self.rep.send("training", 0.5, "Entrenando")
        self.rep.fail("Cancelada")  # no lanza
        body = Recorder.received[-1][2]
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["error"], "Cancelada")
        self.assertEqual(body["progress"], 0.5)

    def test_callback_failure_does_not_stop_the_job(self):
        Recorder.status = 500
        self.rep.send("preparing", 0.02, "Descargando")
        self.assertEqual(self.rep.failures, 1)
        rep = Reporter("http://127.0.0.1:9/no-existe", "t", "rec_1", None)
        rep.send("preparing", 0.02, "Descargando")
        self.assertEqual(rep.failures, 1)
        rep2 = Reporter("https://callback.vigia.invalid/x", "t", "rec_1", None)
        rep2.send("preparing", 0.02, "Descargando")
        self.assertEqual(rep2.failures, 1)

    def test_training_is_throttled_to_five_percent(self):
        for step in range(1, 1001):
            self.rep.training(step, 1000, 0.22, 0.68, f"paso {step}", gaussians=step)
        statuses = [b for _, _, b in Recorder.received]
        self.assertTrue(18 <= len(statuses) <= 21, len(statuses))
        self.assertEqual(statuses[-1]["progress"], 0.9)
        self.assertEqual(statuses[-1]["gaussians"], 1000)

    def test_truncates_long_texts(self):
        self.rep.fail("x" * 5000)
        body = Recorder.received[-1][2]
        self.assertEqual(len(body["message"]), 400)
        self.assertEqual(len(body["error"]), 1000)


if __name__ == "__main__":
    unittest.main()
