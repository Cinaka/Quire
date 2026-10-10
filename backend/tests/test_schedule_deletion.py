"""Terminal-source deletion: SQLite HTTP transactions, not real MySQL concurrency."""

import uuid
from copy import deepcopy
from datetime import timedelta

import pytest
from sqlalchemy.exc import OperationalError
from test_schedule_convert import client_fixture, converted, request
from test_schedule_writes import (
    AT,
    DOC,
    ID,
    OTHER_USER_ID,
    api_client,
    conflict,
    mysql_error,
    payload,
    stored,
    success,
)

from app.models.diary_entry import DiaryEntry
from app.models.schedule import Schedule
from app.services import schedules as schedule_service

URL = f"/api/v1/schedules/{ID}"
PUSH = "/api/v1/schedules/sync/push"
CHANGES = "/api/v1/schedules/sync/changes"
NEXT = AT + timedelta(milliseconds=1)
LAST = AT + timedelta(milliseconds=2)


def stamp(value):
    return value.isoformat() + "Z"


def deletion(**changes):
    body = {
        "status": "converted", "expected_schedule_client_updated_at": stamp(AT),
        "client_updated_at": stamp(NEXT), "deleted_at": stamp(NEXT),
    }
    body.update(changes)
    return body


def terminal(**changes):
    values = {"status": 1, "converted_entry_id": changes.get("id", ID), "converted_at": AT}
    values.update(changes)
    return stored(**values)


def snapshot(row):
    return {column.name: deepcopy(getattr(row, column.name)) for column in Schedule.__table__}


def batch(client, items):
    response = client.post(PUSH, json={"schedules": items})
    assert response.status_code == 200, response.text
    return response.json()["data"]


@pytest.mark.parametrize("receipt", [None, {"version": 999, "private": "preserve unknown"}])
def test_delete_and_restore_touch_only_deletion_and_revisions_even_without_known_receipt(receipt):
    with api_client([terminal(converted_receipt=receipt)]) as (client, db):
        original = snapshot(db.session.get(Schedule, ID))
        deleted = success(client.put(URL, json=deletion()))
        assert deleted["status"] == "converted" and deleted["deleted_at"] == NEXT.isoformat()
        assert deleted["converted_entry_id"] == str(ID) and "converted_receipt" not in deleted
        restored = success(client.put(URL, json=deletion(
            expected_schedule_client_updated_at=stamp(NEXT),
            client_updated_at=stamp(LAST), deleted_at=None,
        )))
        assert restored["status"] == "converted" and restored["deleted_at"] is None
        current = snapshot(db.session.get(Schedule, ID))
        for name in original.keys() - {"client_updated_at", "updated_at", "deleted_at"}:
            assert current[name] == original[name]
        assert current["client_updated_at"] == LAST and db.commits == 2
        assert db.flushes == 2 and current["updated_at"] > original["updated_at"]
        assert all("diary_entries" not in str(statement) for statement in db.statements)


def test_equal_deletion_and_restore_replays_do_not_flush_commit_or_advance_watermark():
    with api_client([terminal()]) as (client, db):
        removed = success(client.put(URL, json=deletion()))
        assert success(client.put(URL, json=deletion())) == removed
        restore = deletion(expected_schedule_client_updated_at=stamp(NEXT),
                           client_updated_at=stamp(LAST), deleted_at=None)
        restored = success(client.put(URL, json=restore))
        assert success(client.put(URL, json=restore)) == restored
        assert db.commits == db.flushes == 2


def test_equal_revision_different_deletion_and_stale_replay_cannot_undo_restore():
    with api_client([terminal()]) as (client, db):
        success(client.put(URL, json=deletion()))
        current = conflict(client.put(URL, json=deletion(deleted_at=None)), "conflict")
        assert current["deleted_at"] == NEXT.isoformat() and db.commits == 1
        success(client.put(URL, json=deletion(
            expected_schedule_client_updated_at=stamp(NEXT),
            client_updated_at=stamp(LAST), deleted_at=None,
        )))
        current = conflict(client.put(URL, json=deletion()), "stale")
        assert current["deleted_at"] is None and db.commits == 2


