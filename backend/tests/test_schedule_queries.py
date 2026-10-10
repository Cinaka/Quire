"""HTTP and real SQLite SELECT tests, not a MySQL migration/concurrency acceptance."""

import os
import uuid
from contextlib import contextmanager
from datetime import date, datetime
from types import SimpleNamespace

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.session import get_db
from app.main import app
from app.models.schedule import Schedule

USER_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456")
OTHER_USER_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123457")
AT = datetime(2026, 10, 8, 10, 0, 0, 123000)
DOC = {"schemaVersion": 1, "doc": {"type": "doc", "content": []}}


def identity(serial: int) -> uuid.UUID:
    return uuid.UUID(f"0198f2a1-4b3c-7000-8000-{serial:012x}")


def row(serial: int, **extra) -> Schedule:
    values = {
        "id": identity(serial), "user_id": USER_ID,
        "remind_date": date(2026, 10, 9), "title": "预简", "content": DOC,
        "content_text": "原文", "status": 0, "converted_entry_id": None,
        "converted_at": None, "client_updated_at": AT, "deleted_at": None,
        "created_at": AT, "updated_at": AT,
    }
    values.update(extra)
    return Schedule(**values)


class ReadSession:
    """Async API facade over actual SQLite SELECTs; has no write/commit methods."""

    def __init__(self, session: Session):
        self.session = session
        self.statements = []

    async def scalar(self, statement):
        self.statements.append(statement)
        return self.session.scalar(statement)

    async def execute(self, statement):
        self.statements.append(statement)
        return self.session.execute(statement)


@contextmanager
def api_client(rows=(), *, user_id=USER_ID, authenticated=True):
    # Test-only SQL: production MySQL DDL/defaults/migration remain unchanged.
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
        with Session(engine, expire_on_commit=False) as session:
            session.add_all(rows)
            session.commit()
            session.expunge_all()
            db = ReadSession(session)

            async def override_db():
                yield db

            app.dependency_overrides[get_db] = override_db
            if authenticated:
                app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=user_id)
            with TestClient(app, raise_server_exceptions=False) as client:
                yield client, db
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)
        engine.dispose()


def success(response):
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"code", "message", "data"}
    assert body["code"] == 0 and body["message"] == "ok"
    return body["data"]


def error(response, code):
    assert response.status_code == code, response.text
    body = response.json()
    assert set(body) == {"code", "message", "data"}
    assert body["code"] == code


def test_queries_require_authentication_before_schedule_reads():
    with api_client(authenticated=False) as (client, db):
        error(client.get("/api/v1/schedules"), 401)
        error(client.get(f"/api/v1/schedules/{identity(1)}"), 401)
        assert not db.statements


def test_list_defaults_live_owner_only_and_has_stable_date_id_order():
    fixtures = [row(3), row(1), row(2, remind_date=date(2026, 10, 8)),
                row(4, deleted_at=AT), row(5, user_id=OTHER_USER_ID)]
    with api_client(fixtures) as (client, db):
        data = success(client.get("/api/v1/schedules"))
        assert [item["id"] for item in data["items"]] == [str(identity(i)) for i in (2, 1, 3)]
        assert (data["total"], data["page"], data["page_size"]) == (3, 1, 20)
        assert len(db.statements) == 2
        assert all("user_id" not in item for item in data["items"])


@pytest.mark.parametrize("status", ["pending", "converted"])
def test_status_deleted_and_inclusive_date_filters_apply_to_items_and_total(status):
    terminal = {"status": 1, "converted_entry_id": identity(2), "converted_at": AT}
    fixtures = [row(1, deleted_at=AT), row(2, deleted_at=AT, **terminal),
                row(3, deleted_at=AT, remind_date=date(2026, 10, 10)), row(4),
                row(5, deleted_at=AT, user_id=OTHER_USER_ID)]
    with api_client(fixtures) as (client, _db):
        data = success(client.get("/api/v1/schedules", params={
            "status": status, "only_deleted": "true",
            "date_from": "2026-10-09", "date_to": "2026-10-09",
        }))
        assert data["total"] == 1
        assert len(data["items"]) == 1
        assert data["items"][0]["status"] == status
        assert data["items"][0]["deleted_at"] is not None


