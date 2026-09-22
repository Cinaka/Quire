import asyncio
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

from app.api.v1.entries import EntryRequest, upsert_entry
from app.models.diary_entry import DiaryEntry

USER_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456")
ENTRY_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123457")
TAG_A = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123458")
TAG_B = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123459")
BASE_TIME = datetime(2026, 9, 22, 7, 0)


def request_at(
    when: datetime,
    *,
    title: str = "新版",
    deleted_at: datetime | None = None,
    tag_ids: list[uuid.UUID] | None = None,
) -> EntryRequest:
    return EntryRequest(
        entry_date=date(2026, 9, 22),
        sort_order=0,
        title=title,
        content={"schemaVersion": 1, "doc": {"type": "doc", "content": []}},
        content_text=title,
        mood=None,
        weather=None,
        tag_ids=tag_ids or [],
        from_schedule_id=None,
        client_updated_at=when,
        deleted_at=deleted_at,
    )


def fake_db(existing: DiaryEntry | None):
    return SimpleNamespace(
        scalar=AsyncMock(return_value=existing),
        add=MagicMock(),
        flush=AsyncMock(),
        execute=AsyncMock(),
        merge=AsyncMock(),
    )


def existing_entry() -> DiaryEntry:
    return DiaryEntry(
        id=ENTRY_ID,
        user_id=USER_ID,
        entry_date=date(2026, 9, 22),
        sort_order=0,
        title="旧版",
        content=None,
        content_text="旧版",
        mood=None,
        weather=None,
        from_schedule_id=None,
        client_updated_at=BASE_TIME,
        deleted_at=None,
    )


def test_equal_timestamp_is_an_idempotent_applied_replay() -> None:
    entry = existing_entry()
    db = fake_db(entry)
    user = SimpleNamespace(id=USER_ID)
    same_in_shanghai = BASE_TIME.replace(tzinfo=timezone.utc).astimezone(
        timezone(timedelta(hours=8))
    )

    returned, status = asyncio.run(
        upsert_entry(db, user, ENTRY_ID, request_at(same_in_shanghai, title="幂等重放"))
    )

    assert returned is entry
    assert status == "applied"
    assert entry.title == "幂等重放"
    assert entry.client_updated_at == BASE_TIME
    db.flush.assert_awaited_once()


def test_older_timestamp_is_rejected_without_mutation() -> None:
    entry = existing_entry()
    db = fake_db(entry)
    user = SimpleNamespace(id=USER_ID)

    returned, status = asyncio.run(
        upsert_entry(
            db,
            user,
            ENTRY_ID,
            request_at(BASE_TIME - timedelta(milliseconds=1), title="过期版本"),
        )
    )

    assert returned is entry
    assert status == "stale"
    assert entry.title == "旧版"
    assert entry.client_updated_at == BASE_TIME
    db.flush.assert_not_awaited()
    db.execute.assert_not_awaited()


def test_newer_tombstone_is_stored_as_utc_naive() -> None:
    entry = existing_entry()
    db = fake_db(entry)
    user = SimpleNamespace(id=USER_ID)
    client_time = datetime(2026, 9, 22, 15, 1, tzinfo=timezone(timedelta(hours=8)))
    deleted_time = datetime(2026, 9, 22, 15, 0, tzinfo=timezone(timedelta(hours=8)))

    returned, status = asyncio.run(
        upsert_entry(
            db,
            user,
            ENTRY_ID,
            request_at(client_time, title="", deleted_at=deleted_time),
        )
    )

    assert returned is entry
    assert status == "applied"
    assert entry.client_updated_at == datetime(2026, 9, 22, 7, 1)
    assert entry.deleted_at == datetime(2026, 9, 22, 7, 0)
    assert entry.title == ""


def test_new_entry_replaces_complete_tag_set() -> None:
    db = fake_db(None)
    user = SimpleNamespace(id=USER_ID)

    entry, status = asyncio.run(
        upsert_entry(
            db,
            user,
            ENTRY_ID,
            request_at(BASE_TIME, tag_ids=[TAG_A, TAG_B, TAG_A]),
        )
    )

    assert status == "applied"
    assert entry.id == ENTRY_ID
    assert entry.user_id == USER_ID
    db.add.assert_called_once_with(entry)
    db.execute.assert_awaited_once()
    merged = {call.args[0].tag_id for call in db.merge.await_args_list}
    assert merged == {TAG_A, TAG_B}
