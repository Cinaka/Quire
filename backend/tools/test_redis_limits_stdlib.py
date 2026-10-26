"""Actual async facade with injected config/HTTP/Redis ports; NOT real Redis or ASGI.

No dependencies installed. Lua semantics are covered by opt-in real Redis pytest tests.
"""
import asyncio
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, patch

from test_p7_security_stdlib import HTTPException, injected


class Secret:
    def __init__(self, value):
        self.value = value

    def get_secret_value(self):
        return self.value


def config():
    return SimpleNamespace(
        REDIS_ENABLED=True, REDIS_KEY_PREFIX="quire:test:rl:v1",
        REDIS_URL=Secret("redis://private:secret@127.0.0.1:6379/15"),
        REDIS_MAX_CONNECTIONS=20,
        REDIS_HMAC_SECRET=Secret("not-a-real-secret" * 3),
        REDIS_CONNECT_TIMEOUT=0.01, REDIS_SOCKET_TIMEOUT=0.01,
        REDIS_ATTEMPT_MAX_KEYS=4096, REDIS_LOGIN_MAX_KEYS=10000,
    )


class RedisFacadeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.settings = config()
        self.mod = injected("core/redis_limits.py", {
            "settings": self.settings,
            "__file__": str(Path(__file__).resolve().parents[1] / "app/core/redis_limits.py"),
        })
        self.backend = self.mod.redis_limits
        self.backend.client = SimpleNamespace(aclose=AsyncMock())
        self.backend.script = AsyncMock(return_value=[0, 0, "revision"])
        self.memory = SimpleNamespace(
            consume=lambda *args: self.calls.append(args),
            check=lambda key: self.calls.append(("check", key)),
            fail=lambda key: self.calls.append(("fail", key)),
            clear=lambda key: self.calls.append(("clear", key)),
            max_failures=10, window_seconds=900,
        )
        self.calls = []

    def fake_redis_modules(self, client):
        redis = ModuleType("redis")
        redis.asyncio = ModuleType("redis.asyncio")
        redis.asyncio.from_url = lambda *args, **kwargs: client
        backoff, retry = ModuleType("redis.backoff"), ModuleType("redis.retry")
        backoff.NoBackoff = lambda: None
        retry.Retry = lambda *args: None
        return {"redis": redis, "redis.asyncio": redis.asyncio,
                "redis.backoff": backoff, "redis.retry": retry}

    async def test_start_verifies_all_operation_acl_paths(self):
        script = AsyncMock(return_value=[0, 0, "revision"])
        client = SimpleNamespace(register_script=lambda source: script, aclose=AsyncMock())
        with patch.dict(sys.modules, self.fake_redis_modules(client)):
            await self.backend.start()
        operations = [call.kwargs["args"][0] for call in script.call_args_list]
        self.assertEqual(operations, ["consume", "fail", "check", "clear"])
        self.assertEqual(script.call_args.kwargs["args"][-1], "revision")
        await self.backend.close()
        client.aclose.assert_awaited_once()

    async def test_startup_failure_closes_client_and_hides_original_error(self):
        script = AsyncMock(side_effect=RuntimeError("redis://private:secret"))
        client = SimpleNamespace(register_script=lambda source: script, aclose=AsyncMock())
        with patch.dict(sys.modules, self.fake_redis_modules(client)):
            with self.assertRaises(RuntimeError) as caught:
                await self.backend.start()
        self.assertEqual(str(caught.exception), "Redis safety backend startup check failed")
        client.aclose.assert_awaited_once()
        self.assertIsNone(self.backend.client)

    async def test_disabled_start_never_imports_redis(self):
        self.settings.REDIS_ENABLED = False
        self.backend.client = None
        await self.backend.start()
        self.assertIsNone(self.backend.client)

    async def test_consume_uses_shared_script_not_memory(self):
        await self.mod.consume_attempt(self.memory, "api-ip", "127.0.0.1", 240, 60)
        self.assertEqual(self.calls, [])
        args = self.backend.script.call_args.kwargs["args"]
        self.assertEqual(args[0], "consume")
        self.assertEqual(args[2:5], [240, 60000, 4096])

    async def test_disabled_mode_uses_existing_memory(self):
        self.settings.REDIS_ENABLED = False
        await self.mod.consume_attempt(self.memory, "api-ip", "ip", 2, 60)
        self.assertEqual(await self.mod.check_login(self.memory, "ip:email"), "")
        await self.mod.fail_login(self.memory, "ip:email")
        await self.mod.clear_login(self.memory, "ip:email", "")
        self.assertEqual(len(self.calls), 4)
        self.backend.script.assert_not_called()

    async def test_unstarted_enabled_backend_is_503(self):
        self.backend.client = None
        with self.assertRaises(HTTPException) as caught:
            await self.mod.consume_attempt(self.memory, "a", "b", 1, 60)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(self.calls, [])

    async def test_network_oom_acl_and_pool_errors_are_503_without_leaks(self):
        for text in ("redis://user:secret@host", "OOM", "NOPERM", "pool full"):
            self.backend.script.side_effect = RuntimeError(text)
            with self.assertRaises(HTTPException) as caught:
                await self.mod.consume_attempt(self.memory, "a", "b", 1, 60)
            self.assertEqual(caught.exception.status_code, 503)
            self.assertNotIn(text, str(caught.exception))
        self.assertEqual(self.calls, [])

    async def test_whole_operation_timeout_is_503(self):
        async def slow(**kwargs):
            await asyncio.sleep(1)
        self.backend.script = slow
        with self.assertRaises(HTTPException) as caught:
            await self.mod.consume_attempt(self.memory, "a", "b", 1, 60)
        self.assertEqual(caught.exception.status_code, 503)

    async def test_exhausted_limit_is_429(self):
        self.backend.script.return_value = [1, 42, ""]
        with self.assertRaises(HTTPException) as caught:
            await self.mod.consume_attempt(self.memory, "a", "b", 1, 60)
        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(caught.exception.headers["Retry-After"], "42")

    async def test_malformed_response_fails_closed(self):
        for response in (None, [], [2, 0, ""], [1, "secret", ""], [0, 0, None]):
            self.backend.script.return_value = response
            with self.assertRaises(HTTPException) as caught:
                await self.mod.consume_attempt(self.memory, "a", "b", 1, 60)
            self.assertEqual(caught.exception.status_code, 503)

    async def test_hmac_keys_hide_email_and_ip(self):
        keys, ident = self.backend.keys("login-fail", "127.0.0.1:user@example.test")
        self.assertNotIn("127.0.0.1", str(keys))
        self.assertNotIn("user@example.test", ident)
        self.assertEqual(keys, self.backend.keys("login-fail", "127.0.0.1:user@example.test")[0])
        self.assertNotEqual(keys, self.backend.keys("api-ip", "127.0.0.1:user@example.test")[0])
        self.settings.REDIS_KEY_PREFIX = "quire:other:rl:v1"
        self.assertNotEqual(keys, self.backend.keys("login-fail", "127.0.0.1:user@example.test")[0])

    async def test_login_revision_is_passed_to_compare_and_clear(self):
        rev = await self.mod.check_login(self.memory, "ip:email")
        self.assertEqual(rev, "revision")
        await self.mod.clear_login(self.memory, "ip:email", rev)
        args = self.backend.script.call_args.kwargs["args"]
        self.assertEqual(args[0], "clear")
        self.assertEqual(args[-1], rev)
        await self.mod.fail_login(self.memory, "ip:email")
        self.assertEqual(self.backend.script.call_args.kwargs["args"][0], "fail")

    async def test_write_tokens_are_unique(self):
        await self.mod.fail_login(self.memory, "ip:email")
        first = self.backend.script.call_args.kwargs["args"][5]
        await self.mod.fail_login(self.memory, "ip:email")
        self.assertNotEqual(first, self.backend.script.call_args.kwargs["args"][5])

    async def test_health_is_false_on_write_failure(self):
        self.backend.script.side_effect = RuntimeError("OOM")
        self.assertFalse(await self.backend.healthy())
        self.backend.script.side_effect = None
        self.assertTrue(await self.backend.healthy())

    async def test_close_releases_pool_and_never_leaks_close_error(self):
        client = self.backend.client
        client.aclose.side_effect = RuntimeError("redis://secret")
        await self.backend.close()
        client.aclose.assert_awaited_once()
        self.assertIsNone(self.backend.client)
        self.assertIsNone(self.backend.script)

    async def test_cancelled_request_not_converted_to_http_error(self):
        self.backend.script.side_effect = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.mod.consume_attempt(self.memory, "a", "b", 1, 60)

    async def test_unready_health_is_false(self):
        self.backend.client = None
        self.assertFalse(await self.backend.healthy())


class MiddlewareRedisFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_503_before_body_and_health_bypasses_business_limiter(self):
        settings = SimpleNamespace(API_V1_PREFIX="/api/v1", MEDIA_PUBLIC_PREFIX="/media",
                                   API_IP_PER_MINUTE=240)
        called = []
        consume = AsyncMock(side_effect=HTTPException(503, "安全限流服务暂不可用", {
            "Retry-After": "3", "Cache-Control": "private, no-store",
        }))
        mod = injected("core/abuse_middleware.py", {
            "settings": settings, "attempt_limiter": None, "consume_attempt": consume,
        })

        async def app(scope, receive, send):
            called.append(scope["path"])
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

        async def receive():
            raise AssertionError("business body must not be read")

        messages = []

        async def send(message):
            messages.append(message)

        middleware = mod.AbuseMiddleware(app)
        for path in ("/api/v1/auth/register", "/api/v1/sync/push", "/api/v1/media/id"):
            await middleware({"type": "http", "path": path, "method": "POST"}, receive, send)
            self.assertEqual(messages[-2]["status"], 503)
            self.assertEqual(dict(messages[-2]["headers"])[b"retry-after"], b"3")
        self.assertEqual(called, [])
        before = consume.await_count
        await middleware({"type": "http", "path": "/api/v1/health", "method": "GET"}, receive, send)
        self.assertEqual(called, ["/api/v1/health"])
        self.assertEqual(consume.await_count, before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
