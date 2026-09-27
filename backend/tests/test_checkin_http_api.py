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
def api_client(db=None, *, authenticated: bool = True):
    previous = app.dependency_overrides.copy()

    if authenticated:
        app.dependency_overrides[get_current_user] = lambda: USER
    if db is not None:
        async def override_db():
            yield db

        app.dependency_overrides[get_db] = override_db

    try:
        yield TestClient(app, raise_server_exceptions=False)
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)


def assert_error_envelope(response, status: int) -> None:
    assert response.status_code == status
    body = response.json()
    assert set(body) == {"code", "message", "data"}
    assert body["code"] == status
    assert body["data"] is None or isinstance(body["data"], list)


def test_checkin_routes_require_authentication() -> None:
    with api_client(authenticated=False) as client:
        assert_error_envelope(client.post("/api/v1/checkins/today"), 401)
        assert_error_envelope(client.get("/api/v1/checkins/month"), 401)


def test_month_route_rejects_partial_year_month_pair() -> None:
    with api_client() as client:
        year_only = client.get("/api/v1/checkins/month", params={"year": 2026})
        month_only = client.get("/api/v1/checkins/month", params={"month": 9})

    assert_error_envelope(year_only, 422)
    assert year_only.json()["message"] == "year 与 month 必须同时提供"
    assert_error_envelope(month_only, 422)
    assert month_only.json()["message"] == "year 与 month 必须同时提供"


def test_month_route_rejects_out_of_range_values() -> None:
    with api_client() as client:
        bad_month = client.get(
            "/api/v1/checkins/month",
            params={"year": 2026, "month": 13},
        )
        bad_year = client.get(
            "/api/v1/checkins/month",
            params={"year": 1969, "month": 12},
        )

    assert_error_envelope(bad_month, 422)
    assert_error_envelope(bad_year, 422)


def test_month_route_returns_success_envelope_and_statistics() -> None:
    today = account_local_date(USER.timezone)
    yesterday = date.fromordinal(today.toordinal() - 1)
    db = SimpleNamespace(
        execute=AsyncMock(
            side_effect=[
                scalar_rows(yesterday, today),
                scalar_rows(yesterday, today),
            ]
        )
    )

    with api_client(db) as client:
        response = client.get("/api/v1/checkins/month")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"code", "message", "data"}
    assert body["code"] == 0
    assert body["message"] == "ok"
    assert body["data"]["today"] == today.isoformat()
    assert body["data"]["checked_in_today"] is True
    assert body["data"]["current_streak"] == 2
    assert body["data"]["longest_streak"] == 2
    assert body["data"]["total_checkins"] == 2


def test_today_route_returns_idempotent_success_envelope() -> None:
    today = account_local_date(USER.timezone)
    existing = SimpleNamespace(user_id=USER_ID, checkin_date=today)
    db = SimpleNamespace(
        scalar=AsyncMock(return_value=existing),
        add=MagicMock(),
        flush=AsyncMock(),
        execute=AsyncMock(return_value=scalar_rows(today)),
        commit=AsyncMock(),
        rollback=AsyncMock(),
    )

    with api_client(db) as client:
        response = client.post("/api/v1/checkins/today")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"code", "message", "data"}
    assert body["code"] == 0
    assert body["data"] == {
        "checkin_date": today.isoformat(),
        "checked_in": True,
        "created": False,
        "current_streak": 1,
        "longest_streak": 1,
        "total_checkins": 1,
    }
    db.add.assert_not_called()
    db.commit.assert_not_awaited()
