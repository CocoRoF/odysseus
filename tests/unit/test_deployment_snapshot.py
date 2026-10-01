"""Deployment probes must authenticate and fail closed when a protected read fails."""
import importlib.util
import json
import os
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


class DeploymentSnapshotTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("snapshot_under_test", Path(__file__).resolve().parents[2]/"scripts/snapshot.py")
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"BOOTSTRAP_ADMIN_EMAIL": "fixture@test.invalid", "BOOTSTRAP_ADMIN_PASSWORD": "fixture"}):
            spec.loader.exec_module(self.module)
        self.failure = None
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self, status, data, cookie=False):
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                if cookie:
                    self.send_header("Set-Cookie", "odysseus_token=fixture; Secure; HttpOnly; Path=/")
                self.end_headers()
                self.wfile.write(json.dumps(data).encode())

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.respond(200, {}, cookie=True)

            def do_GET(self):
                if "odysseus_token=fixture" not in self.headers.get("Cookie", ""):
                    return self.respond(401, {"detail": "unauthorized"})
                if self.path == owner.failure:
                    return self.respond(500, {"detail": "unavailable"})
                if self.path == "/office/admin/metrics":
                    return self.respond(404, {})  # A pre-migration server is still a valid baseline.
                if self.path == "/admin/settings/ai/providers":
                    value = [{"name": "fixture", "provider": "custom", "has_key": True}]
                elif self.path.startswith("/admin/settings/"):
                    value = {"configured": True}
                else:
                    value = [{"id": "first"}, {"id": "second"}]
                self.respond(200, value)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.module.API = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def test_secure_session_authenticates_on_internal_loopback(self):
        result = self.module.snapshot()
        self.assertEqual(result["counts"]["users"], 2)
        self.assertEqual(result["counts"]["attempts"], 2)
        self.assertTrue(result["ai_providers"][0][2])

    def test_failed_protected_read_cannot_be_reported_as_empty_data(self):
        self.failure = "/admin/users"
        with self.assertRaisesRegex(SystemExit, "조회 실패.*status=500"):
            self.module.snapshot()

    def test_secure_cookie_exception_does_not_apply_to_external_http(self):
        policy = self.module.LoopbackCookiePolicy()
        cookie = SimpleNamespace(secure=True)
        self.assertFalse(policy.return_ok_secure(cookie, urllib.request.Request("http://example.test/")))
        self.assertTrue(policy.return_ok_secure(cookie, urllib.request.Request("https://example.test/")))