def test_newer_clock_with_stale_expected_revision_does_not_overwrite_competing_device():
    with api_client([terminal()]) as (client, db):
        success(client.put(URL, json=deletion()))
        conflict(client.put(URL, json=deletion(
            client_updated_at=stamp(LAST), deleted_at=None,
        )), "source_revision")
        assert db.session.get(Schedule, ID).deleted_at == NEXT and db.commits == 1


@pytest.mark.parametrize("row,reason", [
    (stored(), "not_terminal"),
    (stored(deleted_at=AT), "not_terminal"),
    (stored(status=1, converted_entry_id=OTHER_USER_ID, converted_at=AT), "invalid_state"),
    (stored(status=1, converted_entry_id=ID, converted_at=None), "invalid_state"),
])
def test_pending_and_inconsistent_terminal_cannot_be_converted_by_deletion(row, reason):
    with api_client([row]) as (client, db):
        original = snapshot(db.session.get(Schedule, ID))
        conflict(client.put(URL, json=deletion()), reason)
        assert snapshot(db.session.get(Schedule, ID)) == original
        assert db.commits == db.flushes == 0


@pytest.mark.parametrize("rows", [[], [terminal(user_id=OTHER_USER_ID, title="私密内容")]])
def test_missing_or_foreign_source_is_same_404_no_creation_or_leak(rows):
    with api_client(rows) as (client, db):
        response = client.put(URL, json=deletion())
        assert response.status_code == 404 and response.json()["data"] is None
        assert "私密" not in response.text and db.commits == db.flushes == 0


def test_deletion_requires_authentication():
    with api_client([terminal()], authenticated=False) as (client, db):
        assert client.put(URL, json=deletion()).status_code == 401
        assert not db.statements


@pytest.mark.parametrize("changes", [
    {"status": "pending"}, {"status": "bad"}, {"title": "伪造标题"}, {"content": DOC},
    {"remind_date": "2099-01-01"}, {"converted_entry_id": str(OTHER_USER_ID)},
    {"converted_at": stamp(AT)}, {"converted_receipt": {}}, {"user_id": str(OTHER_USER_ID)},
    {"expected_schedule_client_updated_at": "bad"}, {"client_updated_at": stamp(AT)},
    {"client_updated_at": "2026-10-08T10:00:00.124456Z"}, {"deleted_at": stamp(LAST)},
    {"deleted_at": 123}, {"expected_schedule_client_updated_at": "0999-01-01T00:00:00Z"},
])
def test_invalid_or_full_terminal_snapshot_is_rejected_before_schedule_locks(changes):
    with api_client([terminal()]) as (client, db):
        assert client.put(URL, json=deletion(**changes)).status_code == 422
        assert not db.statements and db.commits == db.flushes == 0


@pytest.mark.parametrize("missing", ["status", "expected_schedule_client_updated_at",
                                     "client_updated_at", "deleted_at"])
def test_restore_and_revision_fields_are_explicitly_required(missing):
    body = deletion()
    del body[missing]
    with api_client([terminal()]) as (client, db):
        assert client.put(URL, json=body).status_code == 422
        assert not db.statements


def test_invalid_path_uuid_v4_is_rejected_without_transaction():
    with api_client([terminal()]) as (client, db):
        response = client.put(f"/api/v1/schedules/{uuid.uuid4()}", json=deletion())
        assert response.status_code == 422 and not db.statements


def test_offset_times_normalize_for_delete_and_replay():
    body = deletion(
        expected_schedule_client_updated_at="2026-10-08T18:00:00.123+08:00",
        client_updated_at="2026-10-08T18:00:00.124+08:00",
        deleted_at="2026-10-08T18:00:00.124+08:00",
    )
    with api_client([terminal()]) as (client, db):
        assert success(client.put(URL, json=body))["deleted_at"] == NEXT.isoformat()
        success(client.put(URL, json=deletion()))
        assert db.commits == 1


