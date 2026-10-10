"""P4 pending writes: actual SQLite transactions plus simulated MySQL error paths."""

import asyncio
import os
import uuid
from contextlib import contextmanager
from copy import deepcopy
from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.dialects import mysql
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.schedule import Schedule
from app.services.schedules import PendingScheduleRequest, locked_schedule, upsert_schedule

USER_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456")
OTHER_USER_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123457")
ID = uuid.UUID("0198f2a1-4b3c-7000-8000-000000000001")
AT = datetime(2026, 10, 8, 10, 0, 0, 123000)
DOC = {"schemaVersion": 1, "doc": {"type": "doc", "content": [
    {"type": "paragraph", "content": [{"type": "text", "text": "正文"}]},
]}}
URL = f"/api/v1/schedules/{ID}"


def payload(**changes):
    values = {"remind_date": "2026-10-09", "title": "预简", "content": deepcopy(DOC),
              "client_updated_at": "2026-10-08T10:00:00.123Z", "deleted_at": None}
    values.update(changes)
    return values


def stored(**changes):
    values = {"id": ID, "user_id": USER_ID, "remind_date": date(2026, 10, 9),
              "title": "预简", "content": deepcopy(DOC), "content_text": "正文", "status": 0,
              "converted_entry_id": None, "converted_at": None, "client_updated_at": AT,
              "deleted_at": None, "created_at": AT, "updated_at": AT}
    values.update(changes)
    return Schedule(**values)


class WriteSession:
    def __init__(self, session):
        self.session = session
        self.statements = []
        self.commits = self.rollbacks = self.flushes = 0

    async def scalar(self, statement):
        self.statements.append(statement)
        return self.session.scalar(statement)

    def add(self, row):
        self.session.add(row)

    async def flush(self):
        self.flushes += 1
        self.session.flush()

    async def commit(self):
        self.session.commit()
        self.commits += 1

    async def rollback(self):
        self.session.rollback()
        self.rollbacks += 1


@contextmanager
def api_client(rows=(), *, authenticated=True, injected=None):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    with engine.begin() as connection:
        connection.execute(text("""
            CREATE TABLE schedules (
                id BLOB PRIMARY KEY, user_id BLOB NOT NULL, remind_date DATE NOT NULL,
                title VARCHAR(255), content JSON, content_text TEXT, status INTEGER NOT NULL,
                converted_entry_id BLOB, converted_at DATETIME, client_updated_at DATETIME,
                deleted_at DATETIME, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
            )
        """))
    previous = app.dependency_overrides.copy()
    try:
        with Session(engine, expire_on_commit=True) as session:
            session.add_all(rows)
            session.commit()
            session.expunge_all()
            db = injected or WriteSession(session)

            async def override_db():
                yield db

            app.dependency_overrides[get_db] = override_db
            if authenticated:
                app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=USER_ID)
            with TestClient(app, raise_server_exceptions=False) as client:
                yield client, db
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)
        engine.dispose()


def success(response):
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"code", "message", "data"} and body["code"] == 0
    return body["data"]


def conflict(response, reason):
    assert response.status_code == 409, response.text
    body = response.json()
    assert body["code"] == 409 and body["data"]["reason"] == reason
    return body["data"]["current"]


def test_create_derives_text_and_keeps_date_client_uuid_and_server_timestamps():
    with api_client() as (client, db):
        data = success(client.put(URL, json=payload(content_text="伪造摘要")))
        assert data["id"] == str(ID) and data["remind_date"] == "2026-10-09"
        assert data["status"] == "pending" and data["converted_entry_id"] is None
        assert data["content"] == DOC and data["content_text"] == "正文"
        assert data["client_updated_at"] == AT.isoformat()
        assert data["created_at"] == data["updated_at"]
        assert "user_id" not in data and db.commits == 1
        assert db.session.get(Schedule, ID).user_id == USER_ID


def test_title_only_and_elapsed_first_upload_are_allowed_without_server_day_guess():
    with api_client() as (client, db):
        data = success(client.put(URL, json=payload(
            title="只有标题", content=None, remind_date="2020-01-01",
        )))
        assert data["content_text"] == "" and data["content"] is None
        assert data["remind_date"] == "2020-01-01" and db.commits == 1


def test_identical_replay_with_equivalent_utc_offset_does_not_write_or_bump_revision():
    with api_client([stored()]) as (client, db):
        data = success(client.put(URL, json=payload(
            client_updated_at="2026-10-08T18:00:00.123+08:00", content_text="无关摘要",
        )))
        assert data["updated_at"] == AT.isoformat()
        assert data["client_updated_at"] == AT.isoformat()
        assert db.commits == db.flushes == 0


