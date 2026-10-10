"""P4 push tests reuse the pending-write SQLite fixture; no real MySQL acceptance."""

import asyncio
import uuid

import pytest
from sqlalchemy.exc import IntegrityError, OperationalError
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

from app.api.v1 import schedule_sync
from app.core.security import get_current_user
from app.main import app
from app.models.schedule import Schedule
from app.services.schedules import PendingScheduleRequest, upsert_schedule

URL = "/api/v1/schedules/sync/push"


def resource_id(serial):
    return uuid.UUID(int=ID.int + serial)


def item(serial=0, **changes):
    return {"id": str(resource_id(serial)), **payload(**changes)}


def push(client, items):
    response = client.post(URL, json={"schedules": items})
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"code", "message", "data"}
    assert body["code"] == 0 and body["message"] == "ok"
    return body["data"]


def test_mixed_results_preserve_input_order_and_only_commit_successful_items():
    fixtures = [
        stored(), stored(id=resource_id(1)), stored(id=resource_id(2)),
        stored(id=resource_id(4)),
        stored(id=resource_id(5), status=1, converted_entry_id=resource_id(5), converted_at=AT),
        stored(id=resource_id(6), user_id=OTHER_USER_ID, title="别的账号私密标题"),
    ]
    batch = [
        item(title="新版", client_updated_at="2026-10-08T10:00:00.124Z"), item(1),
        item(2, client_updated_at="2026-10-08T10:00:00.122Z"), item(3, status="converted"),
        item(4, title="同修订冲突"), item(5), item(6), item(7),
    ]
    with api_client(fixtures) as (client, db):
        data = push(client, batch)
        results = data["schedules"]
        assert data["interrupted"] is False
        assert [result["index"] for result in results] == list(range(8))
        assert [result["reason"] for result in results] == [
            "applied", "replayed", "stale", "invalid", "conflict", "terminal",
            "not_found", "applied",
        ]
        assert [result["status"] for result in results] == [
            "applied", "applied", "stale", "error", "error", "error", "error", "applied",
        ]
        assert results[2]["current"]["client_updated_at"] == AT.isoformat()
        assert results[4]["current"]["title"] == "预简"
        assert results[5]["current"]["status"] == "converted"
        assert results[6]["current"] is None
        assert results[7]["submitted_client_updated_at"] == AT.isoformat()
        assert db.commits == 2
        assert db.session.get(Schedule, resource_id(3)) is None
        assert db.session.get(Schedule, resource_id(6)).title == "别的账号私密标题"
        assert "别的账号" not in str(data) and "user_id" not in str(data)


def test_empty_batch_is_successful_and_does_not_start_a_schedule_transaction():
    with api_client() as (client, db):
        data = push(client, [])
        assert data["schedules"] == [] and data["interrupted"] is False
        assert "server_time" in data and db.commits == 0 and not db.statements


def test_exactly_fifty_items_are_independently_committed():
    with api_client() as (client, db):
        data = push(client, [item(i) for i in range(50)])
        assert len(data["schedules"]) == 50 and db.commits == 50
        assert all(result["status"] == "applied" for result in data["schedules"])


@pytest.mark.parametrize("body", [{}, {"schedules": "bad"},
                                 {"schedules": [None] * 51}, {"schedules": [], "entries": []}])
def test_invalid_outer_batch_is_422_before_schedule_reads(body):
    with api_client() as (client, db):
        response = client.post(URL, json=body)
        assert response.status_code == 422
        assert not db.statements and db.commits == 0


def test_push_requires_authentication():
    with api_client(authenticated=False) as (client, db):
        assert client.post(URL, json={"schedules": [item()]}).status_code == 401
        assert not db.statements and db.commits == 0


def test_malformed_item_does_not_reject_valid_neighbors_or_echo_raw_input():
    bad = [None, False, 7, "private-secret", [], {"id": "private-secret"},
           item(8, user_id=str(OTHER_USER_ID)), item(9, content={})]
    with api_client() as (client, db):
        data = push(client, [item(), *bad, item(10)])
        assert data["schedules"][0]["status"] == data["schedules"][-1]["status"] == "applied"
        assert all(result["reason"] == "invalid" for result in data["schedules"][1:-1])
        assert db.commits == 2 and "private-secret" not in str(data)
        assert all(result["submitted_client_updated_at"] is None
                   for result in data["schedules"][1:-1])


