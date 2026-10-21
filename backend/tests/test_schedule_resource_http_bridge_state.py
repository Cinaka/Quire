"""Real stdlib loopback checks with a fake ASGI client; not the JWT integration suite."""

import http.client
import json
import unittest
from types import SimpleNamespace
from urllib.parse import urlsplit

from p4_resource_http_bridge import resource_http_bridge

SOURCE = "019a0300-1234-7000-8000-000000000001"
MEDIA = "019a0300-1234-7000-8000-000000000002"
ROOT = f"/api/v1/schedules/{SOURCE}/review/resources"


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.calls = []

        def get(path, **kwargs):
            self.calls.append((path, kwargs))
            return SimpleNamespace(status_code=409, content=b'{"code":409,"data":null}',
                                   headers={"Cache-Control": "no-store", "Pragma": "no-cache"})

        self.scope = resource_http_bridge(SimpleNamespace(get=get), SOURCE, MEDIA)
        self.bridge = self.scope.__enter__()

    def tearDown(self):
        self.scope.__exit__(None, None, None)

    def request(self, path=ROOT, method="GET", headers=None, nonce=True):
        parsed = urlsplit(self.bridge["origin"])
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=2)
        values = {"X-Quire-P4-Test-Run": self.bridge["nonce"]} if nonce else {}
        values.update(headers or {})
        try:
            connection.request(method, path, headers=values)
            reply = connection.getresponse()
            return reply.status, dict(reply.headers), reply.read()
        finally:
            connection.close()

    def test_actual_loopback_forwards_only_authorization_and_preserves_cache_headers(self):
        status, headers, _ = self.request(
            headers={"Authorization": "Bearer fixture", "Cookie": "secret"},
        )
        self.assertEqual(status, 409)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["Pragma"], "no-cache")
        self.assertEqual(self.calls[0][1], {
            "headers": {"Authorization": "Bearer fixture"}, "follow_redirects": False,
        })
        self.assertEqual(self.bridge["records"], [{
            "image": False, "status": 409, "no_store": True, "has_bytes": False,
        }])

    def test_handshake_never_calls_the_app_or_discloses_nonce(self):
        status, _, body = self.request("/__quire_p4_resource_contract__")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"kind": "quire-p4-resource-http-test/v1"})
        self.assertNotIn(self.bridge["nonce"].encode(), body)
        self.assertEqual(self.calls, [])

    def test_wrong_nonce_and_host_are_rejected_before_app(self):
        for headers in [{"X-Quire-P4-Test-Run": "wrong"}, {"Host": "localhost:1"}]:
            with self.subTest(headers=headers):
                self.assertEqual(self.request(headers=headers)[0], 403)
        self.assertEqual(self.request(nonce=False)[0], 403)
        self.assertEqual(self.calls, [])

    def test_all_non_fixture_routes_and_write_methods_are_refused(self):
        for path in ["/auth/refresh", "/api/v1/sync/push", "/media/private", "http://example.org/"]:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 403)
        for method in ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]:
            with self.subTest(method=method):
                self.assertEqual(self.request(method=method)[0], 405)
        self.assertEqual(self.calls, [])

    def test_body_and_oversized_path_are_refused(self):
        self.assertEqual(self.request(headers={"Content-Length": "1"})[0], 400)
        self.assertEqual(self.request(ROOT + "?x=" + "a" * 4096)[0], 414)
        self.assertEqual(self.calls, [])

    def test_only_original_and_thumbnail_of_the_fixed_fixture_are_forwarded(self):
        for variant in ["original", "thumbnail"]:
            self.assertEqual(self.request(f"{ROOT}/{MEDIA}/{variant}")[0], 409)
        self.assertEqual(self.request(f"{ROOT}/{MEDIA}/other")[0], 403)
        self.assertEqual(len(self.calls), 2)

    def test_invalid_identity_is_rejected_before_binding_a_listener(self):
        with self.assertRaises(ValueError):
            with resource_http_bridge(None, "not-a-uuid", MEDIA):
                self.fail("unexpected listener")