@pytest.mark.parametrize("revision,reason", [
    ("2026-10-08T10:00:00.122Z", "stale"),
    ("2026-10-08T10:00:00.123Z", "conflict"),
])
def test_older_or_equal_different_snapshot_returns_current_without_overwrite(revision, reason):
    with api_client([stored()]) as (client, db):
        current = conflict(client.put(URL, json=payload(
            title="不能覆盖", client_updated_at=revision,
        )), reason)
        assert current["title"] == "预简" and current["content"] == DOC
        assert db.session.get(Schedule, ID).title == "预简"
        assert db.commits == db.flushes == 0


def test_newer_edit_reschedule_delete_and_restore_are_full_snapshot_revisions():
    with api_client([stored()]) as (client, db):
        edited = success(client.put(URL, json=payload(
            title="改期", remind_date="2026-10-01", client_updated_at="2026-10-08T10:00:00.124Z",
        )))
        deleted = success(client.put(URL, json=payload(
            title="改期", remind_date="2026-10-01", client_updated_at="2026-10-08T10:00:00.125Z",
            deleted_at="2026-10-08T18:00:00.125+08:00",
        )))
        restored = success(client.put(URL, json=payload(
            title="改期", remind_date="2026-10-01", client_updated_at="2026-10-08T10:00:00.126Z",
        )))
        assert edited["remind_date"] == "2026-10-01"
        assert deleted["deleted_at"] == "2026-10-08T10:00:00.125000"
        assert restored["deleted_at"] is None and restored["content"] == DOC
        assert AT.isoformat() == edited["created_at"] == restored["created_at"]
        assert edited["updated_at"] < deleted["updated_at"] < restored["updated_at"]
        assert db.commits == 3


def test_equal_revision_cannot_silently_restore_a_deleted_pending_source():
    with api_client([stored(deleted_at=AT)]) as (client, db):
        current = conflict(client.put(URL, json=payload()), "conflict")
        assert current["deleted_at"] == AT.isoformat()
        assert db.session.get(Schedule, ID).deleted_at == AT and db.commits == 0


def test_converted_source_cannot_be_changed_or_reset_by_newer_pending_snapshot():
    with api_client([stored(status=1, converted_entry_id=ID, converted_at=AT)]) as (client, db):
        current = conflict(client.put(URL, json=payload(
            title="不覆盖", client_updated_at="2026-10-08T11:00:00.123Z", deleted_at=AT.isoformat(),
        )), "terminal")
        assert current["status"] == "converted" and current["converted_entry_id"] == str(ID)
        row = db.session.get(Schedule, ID)
        assert row.title == "预简" and row.deleted_at is None and db.commits == 0


def test_foreign_id_collision_is_404_and_never_changes_other_owner():
    with api_client([stored(user_id=OTHER_USER_ID)]) as (client, db):
        response = client.put(URL, json=payload(title="越权"))
        assert response.status_code == 404 and response.json()["data"] is None
        assert "SQL" not in response.text and "user_id" not in response.text
        row = db.session.get(Schedule, ID)
        assert row.user_id == OTHER_USER_ID and row.title == "预简" and db.commits == 0


def test_write_requires_authentication_before_read_or_write():
    with api_client(authenticated=False) as (client, db):
        assert client.put(URL, json=payload()).status_code == 401
        assert not db.statements and db.commits == db.flushes == 0


@pytest.mark.parametrize("changes", [
    {"status": "converted"}, {"converted_entry_id": str(ID)}, {"converted_at": AT.isoformat()},
    {"user_id": str(OTHER_USER_ID)}, {"created_at": AT.isoformat()}, {"title": "x" * 256},
    {"remind_date": "2026-02-29"}, {"remind_date": 0}, {"remind_date": "2026-10-09T00:00:00Z"},
    {"client_updated_at": "2026-10-08"}, {"client_updated_at": 0},
    {"client_updated_at": "2026-10-08T10:00:00.123456Z"},
    {"deleted_at": "2026-10-08T10:00:00.123456Z"},
    {"title": "\ufeff ", "content": None}, {"content": {"schemaVersion": 2, "doc": {}}},
    {"content": {"schemaVersion": 1, "doc": {"type": "doc", "content": [{"type": "image"}]}}},
])
def test_invalid_or_forged_payload_is_422_without_database_access(changes):
    with api_client() as (client, db):
        response = client.put(URL, json=payload(**changes))
        assert response.status_code == 422, response.text
        assert not db.statements and db.flushes == db.commits == 0


@pytest.mark.parametrize("field", ["title", "content", "remind_date", "client_updated_at"])
def test_missing_full_snapshot_field_is_not_treated_as_partial_update(field):
    body = payload()
    del body[field]
    with api_client([stored()]) as (client, db):
        assert client.put(URL, json=body).status_code == 422
        assert not db.statements and db.commits == 0


