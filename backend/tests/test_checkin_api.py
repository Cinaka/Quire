import asyncio
import os
import uuid
from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

from sqlalchemy.exc import IntegrityError

from app.api.v1.checkins import checkin_today
from app.models.checkin import Checkin

USER_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456")
TODAY = date(2026, 9, 23)
NOW = datetime(2026, 9, 22, 16, 30, tzinfo=timezone.utc)


def scalar_rows(*days: date) -> MagicMock:
    result = MagicMock()
    result.scalars.return_value = list(days)
    return result


def test_checkin_today_creates_one_server_owned_record() -> None:
    db = SimpleNamespace(
        scalar=AsyncMock(return_value=None),
        add=MagicMock(),
        flush=AsyncMock(),
        execute=AsyncMock(return_value=scalar_rows(date(2026, 9, 22), TODAY)),
        commit=AsyncMock(),
        rollback=AsyncMock(),
    )
    user = SimpleNamespace(id=USER_ID, timezone="Asia/Shanghai")

    response = asyncio.run(checkin_today(db, user, now=NOW))

    assert response.checkin_date == TODAY
    assert response.checked_in is True
    assert response.created is True
    assert response.current_streak == 2
    row = db.add.call_args.args[0]
    assert isinstance(row, Checkin)
    assert row.user_id == USER_ID
    assert row.checkin_date == TODAY
    assert row.id.version == 7
    db.flush.assert_awaited_once()
    db.commit.assert_awaited_once()
    db.rollback.assert_not_awaited()


def test_checkin_today_replays_existing_record_without_writing() -> None:
    existing = Checkin(id=uuid.uuid4(), user_id=USER_ID, checkin_date=TODAY)
    db = SimpleNamespace(
        scalar=AsyncMock(return_value=existing),
        add=MagicMock(),
        flush=AsyncMock(),
        execute=AsyncMock(return_value=scalar_rows(TODAY)),
        commit=AsyncMock(),
        rollback=AsyncMock(),
    )
    user = SimpleNamespace(id=USER_ID, timezone="Asia/Shanghai")

    response = asyncio.run(checkin_today(db, user, now=NOW))

    assert response.created is False
    assert response.current_streak == 1
    db.add.assert_not_called()
    db.flush.assert_not_awaited()
    db.commit.assert_not_awaited()
    db.rollback.assert_not_awaited()


def test_checkin_today_treats_unique_race_as_idempotent_success() -> None:
    winner = Checkin(id=uuid.uuid4(), user_id=USER_ID, checkin_date=TODAY)
    duplicate = IntegrityError("INSERT", {}, RuntimeError("duplicate"))
    db = SimpleNamespace(
        scalar=AsyncMock(side_effect=[None, winner]),
        add=MagicMock(),
        flush=AsyncMock(side_effect=duplicate),
        execute=AsyncMock(return_value=scalar_rows(TODAY)),
        commit=AsyncMock(),
        rollback=AsyncMock(),
    )
    user = SimpleNamespace(id=USER_ID, timezone="Asia/Shanghai")

    response = asyncio.run(checkin_today(db, user, now=NOW))

    assert response.checked_in is True
    assert response.created is False
    assert response.current_streak == 1
    db.rollback.assert_awaited_once()
    db.commit.assert_not_awaited()


def test_checkin_today_reraises_non_duplicate_integrity_failure() -> None:
    failure = IntegrityError("INSERT", {}, RuntimeError("other integrity failure"))
    db = SimpleNamespace(
        scalar=AsyncMock(side_effect=[None, None]),
        add=MagicMock(),
        flush=AsyncMock(side_effect=failure),
        execute=AsyncMock(),
        commit=AsyncMock(),
        rollback=AsyncMock(),
    )
    user = SimpleNamespace(id=USER_ID, timezone="Asia/Shanghai")

    try:
        asyncio.run(checkin_today(db, user, now=NOW))
    except IntegrityError as exc:
        assert exc is failure
    else:
        raise AssertionError("IntegrityError should be reraised")

    db.rollback.assert_awaited_once()
    db.execute.assert_not_awaited()
