"""Atomic P4 conversion with real SQLite transactions and simulated MySQL error paths."""

from contextlib import contextmanager
from copy import deepcopy
from datetime import date

import pytest
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from test_schedule_writes import (
    AT,
    DOC,
    ID,
    OTHER_USER_ID,
    USER_ID,
    api_client,
    mysql_error,
    stored,
)

from app.models.diary_entry import DiaryEntry
from app.models.schedule import Schedule

URL = f"/api/v1/schedules/{ID}/convert"


def request(**changes):
    body = {
        "expected_schedule_client_updated_at": "2026-10-08T10:00:00.123Z",
        "entry": {
            "id": str(ID), "from_schedule_id": str(ID), "entry_date": "2026-10-09",
            "sort_order": 0, "title": "预简", "content": deepcopy(DOC),
            "client_updated_at": "2026-10-08T10:00:00.124Z", "deleted_at": None,
        },
    }
    body["entry"].update(changes)
    return body


def diary(**changes):
    values = {
        "id": ID, "user_id": USER_ID, "from_schedule_id": ID,
        "entry_date": date(2026, 10, 9), "sort_order": 0, "title": "既有日记",
        "content": deepcopy(DOC), "content_text": "正文", "mood": None, "weather": None,
        "client_updated_at": AT, "deleted_at": None, "created_at": AT, "updated_at": AT,
    }
    values.update(changes)
    return DiaryEntry(**values)


@contextmanager
def client_fixture(sources=(), entries=(), *, authenticated=True):
    with api_client(sources, authenticated=authenticated) as (client, db):
        db.session.execute(text("""
            CREATE TABLE diary_entries (
                id BLOB PRIMARY KEY, user_id BLOB NOT NULL, entry_date DATE NOT NULL,
                sort_order INTEGER NOT NULL, title VARCHAR(255), content JSON, content_text TEXT,
                mood VARCHAR(16), weather VARCHAR(16), from_schedule_id BLOB UNIQUE,
                client_updated_at DATETIME, deleted_at DATETIME,
                created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
            )
        """))
        db.session.execute(text("""
            CREATE TABLE entry_tags (
                entry_id BLOB NOT NULL, tag_id BLOB NOT NULL, PRIMARY KEY (entry_id, tag_id)
            )
        """))
        db.session.add_all(entries)
        db.session.commit()
        yield client, db


def converted(response):
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["code"] == 0 and result["message"] == "ok"
    assert result["data"]["confirmed"] is True
    return result["data"]


def rejected(response, reason):
    assert response.status_code == 409, response.text
    result = response.json()
    assert result["code"] == 409 and result["data"]["reason"] == reason
    assert result["data"]["confirmed"] is False
    return result["data"]


def test_conversion_creates_stable_text_entry_and_source_receipt_in_one_commit():
    with client_fixture([stored()]) as (client, db):
        data = converted(client.post(URL, json=request(content_text="伪造索引", sort_order=7)))
        assert data["created"] and data["entry_state"] == "active" and db.commits == 1
        assert data["entry"]["id"] == data["entry"]["from_schedule_id"] == str(ID)
        assert data["entry"]["content"] == DOC and data["entry"]["content_text"] == "正文"
        assert data["entry"]["tag_ids"] == [] and data["entry"]["mood"] is None
        assert data["entry"]["sort_order"] == 7
        source = db.session.get(Schedule, ID)
        entry = db.session.get(DiaryEntry, ID)
        assert source.status == 1 and source.converted_entry_id == entry.id
        assert source.converted_receipt["entry_date"] == data["first_entry_date"] == "2026-10-09"
        assert "content" not in source.converted_receipt and source.content == DOC


def test_identical_retry_does_not_rewrite_or_advance_any_resource():
    with client_fixture([stored()]) as (client, db):
        first = converted(client.post(URL, json=request()))
        second = converted(client.post(URL, json=request()))
        assert second["created"] is False and second["reason"] == "replayed" and db.commits == 1
        assert first["entry"] == second["entry"] and first["schedule"] == second["schedule"]