def test_same_id_replay_then_newer_snapshot_keep_exact_acknowledgment_snapshots():
    with api_client() as (client, db):
        data = push(client, [item(), item(), item(
            title="后来修改", client_updated_at="2026-10-08T10:00:00.124Z",
        )])
        results = data["schedules"]
        assert [result["reason"] for result in results] == ["applied", "replayed", "applied"]
        assert results[0]["current"]["title"] == results[1]["current"]["title"] == "预简"
        assert results[2]["current"]["title"] == "后来修改" and db.commits == 2
        assert results[0]["current"]["updated_at"] == results[1]["current"]["updated_at"]


def test_pending_tombstone_and_restore_use_separate_revision_results():
    with api_client() as (client, db):
        results = push(client, [
            item(deleted_at="2026-10-08T18:00:00.123+08:00"),
            item(client_updated_at="2026-10-08T10:00:00.124Z"),
        ])["schedules"]
        assert results[0]["current"]["deleted_at"] == AT.isoformat()
        assert results[1]["current"]["deleted_at"] is None and db.commits == 2


def test_commit_failure_only_rejects_that_item_and_preserves_prior_commit():
    with api_client() as (client, db):
        original_commit = db.commit
        attempts = 0

        async def commit():
            nonlocal attempts
            attempts += 1
            if attempts == 2:
                raise RuntimeError("private SQL statement")
            await original_commit()

        db.commit = commit
        data = push(client, [item(), item(1), item(2)])
        assert [result["status"] for result in data["schedules"]] == ["applied", "error", "applied"]
        assert data["schedules"][1]["current"] is None and data["interrupted"] is False
        assert db.session.get(Schedule, ID) is not None
        assert db.session.get(Schedule, resource_id(1)) is None
        assert db.session.get(Schedule, resource_id(2)) is not None
        assert "private SQL" not in str(data) and db.commits == 2


@pytest.mark.parametrize("code", [1205, 1213])
def test_mysql_retry_error_does_not_block_later_valid_item(monkeypatch, code):
    original = schedule_sync.upsert_schedule

    async def write(db, user, schedule_id, body):
        if schedule_id == ID:
            raise OperationalError("private SQL", {}, mysql_error(code))
        return await original(db, user, schedule_id, body)

    monkeypatch.setattr(schedule_sync, "upsert_schedule", write)
    with api_client() as (client, db):
        data = push(client, [item(), item(1)])
        assert [result["reason"] for result in data["schedules"]] == ["retry", "applied"]
        assert data["interrupted"] is False and db.commits == 1
        assert "private SQL" not in str(data)


def test_failed_rollback_stops_remaining_work_without_false_acknowledgments():
    with api_client([stored(id=resource_id(1))]) as (client, db):
        async def rollback():
            raise RuntimeError("connection unavailable")

        db.rollback = rollback
        data = push(client, [item(), item(1, title="同修订冲突"), item(2)])
        assert data["interrupted"] is True
        reasons = [result["reason"] for result in data["schedules"]]
        assert reasons == ["applied", "storage", "aborted"]
        assert data["schedules"][1]["current"] is None
        assert db.commits == 1 and db.session.get(Schedule, resource_id(2)) is None
        assert "connection unavailable" not in str(data)


class ExpiringOwner:
    def __init__(self):
        self.expired = False
        self.reads = 0

    @property
    def id(self):
        self.reads += 1
        if self.expired:
            raise RuntimeError("ORM owner was expired; must not reread")
        return USER_ID


def test_batch_pins_owner_before_commit_and_rollback_can_expire_auth_orm():
    with api_client([stored(id=resource_id(1))]) as (client, db):
        owner = ExpiringOwner()
        app.dependency_overrides[get_current_user] = lambda: owner
        original_commit, original_rollback = db.commit, db.rollback

        async def commit():
            await original_commit()
            owner.expired = True

        async def rollback():
            await original_rollback()
            owner.expired = True

        db.commit, db.rollback = commit, rollback
        data = push(client, [item(), item(1), item(2)])
        reasons = [result["reason"] for result in data["schedules"]]
        assert reasons == ["applied", "replayed", "applied"]
        assert owner.reads == 1 and db.commits == 2


def test_single_upsert_duplicate_retry_also_pins_orm_owner_before_rollback():
    owner = ExpiringOwner()
    db = fake_db(None, stored())
    db.flush.side_effect = IntegrityError("private SQL", {}, mysql_error(1062))

    async def rollback():
        owner.expired = True

    db.rollback = rollback
    _row, outcome = asyncio.run(upsert_schedule(
        db, owner, ID, PendingScheduleRequest(**payload()),
    ))
    assert outcome == "replayed" and owner.reads == 1


def test_static_sync_router_registered_before_uuid_detail_router():
    paths = [route.path for route in app.routes if hasattr(route, "path")]
    assert paths.index(URL) < paths.index("/api/v1/schedules/{schedule_id}")
