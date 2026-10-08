import os
import uuid
from contextlib import contextmanager
from datetime import date
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

from fastapi.testclient import TestClient

from app.core.security import get_current_user
from app.db.session import get_db
from app.main import app
from app.services.checkins import account_local_date

USER_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456")
USER = SimpleNamespace(id=USER_ID, timezone="Asia/Shanghai")


def scalar_rows(*days: date) -> MagicMock:
    result = MagicMock()
    result.scalars.return_value = list(days)
    return result


@contextmanager
def api_client():
    today = account_local_date(USER.timezone)
    db = SimpleNamespace(
        scalar=AsyncMock(return_value=SimpleNamespace(checkin_date=today)),
        add=MagicMock(),
        flush=AsyncMock(),
        execute=AsyncMock(return_value=scalar_rows(today)),
        commit=AsyncMock(),
        rollback=AsyncMock(),
    )
    previous = app.dependency_overrides.copy()

    async def override_db():
        yield db

    app.dependency_overrides[get_current_user] = lambda: USER
    app.dependency_overrides[get_db] = override_db
    try:
        yield TestClient(app, raise_server_exceptions=False)
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)


def test_today_route_echoes_valid_idempotency_key() -> None:
    key = "0198f2a1-4b3c-7000-8000-abcdef123499"

    with api_client() as client:
        response = client.post(
            "/api/v1/checkins/today",
            headers={"X-Idempotency-Key": key},
        )

    assert response.status_code == 200
    assert response.headers["X-Idempotency-Key"] == key
    assert response.json()["data"]["created"] is False


def test_today_route_rejects_malformed_idempotency_key() -> None:
    with api_client() as client:
        response = client.post(
            "/api/v1/checkins/today",
            headers={"X-Idempotency-Key": "not-a-uuid"},
        )

    assert response.status_code == 422
    assert response.json()["code"] == 422
    assert response.json()["message"] == "参数校验失败"