def test_other_device_same_business_with_other_clock_or_sort_is_equivalent():
    with client_fixture([stored()]) as (client, db):
        first = converted(client.post(URL, json=request()))
        second = converted(client.post(URL, json=request(
            sort_order=9, client_updated_at="2026-10-08T11:00:00.000Z",
        )))
        assert second["created"] is False and second["entry"] == first["entry"] and db.commits == 1


def test_retry_preserves_later_diary_text_date_images_metadata_and_tags():
    tag_id = "0198f2a1-4b3c-7000-8000-000000000099"
    with client_fixture([stored()]) as (client, db):
        converted(client.post(URL, json=request()))
        row = db.session.get(DiaryEntry, ID)
        row.title, row.entry_date, row.mood, row.weather = "后来编辑", date(2026, 10, 7), "好", "晴"
        row.content = {"schemaVersion": 1, "doc": {"type": "doc", "content": [
            {"type": "image", "attrs": {"src": "local://media/preserved"}},
        ]}}
        db.session.execute(text("INSERT INTO entry_tags VALUES (:entry_id, :tag_id)"), {
            "entry_id": ID.bytes, "tag_id": bytes.fromhex(tag_id.replace("-", "")),
        })
        db.session.commit()
        data = converted(client.post(URL, json=request()))
        assert data["entry"]["title"] == "后来编辑" and data["entry"]["entry_date"] == "2026-10-07"
        assert data["entry"]["mood"] == "好" and data["entry"]["tag_ids"] == [tag_id]
        assert data["entry"]["content"]["doc"]["content"][0]["type"] == "image"
        assert data["first_entry_date"] == "2026-10-09" and db.commits == 1


@pytest.mark.parametrize("purged", [False, True])
def test_retry_never_revives_deleted_or_physically_purged_diary(purged):
    with client_fixture([stored()]) as (client, db):
        converted(client.post(URL, json=request()))
        row = db.session.get(DiaryEntry, ID)
        if purged:
            db.session.delete(row)
        else:
            row.deleted_at = AT
        db.session.commit()
        data = converted(client.post(URL, json=request()))
        assert data["entry_state"] == ("purged" if purged else "deleted")
        assert (data["entry"] is None) == purged and db.commits == 1
        assert db.session.get(Schedule, ID).status == 1


def test_another_selected_date_or_source_revision_returns_explicit_intent_conflict():
    with client_fixture([stored()]) as (client, db):
        converted(client.post(URL, json=request()))
        data = rejected(client.post(URL, json=request(entry_date="2026-10-07")), "intent_conflict")
        assert data["first_entry_date"] == "2026-10-09" and db.commits == 1
        other = request()
        other["expected_schedule_client_updated_at"] = "2026-10-08T10:00:00.122Z"
        rejected(client.post(URL, json=other), "intent_conflict")


@pytest.mark.parametrize("source,reason", [
    (stored(deleted_at=AT), "source_deleted"),
    (stored(client_updated_at=AT.replace(microsecond=125000)), "source_revision"),
    (stored(content={"schemaVersion": 999, "doc": {"type": "doc"}}), "source_content"),
])
def test_pending_source_rejection_writes_no_entry_or_receipt(source, reason):
    with client_fixture([source]) as (client, db):
        rejected(client.post(URL, json=request()), reason)
        assert db.session.get(DiaryEntry, ID) is None and db.commits == 0
        assert db.session.get(Schedule, ID).converted_receipt is None


def test_valid_but_different_snapshot_cannot_substitute_new_text():
    with client_fixture([stored()]) as (client, db):
        rejected(client.post(URL, json=request(title="不能换原稿")), "source_snapshot")
        assert db.session.get(Schedule, ID).status == 0 and db.commits == 0


def test_active_conversion_revision_must_advance_source_but_restored_tombstone_can_equal():
    with client_fixture([stored()]) as (client, db):
        response = client.post(URL, json=request(client_updated_at=AT.isoformat()))
        rejected(response, "conversion_revision")
        data = converted(client.post(URL, json=request(
            title="", content=None, deleted_at=AT.isoformat(), client_updated_at=AT.isoformat(),
        )))
        assert data["entry_state"] == "deleted" and data["entry"]["content"] is None
        assert data["entry"]["title"] == "" and data["first_entry_deleted"] is True
        assert db.commits == 1


