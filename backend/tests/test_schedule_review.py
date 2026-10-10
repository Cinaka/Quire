"""Review HTTP/SQLite cases; real MySQL locks need separate acceptance."""

import uuid
from copy import deepcopy

import pytest
from sqlalchemy.exc import OperationalError
from test_schedule_convert import client_fixture, converted, diary, request
from test_schedule_deletion import terminal
from test_schedule_writes import AT, ID, OTHER_USER_ID, api_client, mysql_error, stored, success

from app.models.diary_entry import DiaryEntry
from app.models.schedule import Schedule

URL = f"/api/v1/schedules/{ID}/review"
CONVERT = f"/api/v1/schedules/{ID}/convert"


def saved(row):
    return {column.name: deepcopy(getattr(row, column.name)) for column in row.__table__.columns}



def assert_review_private_fields(data):
    forbidden = {"confirmed", "created", "fingerprint", "converted_receipt", "user_id"}
    assert forbidden.isdisjoint(data)
    for name in ["schedule", "entry"]:
        resource = data.get(name)
        if resource is not None:
            assert isinstance(resource, dict)
            assert forbidden.isdisjoint(resource)


def test_privacy_assertion_allows_created_at_and_user_text():
    data = {
        "schedule": {"created_at": "2026-10-08T10:00:00Z", "title": "created user_id"},
        "entry": {
            "created_at": "2026-10-08T10:00:00Z", "title": "confirmed fingerprint",
            "content": {"doc": {"text": "converted_receipt created"}},
        },
    }
    assert_review_private_fields(data)


@pytest.mark.parametrize("level", ["root", "schedule", "entry"])
@pytest.mark.parametrize(
    "field", ["confirmed", "created", "fingerprint", "converted_receipt", "user_id"],
)
def test_privacy_assertion_rejects_actual_protocol_fields(level, field):
    data = {"schedule": {"created_at": "keep"}, "entry": {"created_at": "keep"}}
    target = data if level == "root" else data[level]
    target[field] = "must not expose"
    with pytest.raises(AssertionError):
        assert_review_private_fields(data)


def test_pending_get_does_not_convert_write_or_allocate_receipt():
    with api_client([stored()]) as (client, db):
        before = saved(db.session.get(Schedule, ID))
        data = success(client.get(URL))
        assert data["read_only"] and not data["reviewable"]
        assert data["reason"] == "not_terminal" and data["entry_state"] == "unknown"
        assert not data["receipt_known"] and data["entry"] is None
        assert saved(db.session.get(Schedule, ID)) == before
        assert db.commits == db.flushes == 0
        assert all("diary_entries" not in str(statement) for statement in db.statements)


def test_known_terminal_snapshot_is_repeatable_private_and_read_only():
    with client_fixture([stored()]) as (client, db):
        converted(client.post(CONVERT, json=request()))
        before = (
            saved(db.session.get(Schedule, ID)), saved(db.session.get(DiaryEntry, ID)),
            db.commits, db.flushes,
        )
        data = success(client.get(URL))
        assert data["read_only"] and data["reviewable"] and data["receipt_known"]
        assert data["reason"] == "terminal_review" and data["entry_state"] == "active"
        assert data["entry"]["id"] == data["entry"]["from_schedule_id"] == str(ID)
        assert_review_private_fields(data)
        assert "created_at" in data["schedule"] and "created_at" in data["entry"]
        assert success(client.get(URL)) == data
        assert (
            saved(db.session.get(Schedule, ID)), saved(db.session.get(DiaryEntry, ID)),
            db.commits, db.flushes,
        ) == before


@pytest.mark.parametrize("state", ["edited", "deleted", "purged"])
def test_current_diary_state_does_not_change_first_summary(state):
    with client_fixture([stored()]) as (client, db):
        converted(client.post(CONVERT, json=request()))
        row = db.session.get(DiaryEntry, ID)
        if state == "purged":
            db.session.delete(row)
        elif state == "deleted":
            row.deleted_at = AT
        else:
            row.title = "后来的文字"
            row.content = {"schemaVersion": 999, "doc": {"type": "doc", "content": []}}
        db.session.commit()
        before = db.commits, db.flushes
        data = success(client.get(URL))
        assert data["entry_state"] == {"edited": "active"}.get(state, state)
        assert data["first_entry_date"] == "2026-10-09" and not data["first_entry_deleted"]
        assert (data["entry"] is None) == (state == "purged")
        assert (db.commits, db.flushes) == before


@pytest.mark.parametrize("receipt", [None, {"version": 999, "private": "do not expose"}])
def test_unknown_receipt_does_not_guess_summary_or_rewrite_private_data(receipt):
    with client_fixture([terminal(converted_receipt=receipt)], [diary()]) as (client, db):
        before = saved(db.session.get(Schedule, ID))
        data = success(client.get(URL))
        assert data["reason"] == "receipt_unknown" and not data["reviewable"]
        assert not data["receipt_known"] and data["first_entry_date"] is None
        assert data["first_entry_deleted"] is None and "do not expose" not in str(data)
        assert saved(db.session.get(Schedule, ID)) == before
        assert db.commits == db.flushes == 0


@pytest.mark.parametrize("kind", ["wrong-link", "two-links", "source-id", "source-time"])
def test_inconsistent_identity_is_not_repaired_or_attached(kind):
    rows = [diary(from_schedule_id=OTHER_USER_ID)] if kind == "wrong-link" else [diary()]
    source = terminal()
    if kind == "two-links":
        rows = [diary(from_schedule_id=None), diary(id=OTHER_USER_ID)]
    if kind == "source-id":
        source.converted_entry_id = OTHER_USER_ID
    if kind == "source-time":
        source.converted_at = None
    with client_fixture([source], rows) as (client, db):
        data = success(client.get(URL))
        assert data["reason"] == "identity_conflict" and not data["reviewable"]
        assert data["entry_state"] == "unknown" and data["entry"] is None
        assert db.commits == db.flushes == 0


def test_foreign_diary_is_not_exposed():
    with client_fixture([terminal()], [diary(user_id=OTHER_USER_ID)]) as (client, db):
        data = success(client.get(URL))
        assert data["entry"] is None and data["entry_state"] == "purged"
        assert db.commits == db.flushes == 0


@pytest.mark.parametrize("foreign", [False, True])
def test_missing_or_foreign_source_is_404(foreign):
    with api_client([terminal(user_id=OTHER_USER_ID)] if foreign else []) as (client, db):
        response = client.get(URL)
        assert response.status_code == 404 and response.json()["data"] is None
        assert "user_id" not in response.text and db.commits == db.flushes == 0


def test_review_requires_authentication():
    with api_client([terminal()], authenticated=False) as (client, db):
        assert client.get(URL).status_code == 401
        assert db.commits == db.flushes == 0


@pytest.mark.parametrize("path_id", ["not-a-uuid", str(uuid.uuid4())])
def test_nonstable_path_ids_are_rejected_before_storage(path_id):
    with api_client() as (client, db):
        assert client.get(f"/api/v1/schedules/{path_id}/review").status_code == 422
        assert not db.statements and db.commits == db.flushes == 0


@pytest.mark.parametrize("code", [1205, 1213])
def test_lock_conflicts_release_transaction_without_sql_leak(code):
    with api_client([terminal()]) as (client, db):
        async def fail(statement):
            raise OperationalError("private SQL", {}, mysql_error(code))
        db.execute = fail
        response = client.get(URL)
        assert response.status_code == 409 and response.json()["data"] is None
        assert "private SQL" not in response.text
        assert db.rollbacks >= 1 and db.commits == db.flushes == 0
