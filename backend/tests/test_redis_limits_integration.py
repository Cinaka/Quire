"""Opt-in REAL Redis tests. Requires a disposable loopback Redis DB 15, never production.

Set QUIRE_TEST_REDIS_URL to a disposable server; see deployment guide.
Only UUID-prefixed test keys are removed. No FLUSHDB/FLUSHALL/CONFIG/SHUTDOWN.
"""

import asyncio
import multiprocessing
import os
from contextlib import asynccontextmanager
from types import SimpleNamespace
from urllib.parse import urlparse
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import SecretStr

from app.core.config import settings
from app.core.redis_limits import RedisLimits

SECRET = "integration-only-not-production-secret-32"


@pytest.fixture
def redis_config(monkeypatch):
    url = os.environ.get("QUIRE_TEST_REDIS_URL")
    if not url:
        pytest.skip("explicit disposable QUIRE_TEST_REDIS_URL required")
    parsed = urlparse(url)
    if (parsed.scheme not in {"redis", "rediss"}
            or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed.path != "/15"):
        pytest.fail("Redis tests require a disposable loopback server, database 15")
    prefix = "quire:test:rl:v1:" + uuid4().hex
    monkeypatch.setattr(settings, "REDIS_ENABLED", True)
    monkeypatch.setattr(settings, "REDIS_MAX_CONNECTIONS", 100)
    monkeypatch.setattr(settings, "REDIS_URL", SecretStr(url))
    monkeypatch.setattr(settings, "REDIS_KEY_PREFIX", prefix)
    monkeypatch.setattr(settings, "REDIS_HMAC_SECRET", SecretStr(SECRET))
    return url, prefix


@asynccontextmanager
async def running_backend():
    backend = RedisLimits()
    await backend.start()
    try:
        yield backend
    finally:
        # Test account needs SCAN permission; application account does not.
        async for key in backend.client.scan_iter(match="{" + settings.REDIS_KEY_PREFIX + "}:*"):
            await backend.client.delete(key)
        await backend.close()


async def status(awaitable):
    try:
        await awaitable
        return 200
    except HTTPException as exc:
        assert exc.headers["Retry-After"]
        return exc.status_code


def test_two_clients_atomic_shared_budget_and_no_fixed_window_burst(redis_config):
    async def scenario():
        async with running_backend() as first:
            second = RedisLimits()
            await second.start()
            try:
                results = await asyncio.gather(*[
                    status((first if i % 2 else second).run(
                        "consume", "api-ip", "one", 7, 60, 4096,
                    ))
                    for i in range(40)
                ])
                assert results.count(200) == 7
                assert results.count(429) == 33
            finally:
                await second.close()
    asyncio.run(scenario())


def test_exact_window_expiry_retry_after_and_ttl(redis_config):
    async def scenario():
        async with running_backend() as backend:
            await backend.run("consume", "api-ip", "one", 1, 0.1, 4096)
            keys, _ = backend.keys("api-ip", "one")
            assert 0 < await backend.client.pttl(keys[1]) <= 100
            assert await status(backend.run("consume", "api-ip", "one", 1, 0.1, 4096)) == 429
            await asyncio.sleep(0.15)
            assert await backend.client.exists(keys[1]) == 0
            await backend.run("consume", "api-ip", "one", 1, 0.1, 4096)
    asyncio.run(scenario())


def test_capacity_rejects_new_buckets_without_evicting_live_limits(redis_config):
    async def scenario():
        async with running_backend() as backend:
            await backend.run("consume", "api-ip", "one", 1, 60, 1)
            assert await status(backend.run("consume", "api-ip", "two", 1, 60, 1)) == 429
            assert await status(backend.run("consume", "api-ip", "one", 1, 60, 1)) == 429
            keys, _ = backend.keys("api-ip", "one")
            assert await backend.client.zcard(keys[0]) == 1
    asyncio.run(scenario())


def test_login_lock_success_cas_and_no_stale_success_clear(redis_config):
    async def scenario():
        async with running_backend() as backend:
            async def run(op, key="one", expected=""):
                return await backend.run(op, "login-fail", key, 2, 0.2, 10000, expected)
            snapshot = await run("check")
            await run("fail")
            await run("clear", expected=snapshot)
            revision = await run("check")
            assert revision != snapshot
            await run("fail")
            assert await status(run("check")) == 429
            await run("clear", expected=revision)
            assert await status(run("check")) == 429
            await asyncio.sleep(0.25)
            assert await run("check") == ""
            await run("fail")
            latest = await run("check")
            await run("clear", expected=latest)
            assert await run("check") == ""
    asyncio.run(scenario())


