import asyncio
import os
import uuid
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

from app.api.v1.checkins import get_month_checkins


def scalar_rows(*days: date) -> MagicMock:
    result = MagicMock()
    result.scalars.return_value = list(days)
    return result


def test_month_summary_never_exposes_future_checkins() -> None:
    today = date(2026, 9, 30)
    future = date(2026, 10, 1)
    db = SimpleNamespace(
        execute=AsyncMock(
            side_effect=[
                scalar_rows(today, future),
                scalar_rows(today),
            ]
        )
    )
    user = SimpleNamespace(
        id=uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456"),
        timezone="Asia/Shanghai",
    )
    now = datetime(2026, 9, 30, 4, 0, tzinfo=timezone.utc)

    response = asyncio.run(get_month_checkins(db, user, 2026, 9, now=now))

    assert response.today == today
    assert response.checkin_dates == [today]
    assert future not in response.checkin_dates
    month_query = str(db.execute.await_args_list[0].args[0])
    assert "checkins.checkin_date <=" in month_query