@pytest.mark.parametrize("operation", ["flush", "commit"])
def test_failed_transaction_preserves_complete_source_and_never_acknowledges(operation):
    with api_client([terminal()]) as (client, db):
        original = snapshot(db.session.get(Schedule, ID))

        async def fail():
            raise RuntimeError("private SQL details")

        setattr(db, operation, fail)
        response = client.put(URL, json=deletion())
        assert response.status_code == 500 and "private SQL" not in response.text
        assert snapshot(db.session.get(Schedule, ID)) == original and db.commits == 0


@pytest.mark.parametrize("code", [1205, 1213])
def test_lock_retry_has_no_success_ack_or_current_snapshot(code):
    with api_client([terminal()]) as (client, db):
        async def fail(statement):
            raise OperationalError("private SQL", {}, mysql_error(code))

        db.execute = fail
        response = client.put(URL, json=deletion())
        assert response.status_code == 409 and response.json()["data"]["reason"] == "retry"
        assert response.json()["data"]["current"] is None and "private SQL" not in response.text
        assert db.commits == 0


def test_changes_and_lists_observe_delete_restore_without_unlocking_conversion(monkeypatch):
    head = AT + timedelta(days=5)
    second_id = uuid.UUID(int=ID.int + 1)
    with api_client([terminal(), stored(id=second_id, updated_at=head)]) as (client, db):
        monkeypatch.setattr(schedule_service, "utcnow", lambda: AT - timedelta(days=1))
        deleted = success(client.put(URL, json=deletion()))
        assert db.session.get(Schedule, ID).updated_at == head + timedelta(milliseconds=1)
        live = client.get("/api/v1/schedules", params={"status": "converted"}).json()["data"]
        assert live["total"] == 0
        trash = client.get("/api/v1/schedules", params={"only_deleted": True}).json()["data"]
        assert trash["items"][0]["id"] == str(ID)
        first = client.get(CHANGES, params={"since": stamp(head)}).json()["data"]
        assert any(row["id"] == str(ID) and row["deleted_at"] for row in first["schedules"])
        success(client.put(URL, json=deletion(
            expected_schedule_client_updated_at=stamp(NEXT),
            client_updated_at=stamp(LAST), deleted_at=None,
        )))
        second = client.get(CHANGES, params={"since": first["server_time"]}).json()["data"]
        source = next(row for row in second["schedules"] if row["id"] == str(ID))
        assert source["status"] == deleted["status"] == "converted"
        assert source["deleted_at"] is None and source["converted_entry_id"] == str(ID)
        assert db.session.get(Schedule, ID).updated_at > head + timedelta(milliseconds=1)
        conflict(client.put(URL, json=payload(client_updated_at=stamp(LAST))), "terminal")


@pytest.mark.parametrize("entry_state", ["active", "deleted", "purged"])
def test_source_delete_restore_never_mutates_diary_or_first_conversion_receipt(entry_state):
    with client_fixture([stored()]) as (client, db):
        first = converted(client.post(URL + "/convert", json=request()))
        source = db.session.get(Schedule, ID)
        receipt = deepcopy(source.converted_receipt)
        entry = db.session.get(DiaryEntry, ID)
        entry.title = "后续日记编辑"
        if entry_state == "purged":
            db.session.delete(entry)
        elif entry_state == "deleted":
            entry.deleted_at = LAST
        db.session.commit()
        removed = deletion(expected_schedule_client_updated_at=stamp(NEXT),
                           client_updated_at=stamp(LAST), deleted_at=stamp(LAST))
        success(client.put(URL, json=removed))
        restored = deletion(expected_schedule_client_updated_at=stamp(LAST),
                            client_updated_at=stamp(LAST + timedelta(milliseconds=1)),
                            deleted_at=None)
        success(client.put(URL, json=restored))
        replay = converted(client.post(URL + "/convert", json=request()))
        assert replay["entry_state"] == entry_state and replay["created"] is False
        assert replay["schedule"]["converted_at"] == first["schedule"]["converted_at"]
        assert db.session.get(Schedule, ID).converted_receipt == receipt
        if entry_state == "purged":
            assert db.session.get(DiaryEntry, ID) is None and replay["entry"] is None
        else:
            assert replay["entry"]["title"] == "后续日记编辑"


