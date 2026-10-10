"""P4 changes: real SQLite query tests, lock SQL checks, and logical clock regressions."""

import asyncio
import uuid
from datetime import timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy.dialects import mysql
from sqlalchemy.exc import OperationalError
from test_schedule_writes import (
    AT,
    ID,
    OTHER_USER_ID,
    USER_ID,
    api_client,
    fake_db,
    mysql_error,
    payload,
    stored,
)

from app.models.schedule import Schedule
from app.services import schedules as schedule_service
from app.services.schedules import ScheduleWriteOwner, latest_schedule_revision, lock_schedule_owner

URL = "/api/v1/schedules/sync/changes"


def resource_id(serial):
    return uuid.UUID(int=ID.int + serial)


def utc(value):
    return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def changes(client, **params):
    response = client.get(URL, params=params)
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"code", "message", "data"} and body["code"] == 0
    return body["data"]


def next_page(client, page, limit):
    return changes(client, since=page["server_time"], after_id=page["cursor_id"],
                   until=page["sync_until"], limit=limit)


def test_full_pull_is_owner_scoped_sorted_and_includes_terminal_and_tombstones():
    fixtures = [
        stored(id=resource_id(2), status=1, converted_entry_id=resource_id(2), converted_at=AT),
        stored(id=resource_id(1), deleted_at=AT), stored(),
        stored(id=resource_id(3), user_id=OTHER_USER_ID, title="外账号",
               updated_at=AT + timedelta(days=9)),
    ]
    with api_client(fixtures) as (client, db):
        data = changes(client)
        assert [item["id"] for item in data["schedules"]] == [str(resource_id(i)) for i in range(3)]
        assert data["schedules"][1]["deleted_at"] is not None
        assert data["schedules"][2]["status"] == "converted"
        assert data["sync_until"] == data["server_time"] == utc(AT)
        assert not data["has_more"] and data["cursor_id"] is None and db.commits == 0
        assert "外账号" not in str(data) and "user_id" not in str(data)


def test_same_millisecond_uuid_pages_cover_every_item_once_with_fixed_window():
    fixtures = [stored(id=resource_id(i)) for i in [5, 1, 4, 0, 3, 2]]
    with api_client(fixtures) as (client, _db):
        page = changes(client, limit=2)
        window, ids = page["sync_until"], []
        while True:
            ids.extend(item["id"] for item in page["schedules"])
            assert page["sync_until"] == window
            if not page["has_more"]:
                break
            assert page["cursor_id"] == page["schedules"][-1]["id"]
            page = next_page(client, page, 2)
        assert ids == [str(resource_id(i)) for i in range(6)]
        assert page["cursor_id"] is None and page["server_time"] == window


def test_timestamp_transition_and_offset_cursor_preserve_inclusive_restart_boundary():
    later = AT + timedelta(milliseconds=1)
    fixtures = [stored(), stored(id=resource_id(1)), stored(id=resource_id(2), updated_at=later)]
    with api_client(fixtures) as (client, _db):
        first = changes(client, limit=1)
        since = AT.replace(tzinfo=timezone.utc).astimezone(timezone(timedelta(hours=8))).isoformat()
        second = changes(client, since=since, after_id=first["cursor_id"],
                         until=first["sync_until"], limit=2)
        assert [row["id"] for row in second["schedules"]] == [str(resource_id(i)) for i in (1, 2)]
        restart = changes(client, since=utc(AT))
        assert len(restart["schedules"]) == 3


def test_explicit_older_window_does_not_leak_newer_records():
    fixtures = [stored(), stored(id=resource_id(1), updated_at=AT + timedelta(milliseconds=1))]
    with api_client(fixtures) as (client, _db):
        data = changes(client, until=utc(AT))
        assert [row["id"] for row in data["schedules"]] == [str(ID)]
        assert data["sync_until"] == utc(AT) and data["has_more"] is False


def test_new_commit_between_pages_is_above_old_window_and_appears_in_next_round():
    with api_client([stored(), stored(id=resource_id(1))]) as (client, db):
        first = changes(client, limit=1)
        written = client.put(f"/api/v1/schedules/{resource_id(2)}", json=payload())
        assert written.status_code == 200, written.text
        second = next_page(client, first, 1)
        assert [row["id"] for row in second["schedules"]] == [str(resource_id(1))]
        assert second["sync_until"] == first["sync_until"] and second["has_more"] is False
        new = changes(client, since=second["server_time"])
        assert str(resource_id(2)) in [row["id"] for row in new["schedules"]] and db.commits == 1


def test_edit_or_delete_between_pages_is_not_a_historical_snapshot_but_is_not_lost():
    with api_client([stored(), stored(id=resource_id(1))]) as (client, _db):
        first = changes(client, limit=1)
        response = client.put(f"/api/v1/schedules/{resource_id(1)}", json=payload(
            title="后来的修改", deleted_at="2026-10-08T10:00:00.124Z",
            client_updated_at="2026-10-08T10:00:00.124Z",
        ))
        assert response.status_code == 200, response.text
        end = next_page(client, first, 1)
        assert end["schedules"] == [] and end["server_time"] == first["sync_until"]
        next_round = changes(client, since=end["server_time"])
        source = next(row for row in next_round["schedules"] if row["id"] == str(resource_id(1)))
        assert source["title"] == "后来的修改" and source["deleted_at"] is not None


