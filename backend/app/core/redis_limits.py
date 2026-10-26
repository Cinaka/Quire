"""Redis-backed abuse state. No fallback after Redis is explicitly enabled."""

import asyncio
import hashlib
import hmac
import logging
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException

from app.core.config import settings

logger = logging.getLogger(__name__)
SCRIPT = Path(__file__).with_name("lua").joinpath("rate_limits.lua").read_text()


def unavailable() -> HTTPException:
    return HTTPException(503, "安全限流服务暂不可用，请稍后重试", headers={
        "Retry-After": "3", "Cache-Control": "private, no-store",
    })


class RedisLimits:
    def __init__(self):
        self.client = None
        self.script = None

    async def start(self):
        if not settings.REDIS_ENABLED:
            return
        try:
            import redis.asyncio as aioredis
            from redis.backoff import NoBackoff
            from redis.retry import Retry

            self.client = aioredis.from_url(
                settings.REDIS_URL.get_secret_value(),
                decode_responses=True,
                socket_connect_timeout=settings.REDIS_CONNECT_TIMEOUT,
                socket_timeout=settings.REDIS_SOCKET_TIMEOUT,
                max_connections=settings.REDIS_MAX_CONNECTIONS,
                retry=Retry(NoBackoff(), 0),
            )
            self.script = self.client.register_script(SCRIPT)
            # Prove request, login metadata and cleanup ACL permissions before readiness.
            await self.run("consume", "startup", uuid4().hex, 1, 1, 10000)
            probe = uuid4().hex
            await self.run("fail", "startup", probe, 10, 1, 10000)
            revision = await self.run("check", "startup", probe, 10, 1, 10000)
            await self.run("clear", "startup", probe, 10, 1, 10000, expected=revision)
        except Exception:
            await self.close()
            # Never include chained Redis URL/ACL exceptions in logs or startup traceback.
            raise RuntimeError("Redis safety backend startup check failed") from None

    async def close(self):
        client, self.client = self.client, None
        self.script = None
        if client is not None:
            try:
                await client.aclose()
            except Exception:
                logger.warning("Redis safety backend close failed")

    def keys(self, bucket: str, key: str):
        digest = hmac.new(
            settings.REDIS_HMAC_SECRET.get_secret_value().encode(),
            f"{bucket}\0{key}".encode(), hashlib.sha256,
        ).hexdigest()
        family = "login" if bucket == "login-fail" else "attempt"
        if bucket == "startup":
            family = "startup"
        base = "{" + settings.REDIS_KEY_PREFIX + "}:" + family
        ident = f"{bucket}:{digest}"
        return [base + ":registry", base + ":events:" + ident, base + ":meta:" + ident], ident

    async def run(self, op, bucket, key, limit, window, capacity, expected=""):
        if self.client is None or self.script is None:
            raise unavailable()
        keys, ident = self.keys(bucket, key)
        try:
            # Bound whole operation as well as each socket command. No automatic replay of writes.
            async with asyncio.timeout(
                settings.REDIS_CONNECT_TIMEOUT + settings.REDIS_SOCKET_TIMEOUT * 3,
            ):
                result = await self.script(
                    keys=keys,
                    args=[op, ident, limit, window * 1000, capacity, uuid4().hex, expected],
                )
            if (not isinstance(result, (list, tuple)) or len(result) != 3
                    or type(result[0]) is not int or result[0] not in {0, 1}
                    or type(result[1]) is not int or not isinstance(result[2], str)):
                raise ValueError("invalid safety backend response")
        except Exception:
            # OOM, ACL, network, pool exhaustion, malformed response: fail closed, no secrets.
            raise unavailable() from None
        if result[0] == 1:
            raise HTTPException(429, "请求过于频繁，请稍后重试", headers={
                "Retry-After": str(max(1, int(result[1]))),
                "Cache-Control": "private, no-store",
            })
        if result[0] != 0:
            raise unavailable()
        return result[2]

    async def healthy(self):
        if self.client is None:
            return False
        try:
            # Exercise write permissions and capacity, not just PING. One short-lived key per probe.
            await self.run("consume", "startup", uuid4().hex, 1, 1, 10000)
            return True
        except Exception:
            return False


redis_limits = RedisLimits()


async def consume_attempt(memory, bucket, key, limit, window):
    if not settings.REDIS_ENABLED:
        return memory.consume(bucket, key, limit, window)
    await redis_limits.run(
        "consume", bucket, key, limit, window, settings.REDIS_ATTEMPT_MAX_KEYS,
    )


async def check_login(memory, key):
    if not settings.REDIS_ENABLED:
        memory.check(key)
        return ""
    return await redis_limits.run(
        "check", "login-fail", key, memory.max_failures, memory.window_seconds,
        settings.REDIS_LOGIN_MAX_KEYS,
    )


async def fail_login(memory, key):
    if not settings.REDIS_ENABLED:
        return memory.fail(key)
    await redis_limits.run(
        "fail", "login-fail", key, memory.max_failures, memory.window_seconds,
        settings.REDIS_LOGIN_MAX_KEYS,
    )


async def clear_login(memory, key, revision):
    if not settings.REDIS_ENABLED:
        return memory.clear(key)
    await redis_limits.run(
        "clear", "login-fail", key, memory.max_failures, memory.window_seconds,
        settings.REDIS_LOGIN_MAX_KEYS, expected=revision,
    )
