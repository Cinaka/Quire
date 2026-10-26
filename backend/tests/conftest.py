"""Each test receives fresh abuse budgets; production limits are never disabled."""

import os

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

import pytest

from app.api.v1 import auth, media
from app.core import abuse_middleware
from app.core.config import settings
from app.core.rate_limit import LoginRateLimiter
from app.core.request_limits import AttemptLimiter


@pytest.fixture(autouse=True)
def isolated_attempt_budgets(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_ENABLED", False)
    monkeypatch.setattr(auth, "login_rate_limiter", LoginRateLimiter())
    limiter = AttemptLimiter()
    monkeypatch.setattr(abuse_middleware, "attempt_limiter", limiter)
    monkeypatch.setattr(media, "attempt_limiter", limiter)
