import os

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

import pytest
from fastapi import HTTPException

from app.core.rate_limit import LoginRateLimiter


def test_login_rate_limit_locks_and_expires() -> None:
    limiter = LoginRateLimiter(max_failures=3, window_seconds=60)
    key = "127.0.0.1:person@example.com"

    limiter.fail(key, now=100)
    limiter.fail(key, now=101)
    limiter.check(key, now=102)
    limiter.fail(key, now=102)

    with pytest.raises(HTTPException) as captured:
        limiter.check(key, now=103)
    assert captured.value.status_code == 429
    assert captured.value.headers == {"Retry-After": "59"}

    limiter.check(key, now=163)
    limiter.fail(key, now=164)
    limiter.clear(key)
    limiter.check(key, now=164)