def test_login_window_prunes_and_capacity_recovers(redis_config):
    async def scenario():
        async with running_backend() as backend:
            await backend.run("fail", "login-fail", "one", 3, 0.1, 1)
            assert await status(backend.run("fail", "login-fail", "two", 3, 0.1, 1)) == 429
            await asyncio.sleep(0.15)
            await backend.run("fail", "login-fail", "two", 3, 0.1, 1)
            keys, _ = backend.keys("login-fail", "two")
            assert await backend.client.zcard(keys[0]) == 1
    asyncio.run(scenario())


def test_api_client_restart_does_not_reset_budget(redis_config):
    async def scenario():
        async with running_backend() as backend:
            await backend.run("consume", "register-global", "all", 1, 86400, 4096)
            await backend.close()
            await backend.start()
            result = await status(backend.run(
                "consume", "register-global", "all", 1, 86400, 4096,
            ))
            assert result == 429
    asyncio.run(scenario())


def test_wrongtype_fails_503_and_never_falls_back(redis_config):
    async def scenario():
        async with running_backend() as backend:
            keys, _ = backend.keys("api-ip", "one")
            await backend.client.set(keys[1], "wrongtype", ex=60)
            assert await status(backend.run("consume", "api-ip", "one", 1, 60, 4096)) == 503
            await backend.client.delete(keys[1])
            assert await status(backend.run("consume", "api-ip", "one", 1, 60, 4096)) == 200
    asyncio.run(scenario())


def test_runtime_backend_failure_is_real_asgi_503_and_health_accessible(redis_config, monkeypatch):
    from fastapi.testclient import TestClient

    from app.core.redis_limits import redis_limits
    from app.main import app

    with TestClient(app, raise_server_exceptions=False) as client:
        original_script = redis_limits.script

        async def broken(**kwargs):
            raise ConnectionError("private connection details must not escape")

        monkeypatch.setattr(redis_limits, "script", broken)
        for path in ("/api/v1/auth/register", "/api/v1/auth/login", "/api/v1/sync/push"):
            response = client.post(path, content=b"not-json")
            assert response.status_code == 503
            assert response.json()["code"] == 503
            assert response.headers["retry-after"] == "3"
            assert "private connection" not in response.text
        response = client.get("/api/v1/health")
        assert response.status_code == 200  # Existing health response contract retained.
        assert response.json()["redis"] is False
        assert "redis_error" not in response.json()
        monkeypatch.setattr(redis_limits, "script", original_script)
        # No database access needed for a missing endpoint; limiter recovers first.
        assert client.get("/api/v1/missing-redis-test-route").status_code == 404


def test_startup_acl_failure_is_not_ready(monkeypatch):
    from app.core import redis_limits as module

    class Broken:
        def register_script(self, script):
            async def denied(**kwargs):
                raise RuntimeError("NOPERM private auth data")
            return denied

        async def aclose(self):
            pass

    monkeypatch.setattr(settings, "REDIS_ENABLED", True)
    monkeypatch.setattr(settings, "REDIS_HMAC_SECRET", SecretStr(SECRET))
    import redis.asyncio

    monkeypatch.setattr(redis.asyncio, "from_url", lambda *args, **kwargs: Broken())
    backend = module.RedisLimits()
    with pytest.raises(RuntimeError, match="startup check failed") as caught:
        asyncio.run(backend.start())
    assert "private auth data" not in str(caught.value)
    assert backend.client is None


def _process_budget(url, prefix, queue):
    # Separate OS process and connection pool, same shared Redis namespace.
    settings.REDIS_ENABLED = True
    settings.REDIS_URL = SecretStr(url)
    settings.REDIS_KEY_PREFIX = prefix
    settings.REDIS_HMAC_SECRET = SecretStr(SECRET)

    async def scenario():
        backend = RedisLimits()
        await backend.start()
        try:
            return [await status(backend.run("consume", "api-ip", "process", 7, 60, 4096))
                    for _ in range(20)]
        finally:
            await backend.close()
    try:
        queue.put(SimpleNamespace(results=asyncio.run(scenario()), error=False))
    except Exception:
        queue.put(SimpleNamespace(results=[], error=True))


def test_two_os_processes_share_exact_limit(redis_config):
    url, prefix = redis_config
    context = multiprocessing.get_context("spawn")
    queue = context.Queue()
    workers = [context.Process(target=_process_budget, args=(url, prefix, queue)) for _ in range(2)]
    try:
        for worker in workers:
            worker.start()
        result = [queue.get(timeout=30) for _ in workers]
        for worker in workers:
            worker.join(timeout=10)
            assert worker.exitcode == 0
        assert not any(item.error for item in result)
        assert sum(item.results.count(200) for item in result) == 7
        assert sum(item.results.count(429) for item in result) == 33
    finally:
        for worker in workers:
            if worker.is_alive():
                worker.terminate()
                worker.join(timeout=5)
        queue.close()

        async def cleanup():
            async with running_backend():
                pass
        asyncio.run(cleanup())