def test_empty_account_uses_floor_not_wall_clock_and_accepts_next_first_write():
    with api_client() as (client, db):
        empty = changes(client)
        assert empty["server_time"] == empty["sync_until"] == "1000-01-01T00:00:00Z"
        assert empty["schedules"] == [] and empty["cursor_id"] is None
        assert client.put(f"/api/v1/schedules/{ID}", json=payload()).status_code == 200
        data = changes(client, since=empty["server_time"])
        assert data["schedules"][0]["id"] == str(ID) and db.commits == 1


def test_future_or_restored_database_cursor_is_conflict_not_silent_advancement():
    with api_client([stored()]) as (client, db):
        for key in ["since", "until"]:
            response = client.get(URL, params={key: "2099-01-01T00:00:00Z"})
            assert response.status_code == 409 and response.json()["code"] == 409
        assert db.commits == 0


@pytest.mark.parametrize("params", [
    {"limit": 0}, {"limit": 501}, {"since": "bad"}, {"until": "bad"},
    {"after_id": str(ID)}, {"since": utc(AT), "after_id": str(ID)},
    {"after_id": "bad"}, {"since": utc(AT), "until": utc(AT), "after_id": str(uuid.uuid4())},
    {"since": "2026-10-08T10:00:00.123456Z"}, {"until": "0999-01-01T00:00:00Z"},
    {"since": "2026-10-08T10:00:00.124Z", "until": utc(AT)},
])
def test_invalid_cursor_and_limit_are_422_before_schedule_transactions(params):
    with api_client([stored()]) as (client, db):
        response = client.get(URL, params=params)
        assert response.status_code == 422, response.text
        assert not db.statements and db.commits == 0


def test_changes_requires_authentication():
    with api_client(authenticated=False) as (client, db):
        assert client.get(URL).status_code == 401 and not db.statements


def test_changes_does_not_mutate_rows_or_client_revisions():
    fixture = stored()
    with api_client([fixture]) as (client, db):
        before = db.session.get(Schedule, ID)
        original = (before.client_updated_at, before.updated_at, before.status, before.title)
        changes(client)
        after = db.session.get(Schedule, ID)
        assert original == (after.client_updated_at, after.updated_at, after.status, after.title)
        assert not db.session.dirty and db.commits == db.flushes == 0


def test_account_clock_advances_across_resources_even_when_wall_clock_goes_back(monkeypatch):
    head = AT + timedelta(milliseconds=500)
    with api_client([stored(updated_at=head)]) as (client, _db):
        initial = changes(client)
        monkeypatch.setattr(schedule_service, "utcnow", lambda: AT - timedelta(days=1))
        for serial in (1, 2):
            response = client.put(f"/api/v1/schedules/{resource_id(serial)}", json=payload())
            assert response.status_code == 200, response.text
            expected = head + timedelta(milliseconds=serial)
            assert response.json()["data"]["updated_at"] == expected.isoformat()
        data = changes(client, since=initial["server_time"])
        assert [row["id"] for row in data["schedules"]] == [str(resource_id(i)) for i in (0, 1, 2)]
        assert data["sync_until"] == utc(head + timedelta(milliseconds=2))


def test_my_sql_current_read_and_barrier_queries_are_owner_scoped_and_locking():
    db = fake_db()
    owner = ScheduleWriteOwner(USER_ID)
    asyncio.run(lock_schedule_owner(db, owner))
    asyncio.run(latest_schedule_revision(db, owner))
    sql = [str(call.args[0].compile(dialect=mysql.dialect()))
           for call in db.execute.await_args_list]
    assert "users.id =" in sql[0] and "FOR UPDATE" in sql[0]
    assert "schedules.user_id =" in sql[1] and "FOR UPDATE" in sql[1]
    assert "schedules.updated_at DESC" in sql[1] and "LIMIT" in sql[1]


@pytest.mark.parametrize("code", [1205, 1213])
def test_changes_lock_error_returns_retryable_conflict_without_sql_details(code):
    db = fake_db()
    db.execute.side_effect = OperationalError("private SQL", {}, mysql_error(code))
    with api_client(injected=db) as (client, _db):
        response = client.get(URL)
        assert response.status_code == 409 and "private SQL" not in response.text
        db.rollback.assert_awaited_once()


def test_missing_barrier_account_is_401_not_an_unserialized_read():
    db = fake_db()
    db.execute.return_value = SimpleNamespace(scalar_one_or_none=lambda: None)
    db.execute.side_effect = None
    with api_client(injected=db) as (client, _db):
        response = client.get(URL)
        assert response.status_code == 401
        db.scalar.assert_not_awaited()


def test_unknown_content_version_is_preserved_for_client_quarantine():
    unknown = {"schemaVersion": 999, "doc": {"type": "future", "extra": [1, 2]}}
    with api_client([stored(content=unknown)]) as (client, _db):
        assert changes(client)["schedules"][0]["content"] == unknown
