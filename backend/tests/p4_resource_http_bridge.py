"""Test-only loopback HTTP -> actual ASGI TestClient bridge; never a dev API proxy."""

import hmac
import json
import secrets
import threading
import uuid
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

MAX_RESPONSE = 14 * 1024 * 1024


def canonical_v7(value):
    parsed = uuid.UUID(value)
    if parsed.version != 7 or str(parsed) != value:
        raise ValueError("test bridge requires a canonical UUID v7")
    return value


@contextmanager
def resource_http_bridge(client, source_id, media_id, before_image=None):
    """Only known fixture GETs, nonce gate, no cookie forwarding, no external destinations."""
    source_id, media_id = canonical_v7(source_id), canonical_v7(media_id)
    nonce = secrets.token_urlsafe(32)
    root = f"/api/v1/schedules/{source_id}/review/resources"
    image_paths = {f"{root}/{media_id}/{variant}" for variant in ("original", "thumbnail")}
    records = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def setup(self):
            super().setup()
            self.connection.settimeout(2)

        def log_message(self, *_args):
            pass  # Never print URLs, Authorization, nonce or response bytes.

        def reply(self, status, content, headers=None):
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Connection", "close")
            for key in ("Cache-Control", "Pragma", "X-Content-Type-Options", "WWW-Authenticate"):
                if headers and key in headers:
                    self.send_header(key, headers[key])
            self.end_headers()
            try:
                self.wfile.write(content)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def deny(self, status):
            self.reply(status, b'{"code":-1,"message":"test bridge refused","data":null}')

        def do_GET(self):
            if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
                self.deny(403)
                return
            candidate = self.headers.get("X-Quire-P4-Test-Run", "")
            if not candidate.isascii() or not hmac.compare_digest(candidate, nonce):
                self.deny(403)
                return
            if (self.headers.get("Transfer-Encoding")
                    or self.headers.get("Content-Length", "0") != "0"):
                self.deny(400)
                return
            if len(self.path) > 4096:
                self.deny(414)
                return
            url = urlsplit(self.path)
            if url.scheme or url.netloc or url.fragment:
                self.deny(403)
                return
            if url.path == "/__quire_p4_resource_contract__" and not url.query:
                self.reply(200, json.dumps({"kind": "quire-p4-resource-http-test/v1"}).encode())
                return
            if url.path != root and url.path not in image_paths:
                self.deny(403)
                return
            try:
                if before_image and url.path in image_paths:
                    before_image()
                # Authentication belongs to the actual ASGI JWT + DB-user dependency.
                headers = {"Authorization": self.headers.get("Authorization", "")}
                response = client.get(self.path, headers=headers, follow_redirects=False)
                body = response.content
                if len(body) > MAX_RESPONSE:
                    self.deny(502)
                    return
                records.append({"image": url.path in image_paths, "status": response.status_code,
                                "no_store": response.headers.get("Cache-Control") == "no-store",
                                "has_bytes": b'"data_base64"' in body})
                self.reply(response.status_code, body, response.headers)
            except Exception:
                self.deny(500)

        def refuse_method(self):
            self.deny(405)

        # BaseHTTPRequestHandler dispatches using these exact standard-library names.
        do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = refuse_method  # noqa: N815

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True,
    )
    thread.start()
    try:
        yield {"origin": f"http://127.0.0.1:{server.server_port}", "nonce": nonce,
               "source_id": source_id, "media_id": media_id, "records": records}
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()
        if thread.is_alive():
            raise RuntimeError("test HTTP bridge failed to stop")