def test_mixed_batch_accepts_sparse_terminal_writes_and_retains_pending_protocol():
    second_id = uuid.UUID(int=ID.int + 1)
    foreign_id = uuid.UUID(int=ID.int + 2)
    with api_client([terminal(), terminal(id=foreign_id, user_id=OTHER_USER_ID)]) as (client, db):
        results = batch(client, [
            {"id": str(ID), **deletion()},
            {"id": str(second_id), **payload()},
            {"id": str(ID), **deletion()},
            {"id": str(ID), **deletion(title="不能改源正文")},
            {"id": str(foreign_id), **deletion()},
            {"id": str(ID), **deletion(expected_schedule_client_updated_at=stamp(NEXT),
                                       client_updated_at=stamp(LAST), deleted_at=None)},
        ])["schedules"]
        assert [row["index"] for row in results] == list(range(6))
        assert [row["reason"] for row in results] == [
            "applied", "applied", "replayed", "invalid", "not_found", "applied",
        ]
        assert results[0]["current"]["deleted_at"] == NEXT.isoformat()
        assert results[2]["current"]["deleted_at"] == NEXT.isoformat()
        assert results[5]["current"]["deleted_at"] is None and db.commits == 3
        assert results[4]["current"] is None and "user_id" not in str(results)
        assert db.session.get(Schedule, foreign_id).user_id == OTHER_USER_ID
        assert db.session.get(Schedule, second_id).status == 0


def test_terminal_batch_commit_failure_does_not_confirm_and_other_item_still_commits():
    second_id = uuid.UUID(int=ID.int + 1)
    with api_client([terminal()]) as (client, db):
        commit = db.commit
        attempts = 0

        async def fail_once():
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("private SQL")
            await commit()

        db.commit = fail_once
        data = batch(client, [{"id": str(ID), **deletion()},
                              {"id": str(second_id), **payload()}])
        assert [row["reason"] for row in data["schedules"]] == ["storage", "applied"]
        assert data["schedules"][0]["current"] is None and not data["interrupted"]
        assert db.session.get(Schedule, ID).deleted_at is None and db.commits == 1


def test_unknown_terminal_body_is_retained_verbatim_not_revalidated_or_downgraded():
    unknown = {"schemaVersion": 99, "private_body": {"future": "保留原文"}}
    with api_client([terminal(content=unknown, content_text="旧派生文本")]) as (client, db):
        success(client.put(URL, json=deletion()))
        current = db.session.get(Schedule, ID)
        assert current.content == unknown and current.content_text == "旧派生文本"
        assert current.status == 1 and current.converted_receipt is None


@pytest.mark.parametrize("changes,reason,status", [
    ({"client_updated_at": stamp(AT + timedelta(milliseconds=3))}, "source_revision", "error"),
    ({"deleted_at": None}, "conflict", "error"),
    ({"client_updated_at": stamp(NEXT)}, "stale", "stale"),
])
def test_terminal_batch_conflicts_do_not_acknowledge_revision(changes, reason, status):
    existing_revision = LAST if reason == "stale" else NEXT
    rows = [terminal(client_updated_at=existing_revision, deleted_at=NEXT)]
    with api_client(rows) as (client, db):
        data = batch(client, [{"id": str(ID), **deletion(**changes)}])
        result = data["schedules"][0]
        assert result["reason"] == reason and result["status"] == status
        assert result["current"]["client_updated_at"] == existing_revision.isoformat()
        assert result["current"]["deleted_at"] == NEXT.isoformat() and db.commits == 0
