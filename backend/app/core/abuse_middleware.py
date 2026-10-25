"""Pre-body limits and private-media cache policy; Nginx remains the public edge."""

import json

from fastapi import HTTPException

from app.core.config import settings
from app.core.request_limits import attempt_limiter

MAX_BODY = 22 * 1024 * 1024


class BodyLimitError(Exception):
    pass


class AbuseMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "").rstrip("/")
        prefix = settings.API_V1_PREFIX.rstrip("/")
        legacy = settings.MEDIA_PUBLIC_PREFIX.rstrip("/")
        private = (path == prefix + "/media" or path.startswith(prefix + "/media/")
                   or path.startswith(prefix + "/auth/"))
        sent = False

        async def guarded_send(message):
            nonlocal sent
            if message["type"] == "http.response.start":
                sent = True
                if private:
                    headers = [(k, v) for k, v in message.get("headers", [])
                               if k.lower() not in {b"cache-control", b"vary"}]
                    message = {**message, "headers": headers + [
                        (b"cache-control", b"private, no-store"),
                        (b"vary", b"Authorization"),
                        (b"x-content-type-options", b"nosniff"),
                    ]}
            await send(message)

        async def reject(status, text, headers=None):
            body = json.dumps({"code": status, "message": text, "data": None}).encode()
            values = [(b"content-type", b"application/json"),
                      (b"cache-control", b"private, no-store")]
            values += [(k.lower().encode(), str(v).encode()) for k, v in (headers or {}).items()
                       if k.lower() != "cache-control"]
            await guarded_send({"type": "http.response.start", "status": status, "headers": values})
            await guarded_send({"type": "http.response.body", "body": body})

        if legacy and (path == legacy or path.startswith(legacy + "/")):
            return await reject(404, "资源不存在")
        if path != prefix and not path.startswith(prefix + "/"):
            return await self.app(scope, receive, guarded_send)
        ip = (scope.get("client") or ("unknown", 0))[0]
        method = scope.get("method", "GET")
        try:
            attempt_limiter.consume("api-ip", ip, settings.API_IP_PER_MINUTE, 60)
            if method == "POST" and path == prefix + "/auth/register":
                attempt_limiter.consume("register-ip", ip, settings.REGISTER_IP_PER_HOUR, 3600)
                attempt_limiter.consume(
                    "register-global", "all", settings.REGISTER_GLOBAL_PER_DAY, 86400,
                )
            elif method == "POST" and path == prefix + "/auth/login":
                attempt_limiter.consume("login-ip", ip, settings.LOGIN_IP_PER_MINUTE, 60)
            elif method == "POST" and path.startswith(prefix + "/media/"):
                attempt_limiter.consume("upload-ip", ip, settings.UPLOAD_IP_PER_MINUTE, 60)
        except HTTPException as exc:
            return await reject(exc.status_code, exc.detail, exc.headers)
        headers = dict(scope.get("headers", []))
        try:
            if int(headers.get(b"content-length", b"0")) > MAX_BODY:
                return await reject(413, "请求内容过大")
        except ValueError:
            return await reject(400, "请求长度无效")
        received = 0
        exceeded = False

        async def bounded_receive():
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > MAX_BODY:
                    exceeded = True
                    raise BodyLimitError()
            return message

        async def bounded_send(message):
            # Multipart may translate receive exceptions to a 400. Keep overflow a 413.
            if exceeded:
                raise BodyLimitError()
            await guarded_send(message)

        try:
            await self.app(scope, bounded_receive, bounded_send)
        except BodyLimitError:
            if sent:
                raise
            await reject(413, "请求内容过大")