def test_non_v7_uuid_is_rejected_before_database_access():
    with api_client() as (client, db):
        response = client.put(f"/api/v1/schedules/{uuid.uuid4()}", json=payload())
        assert response.status_code == 422 and not db.statements


def mysql_error(code):
    return Exception(code, "private SQL details must not be returned")


def fake_db(*rows):
    return SimpleNamespace(
        scalar=AsyncMock(side_effect=list(rows)), add=MagicMock(), flush=AsyncMock(),
        rollback=AsyncMock(), commit=AsyncMock(),
    )


def test_locked_read_is_owner_scoped_and_has_mysql_for_update():
    db = fake_db(stored())
    asyncio.run(locked_schedule(db, SimpleNamespace(id=USER_ID), ID))
    statement = db.scalar.await_args.args[0]
    sql = str(statement.compile(dialect=mysql.dialect()))
    assert "FOR UPDATE" in sql and "schedules.user_id =" in sql
    assert statement.get_execution_options()["populate_existing"] is True


@pytest.mark.parametrize("winner,expected", [(stored(), "replayed"), (None, "not_found")])
def test_duplicate_insert_rereads_locked_winner_after_rollback(winner, expected):
    db = fake_db(None, winner)
    db.flush.side_effect = IntegrityError("INSERT", {}, mysql_error(1062))
    result, outcome = asyncio.run(upsert_schedule(
        db, SimpleNamespace(id=USER_ID), ID, PendingScheduleRequest(**payload()),
    ))
    assert outcome == expected and result is winner
    db.rollback.assert_awaited_once()
    assert db.scalar.await_count == 2


def test_duplicate_winner_terminal_state_is_not_reset_to_pending():
    winner = stored(status=1, converted_entry_id=ID, converted_at=AT)
    db = fake_db(None, winner)
    db.flush.side_effect = IntegrityError("INSERT", {}, mysql_error(1062))
    _result, outcome = asyncio.run(upsert_schedule(
        db, SimpleNamespace(id=USER_ID), ID, PendingScheduleRequest(**payload()),
    ))
    assert outcome == "terminal" and winner.status == 1 and winner.converted_entry_id == ID


def test_failed_commit_rolls_back_without_claiming_success_or_exposing_sql():
    with api_client([stored()]) as (client, db):
        async def fail_commit():
            raise RuntimeError("private SQL details")

        db.commit = fail_commit
        response = client.put(URL, json=payload(
            title="事务失败", client_updated_at="2026-10-08T10:00:00.124Z",
        ))
        assert response.status_code == 500 and "private" not in response.text
        assert db.session.get(Schedule, ID).title == "预简" and db.rollbacks == 1


@pytest.mark.parametrize("code", [1205, 1213])
def test_mysql_lock_timeout_and_deadlock_return_retry_conflict_without_sql_details(code):
    db = fake_db()
    db.scalar.side_effect = OperationalError("SELECT private", {}, mysql_error(code))
    with api_client(injected=db) as (client, _db):
        response = client.put(URL, json=payload())
        assert conflict(response, "retry") is None and "private" not in response.text
        db.rollback.assert_awaited_once()
        db.commit.assert_not_awaited()


@pytest.mark.parametrize("boolean_change", [False, True])
def test_equal_revision_content_compares_json_types_but_ignores_object_key_order(boolean_change):
    original = deepcopy(DOC)
    original["doc"]["content"][0]["attrs"] = {"level": 1, "other": "保留"}
    incoming = deepcopy(original)
    incoming["doc"]["content"][0]["attrs"] = {
        "other": "保留", "level": True if boolean_change else 1,
    }
    with api_client([stored(content=original)]) as (client, db):
        response = client.put(URL, json=payload(content=incoming))
        if boolean_change:
            assert conflict(response, "conflict")["content"] == original
        else:
            assert success(response)["content"] == original
        assert db.commits == db.flushes == 0


def test_flush_failure_rolls_back_candidate_without_leaving_partial_record():
    with api_client() as (client, db):
        async def fail_flush():
            raise RuntimeError("private SQL details")

        db.flush = fail_flush
        response = client.put(URL, json=payload())
        assert response.status_code == 500 and "private" not in response.text
        assert db.session.get(Schedule, ID) is None and db.commits == 0


def test_non_duplicate_integrity_error_is_not_misreported_as_missing_owner():
    db = fake_db(None)
    db.flush.side_effect = IntegrityError("INSERT private", {}, mysql_error(3819))
    with api_client(injected=db) as (client, _db):
        response = client.put(URL, json=payload())
        assert response.status_code == 500 and "private" not in response.text
        assert db.scalar.await_count == 1
        db.commit.assert_not_awaited()