def test_pagination_and_out_of_range_page_do_not_change_filtered_total():
    with api_client([row(i) for i in (3, 2, 1)]) as (client, _db):
        first = success(client.get("/api/v1/schedules", params={"page_size": 2}))
        second = success(client.get("/api/v1/schedules", params={"page_size": 2, "page": 2}))
        empty = success(client.get("/api/v1/schedules", params={"page_size": 2, "page": 3}))
        assert [item["id"] for item in first["items"] + second["items"]] == [
            str(identity(i)) for i in (1, 2, 3)
        ]
        assert first["total"] == second["total"] == empty["total"] == 3
        assert empty["items"] == [] and empty["page"] == 3


def test_empty_list_is_a_successful_empty_page():
    with api_client() as (client, _db):
        assert success(client.get("/api/v1/schedules")) == {
            "items": [], "total": 0, "page": 1, "page_size": 20,
        }


def test_detail_preserves_terminal_deleted_identity_natural_day_and_exact_revision():
    fixture = row(1, status=1, converted_entry_id=identity(1), converted_at=AT,
                  deleted_at=AT, remind_date=date(2028, 2, 29))
    with api_client([fixture]) as (client, db):
        before = db.session.get(Schedule, identity(1))
        original = (before.status, before.client_updated_at, before.updated_at, before.deleted_at)
        data = success(client.get(f"/api/v1/schedules/{identity(1)}"))
        assert data["remind_date"] == "2028-02-29"
        assert data["status"] == "converted"
        assert data["converted_entry_id"] == str(identity(1))
        assert data["content"] == DOC and data["content_text"] == "原文"
        assert data["client_updated_at"] == AT.isoformat()
        assert data["deleted_at"] == data["converted_at"] == AT.isoformat()
        assert "user_id" not in data
        db.session.expire_all()
        after = db.session.get(Schedule, identity(1))
        restored = (after.status, after.client_updated_at, after.updated_at, after.deleted_at)
        assert restored == original
        assert not db.session.new and not db.session.dirty and not db.session.deleted


def test_foreign_and_missing_detail_are_indistinguishable_404():
    with api_client([row(1, user_id=OTHER_USER_ID)]) as (client, _db):
        foreign = client.get(f"/api/v1/schedules/{identity(1)}")
        missing = client.get(f"/api/v1/schedules/{identity(2)}")
        error(foreign, 404)
        error(missing, 404)
        assert foreign.json() == missing.json()


def test_same_data_is_visible_only_to_its_owner():
    with api_client([row(1), row(2, user_id=OTHER_USER_ID)], user_id=OTHER_USER_ID) as (client, _):
        data = success(client.get("/api/v1/schedules"))
        assert data["total"] == 1 and data["items"][0]["id"] == str(identity(2))
        error(client.get(f"/api/v1/schedules/{identity(1)}"), 404)


@pytest.mark.parametrize("params", [
    {"page": 0}, {"page_size": 0}, {"page_size": 101}, {"status": "due"},
    {"status": "0"}, {"date_from": "2026-02-29"}, {"date_to": "bad"},
    {"date_from": "2026-10-10", "date_to": "2026-10-09"}, {"only_deleted": "bad"},
])
def test_invalid_query_is_422_without_database_reads(params):
    with api_client() as (client, db):
        error(client.get("/api/v1/schedules", params=params), 422)
        assert not db.statements


def test_invalid_detail_uuid_is_422_without_database_reads():
    with api_client() as (client, db):
        error(client.get("/api/v1/schedules/not-a-uuid"), 422)
        assert not db.statements


def test_nullable_legacy_text_and_unknown_content_are_not_destructively_rewritten():
    unknown = {"schemaVersion": 999, "doc": {"type": "future", "private": [1, 2]}}
    with api_client([row(1, title=None, content_text=None, content=unknown)]) as (client, _db):
        data = success(client.get(f"/api/v1/schedules/{identity(1)}"))
        assert data["title"] == data["content_text"] == ""
        assert data["content"] == unknown


def test_write_and_conversion_routes_are_not_implemented_by_query_batch():
    with api_client() as (client, db):
        error(client.put(f"/api/v1/schedules/{identity(1)}", json={}), 405)
        error(client.post(f"/api/v1/schedules/{identity(1)}/convert", json={}), 404)
        error(client.post("/api/v1/schedules/sync/push", json={}), 404)
        assert not db.statements
