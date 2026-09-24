import asyncio
import os
import uuid
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

from app.api.v1.checkins import get_month_checkins

USER_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456")
NOW = datetime(2026, 9, 22, 16, 30, tzinfo=timezone.utc)
TODAY = date(2026, 9, 23)


def scalar_rows(*days: date) -> MagicMock:
    result = MagicMock()
    result.scalars.return_value = list(days)
    return result


def test_month_summary_returns_sorted_dates_and_current_status() -> None:
    db = SimpleNamespace(
        execute=AsyncMock(
            side_effect=[
                scalar_rows(date(2026, 9, 1), date(2026, 9, 22), TODAY),
                scalar_rows(date(2026, 9, 21), date(2026, 9, 22), TODAY),
            ]
        )
    )
    user = SimpleNamespace(id=USER_ID, timezone="Asia/Shanghai")

    response = asyncio.run(get_month_checkins(db, user, 2026, 9, now=NOW))

    assert response.year == 2026
    assert response.month == 9
    assert response.checkin_dates == [date(2026, 9, 1), date(2026, 9, 22), TODAY]
    assert response.today == TODAY
    assert response.checked_in_today is True
    assert response.current_streak == 3


def test_current_month_defaults_to_account_timezone() -> None:
    db = SimpleNamespace(
        execute=AsyncMock(
            side_effect=[
                scalar_rows(TODAY),
                scalar_rows(date(2026, 9, 22), TODAY),
            ]
        )
    )
    user = SimpleNamespace(id=USER_ID, timezone="Asia/Shanghai")

    response = asyncio.run(get_month_checkins(db, user, None, None, now=NOW))

    assert response.year == 2026
    assert response.month == 9
    assert response.today == TODAY
    assert response.checked_in_today is True
    first_query = str(db.execute.await_args_list[0].args[0])
    assert "checkins.checkin_date >=" in first_query
    assert "checkins.checkin_date <" in first_query


def test_historical_month_keeps_today_status_independent() -> None:
    db = SimpleNamespace(
        execute=AsyncMock(
            side_effect=[
                scalar_rows(date(2026, 1, 3), date(2026, 1, 10)),
                scalar_rows(date(2026, 9, 21), date(2026, 9, 22)),
            ]
        )
    )
    user = SimpleNamespace(id=USER_ID, timezone="Asia/Shanghai")

    response = asyncio.run(get_month_checkins(db, user, 2026, 1, now=NOW))

    assert response.checkin_dates == [date(2026, 1, 3), date(2026, 1, 10)]
    assert response.today == TODAY
    assert response.checked_in_today is False
    assert response.current_streak == 2


def test_month_summary_queries_are_scoped_to_current_user() -> None:
    db = SimpleNamespace(
        execute=AsyncMock(side_effect=[scalar_rows(), scalar_rows()])
    )
    user = SimpleNamespace(id=USER_ID, timezone="Asia/Shanghai")

    asyncio.run(get_month_checkins(db, user, 2026, 9, now=NOW))

    queries = [str(call.args[0]) for call in db.execute.await_args_list]
    assert len(queries) == 2
    assert all("checkins.user_id" in query for query in queries)