@pytest.mark.parametrize("entry", [diary(from_schedule_id=None), diary(user_id=OTHER_USER_ID)])
def test_primary_key_collision_is_409_not_overwrite_or_500(entry):
    with client_fixture([stored()], [entry]) as (client, db):
        data = rejected(client.post(URL, json=request()), "identity_conflict")
        assert db.session.get(Schedule, ID).status == 0 and db.commits == 0
        assert db.session.get(DiaryEntry, ID).title == "既有日记"
        if data["entry"] is not None:
            assert "user_id" not in data["entry"]


def test_global_source_link_unique_collision_does_not_leak_foreign_diary():
    other_id = "0198f2a1-4b3c-7000-8000-000000000002"
    foreign = diary(id=other_id, user_id=OTHER_USER_ID, title="外账号原文")
    with client_fixture([stored()], [foreign]) as (client, db):
        data = rejected(client.post(URL, json=request()), "identity_conflict")
        assert data["entry"] is None and "外账号原文" not in str(data)
        assert db.session.get(Schedule, ID).status == 0 and db.commits == 0


def test_existing_terminal_without_receipt_preserves_identity_but_never_blindly_confirms():
    source = stored(status=1, converted_entry_id=ID, converted_at=AT)
    with client_fixture([source]) as (client, db):
        data = rejected(client.post(URL, json=request()), "receipt_unknown")
        assert data["entry_state"] == "purged" and data["entry"] is None
        assert db.commits == 0 and db.session.get(Schedule, ID).status == 1


def test_body_can_use_other_natural_day_without_p3_or_server_today_override():
    with client_fixture([stored()]) as (client, _db):
        data = converted(client.post(URL, json=request(entry_date="2099-01-01")))
        assert data["entry"]["entry_date"] == "2099-01-01"


def test_not_found_and_other_account_sources_have_same_404_without_entry_access():
    with client_fixture([stored(user_id=OTHER_USER_ID)]) as (client, db):
        response = client.post(URL, json=request())
        assert response.status_code == 404 and response.json()["data"] is None and db.commits == 0


def test_conversion_requires_authentication():
    with client_fixture([stored()], authenticated=False) as (client, db):
        assert client.post(URL, json=request()).status_code == 401 and not db.statements


@pytest.mark.parametrize("changes", [
    {"id": "0198f2a1-4b3c-7000-8000-000000000002"}, {"from_schedule_id": str(OTHER_USER_ID)},
    {"entry_date": "2026-02-29"}, {"entry_date": "0999-01-01"}, {"sort_order": True},
    {"sort_order": 2147483648}, {"mood": "好"}, {"tag_ids": [str(ID)]},
    {"content": {"schemaVersion": 1, "doc": {"type": "doc", "content": [{"type": "image"}]}}},
    {"title": "", "content": None}, {"client_updated_at": "2026-10-08T10:00:00.123456Z"},
    {"deleted_at": "2026-10-08T11:00:00.123Z"}, {"user_id": str(OTHER_USER_ID)},
])
def test_invalid_snapshot_or_identity_is_422_before_transaction(changes):
    with client_fixture([stored()]) as (client, db):
        response = client.post(URL, json=request(**changes))
        assert response.status_code == 422, response.text
        assert not db.statements and db.commits == db.flushes == 0


@pytest.mark.parametrize("operation", ["flush", "commit"])
def test_transaction_failure_rolls_back_both_entry_and_terminal_source(operation):
    with client_fixture([stored()]) as (client, db):
        async def fail():
            raise RuntimeError("private SQL details")

        setattr(db, operation, fail)
        response = client.post(URL, json=request())
        assert response.status_code == 500 and "private SQL" not in response.text
        source = db.session.get(Schedule, ID)
        assert source.status == 0 and source.converted_receipt is None
        assert db.session.get(DiaryEntry, ID) is None and db.commits == 0


@pytest.mark.parametrize("code", [1205, 1213])
def test_mysql_conversion_lock_error_is_409_with_no_success_confirmation(code):
    with client_fixture([stored()]) as (client, db):
        async def fail(statement):
            raise OperationalError("private SQL", {}, mysql_error(code))

        db.execute = fail
        response = client.post(URL, json=request())
        assert response.status_code == 409 and "private SQL" not in response.text
        assert db.commits == 0
