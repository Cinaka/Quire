"""Actual HTTP/SQLite create-only tag publication; MySQL contention is separately simulated."""

import uuid
from contextlib import contextmanager
from copy import deepcopy
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError, OperationalError
from test_schedule_convert import diary
from test_schedule_resource_review import resource_fixture
from test_schedule_writes import AT, ID, OTHER_USER_ID, USER_ID, mysql_error, stored, success

from app.models.diary_entry import DiaryEntry
from app.models.entry_tag import EntryTag
from app.models.media import Media
from app.models.schedule import Schedule
from app.models.tag import Tag

URL = f"/api/v1/schedules/{ID}/independent-tags"
REVIEW = f"/api/v1/schedules/{ID}/review/resources"
PLAN = uuid.UUID("0198f2a1-4b3c-7000-8000-000000000071")
COPY = uuid.UUID("0198f2a1-4b3c-7000-8000-000000000072")
SECOND = uuid.UUID("0198f2a1-4b3c-7000-8000-000000000073")


@contextmanager
def fixture(tmp_path, monkeypatch, **options):
    with resource_fixture(tmp_path, monkeypatch, **options) as (client, db, path):
        db.session.execute(text("CREATE UNIQUE INDEX test_tag_name ON tags(user_id, name)"))
        db.session.commit()
        yield client, db, path


def request(client, **changes):
    body = {
        "plan_id": str(PLAN), "choice": "cloud-source-use-diary", "confirmed": True,
        "expected_resources": success(client.get(REVIEW)),
        "copies": [{"from_tag_id": str(ID), "id": str(COPY), "name": "明确的独立标签",
                    "color": "green"}],
    }
    body.update(changes)
    return body


def saved(row):
    return {column.name: deepcopy(getattr(row, column.name)) for column in row.__table__.columns}


def original_state(db):
    return (
        saved(db.session.get(Schedule, ID)), saved(db.session.get(DiaryEntry, ID)),
        saved(db.session.get(Tag, ID)), saved(db.session.get(Media, OTHER_USER_ID)),
        [(row.entry_id, row.tag_id) for row in db.session.scalars(select(EntryTag))],
    )


def test_create_then_retry_confirms_presence_without_updating_originals(tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        body, before = request(client), original_state(db)
        first = success(client.post(URL, json=body))
        assert first["tags_confirmed"] and not first["resolution_enabled"]
        assert not first["diary_sync_enabled"]
        assert first["proof_scope"] == "independent_tag_presence"
        assert first["plan_id"] == str(PLAN) and first["schedule_id"] == str(ID)
        assert first["tags"][0]["id"] == str(COPY) and first["tags"][0]["created"]
        assert original_state(db) == before and db.commits == db.flushes == 1
        created = saved(db.session.get(Tag, COPY))
        second = success(client.post(URL, json=body))
        assert second["tags_confirmed"] and not second["tags"][0]["created"]
        assert saved(db.session.get(Tag, COPY)) == created
        assert original_state(db) == before
        assert db.commits == db.flushes == 1
        assert client.post(URL, json=body).headers["Cache-Control"] == "no-store"


def test_keep_local_can_create_explicit_definitions_but_cannot_touch_diary(tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        body = request(client, choice="cloud-source-keep-diary")
        body["copies"][0].update(from_tag_id=str(SECOND), color="blue")
        before = original_state(db)
        assert success(client.post(URL, json=body))["tags_confirmed"]
        assert db.session.get(Tag, COPY).color == "blue" and original_state(db) == before


@pytest.mark.parametrize("kind", ["source", "entry", "tag", "file", "proof-field"])
def test_stale_proof_has_no_tag_write(kind, tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, path):
        body = request(client)
        if kind == "source":
            db.session.get(Schedule, ID).title = "changed"
        elif kind == "entry":
            db.session.get(DiaryEntry, ID).title = "changed"
        elif kind == "tag":
            db.session.get(Tag, ID).color = "red"
        elif kind == "file":
            path.write_bytes(b"different invalid image bytes")
        else:
            body["expected_resources"]["unexpected"] = True
        db.session.commit()
        assert client.post(URL, json=body).status_code == 409
        assert db.session.get(Tag, COPY) is None and db.commits == db.flushes == 0


@pytest.mark.parametrize("kind", ["name", "near-name", "own-id", "foreign-id", "schedule-id",
                                  "entry-id", "media-id", "cloud-mapping", "cloud-color"])
def test_collision_or_unsupported_mapping_never_overwrites(kind, tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        body = request(client)
        if kind in {"name", "near-name"}:
            db.session.add(Tag(id=SECOND, user_id=USER_ID, name="Café", color=None, created_at=AT))
            body["copies"][0]["name"] = "Café" if kind == "name" else "CAFE"
        elif kind in {"own-id", "foreign-id"}:
            db.session.add(Tag(id=COPY, user_id=USER_ID if kind == "own-id" else OTHER_USER_ID,
                               name="private keep", color=None, created_at=AT))
        elif kind == "schedule-id":
            db.session.add(stored(id=COPY))
        elif kind == "entry-id":
            db.session.add(diary(id=COPY, from_schedule_id=None))
        elif kind == "media-id":
            body["copies"][0]["id"] = str(OTHER_USER_ID)
        elif kind == "cloud-mapping":
            body["copies"][0]["from_tag_id"] = str(SECOND)
        else:
            body["copies"][0]["color"] = "red"
        db.session.commit()
        before = original_state(db)
        response = client.post(URL, json=body)
        assert response.status_code == 409 and response.headers["Cache-Control"] == "no-store"
        assert "private keep" not in response.text and original_state(db) == before
        assert db.commits == db.flushes == 0


@pytest.mark.parametrize("kind", ["confirmation", "numeric-confirmation", "extra", "copy-extra",
                                  "empty", "space", "trim", "long", "long-color", "v4",
                                  "duplicate-id", "duplicate-source", "duplicate-name", "plan-id"])
def test_bad_request_is_422_without_writes(kind, tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        body = request(client)
        copy = body["copies"][0]
        if kind == "confirmation":
            body["confirmed"] = False
        elif kind == "numeric-confirmation":
            body["confirmed"] = 1
        elif kind == "extra":
            body["owner_user_id"] = str(OTHER_USER_ID)
        elif kind == "copy-extra":
            copy["dirty"] = 0
        elif kind in {"empty", "space", "trim", "long"}:
            bad_names = {"empty": "", "space": " ", "trim": " x ", "long": "x" * 33}
            copy["name"] = bad_names[kind]
        elif kind == "long-color":
            copy["color"] = "x" * 17
        elif kind == "v4":
            copy["id"] = str(uuid.uuid4())
        elif kind == "plan-id":
            copy["id"] = str(PLAN)
        else:
            third = "0198f2a1-4b3c-7000-8000-000000000074"
            second = {**copy, "from_tag_id": str(SECOND), "id": third, "name": "other"}
            if kind == "duplicate-id":
                second["id"] = str(COPY)
            if kind == "duplicate-source":
                second["from_tag_id"] = str(ID)
            if kind == "duplicate-name":
                second["name"] = copy["name"]
            body["copies"].append(second)
        assert client.post(URL, json=body).status_code == 422
        assert db.session.get(Tag, COPY) is None and db.commits == db.flushes == 0


@pytest.mark.parametrize("kind", [
    "unknown_receipt", "foreign_tag", "foreign_media", "missing_file",
])
def test_unsupported_resource_state_does_not_create(kind, tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch, **{kind: True}) as (client, db, _):
        assert client.post(URL, json=request(client)).status_code == 409
        assert db.session.get(Tag, COPY) is None and db.commits == 0


@pytest.mark.parametrize("operation", ["flush", "commit"])
def test_failed_transaction_does_not_confirm_or_leave_new_tags(operation, tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        body = request(client)
        monkeypatch.setattr(db, operation, AsyncMock(side_effect=RuntimeError("failure")))
        assert client.post(URL, json=body).status_code == 500
        assert db.session.get(Tag, COPY) is None and db.commits == 0 and db.rollbacks > 0


@pytest.mark.parametrize("code", [1205, 1213])
def test_lock_contention_is_409_without_confirmation(code, tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        body = request(client)
        monkeypatch.setattr(db, "flush", AsyncMock(side_effect=OperationalError(
            "insert", {}, mysql_error(code),
        )))
        response = client.post(URL, json=body)
        assert response.status_code == 409 and "tags_confirmed" not in response.text
        assert db.session.get(Tag, COPY) is None


def test_duplicate_race_rolls_back_and_never_maps_another_tag(tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        body = request(client)
        monkeypatch.setattr(db, "flush", AsyncMock(side_effect=IntegrityError(
            "insert", {}, mysql_error(1062),
        )))
        response = client.post(URL, json=body)
        assert response.status_code == 409 and response.headers["Cache-Control"] == "no-store"
        assert db.session.get(Tag, COPY) is None and db.commits == 0


def test_authentication_and_other_source_cannot_be_bypassed(tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        body = request(client)
        url = f"/api/v1/schedules/{SECOND}/independent-tags"
        assert client.post(url, json=body).status_code == 404
        assert db.session.get(Tag, COPY) is None
    with fixture(tmp_path, monkeypatch, authenticated=False) as (client, db, _):
        body = {"plan_id": str(PLAN), "choice": "cloud-source-use-diary", "confirmed": True,
                "expected_resources": {}, "copies": [{"from_tag_id": str(ID), "id": str(COPY),
                                                      "name": "new", "color": None}]}
        assert client.post(URL, json=body).status_code == 401 and db.commits == 0


def test_two_tag_batch_is_one_commit_and_failed_second_name_installs_neither(tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        body = request(client, choice="cloud-source-keep-diary")
        second = {"from_tag_id": str(PLAN), "id": str(SECOND), "name": "第二个明确名称",
                  "color": None}
        # plan_id is not a source tag either: use a separate old local tag identity.
        second["from_tag_id"] = "0198f2a1-4b3c-7000-8000-000000000075"
        body["copies"].append(second)
        db.session.add(Tag(id=OTHER_USER_ID, user_id=USER_ID, name=second["name"],
                           color=None, created_at=AT))
        db.session.commit()
        assert client.post(URL, json=body).status_code == 409
        assert db.session.get(Tag, COPY) is None and db.session.get(Tag, SECOND) is None
        body["copies"][1]["name"] = "第二个不冲突名称"
        data = success(client.post(URL, json=body))
        assert len(data["tags"]) == 2 and all(tag["created"] for tag in data["tags"])
        assert db.commits == db.flushes == 1
        assert [row.tag_id for row in db.session.scalars(select(EntryTag))] == [ID]


@pytest.mark.parametrize("kind", [
    "pending", "source-deleted", "entry-deleted", "purged", "foreign",
])
def test_unusable_terminal_never_publishes(kind, tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        if kind == "pending":
            db.session.get(Schedule, ID).status = 0
        elif kind == "source-deleted":
            db.session.get(Schedule, ID).deleted_at = AT
        elif kind == "entry-deleted":
            db.session.get(DiaryEntry, ID).deleted_at = AT
        elif kind == "purged":
            db.session.delete(db.session.get(DiaryEntry, ID))
        else:
            db.session.get(Schedule, ID).user_id = OTHER_USER_ID
        db.session.commit()
        if kind == "foreign":
            body = {"plan_id": str(PLAN), "choice": "cloud-source-keep-diary", "confirmed": True,
                    "expected_resources": {}, "copies": [{"from_tag_id": str(ID), "id": str(COPY),
                                                          "name": "new", "color": None}]}
        else:
            body = request(client)
        assert client.post(URL, json=body).status_code == (404 if kind == "foreign" else 409)
        assert db.session.get(Tag, COPY) is None and db.commits == 0


def test_same_id_exact_owned_definition_is_presence_not_provenance(tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        body = request(client)
        db.session.add(Tag(id=COPY, user_id=USER_ID, name=body["copies"][0]["name"],
                           color="green", created_at=AT))
        db.session.commit()
        data = success(client.post(URL, json=body))
        assert data["tags_confirmed"] and not data["tags"][0]["created"]
        assert db.commits == db.flushes == 0 and data["tags"][0]["created_at"] == AT.isoformat()


def test_mixed_existing_new_batch_preserves_timestamp(tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        body = request(client, choice="cloud-source-keep-diary")
        db.session.add(Tag(id=COPY, user_id=USER_ID, name=body["copies"][0]["name"],
                           color="green", created_at=AT))
        db.session.commit()
        before = saved(db.session.get(Tag, COPY))
        body["copies"].append({"from_tag_id": str(OTHER_USER_ID), "id": str(SECOND),
                               "name": "第二个独立名称", "color": None})
        data = success(client.post(URL, json=body))
        assert [row["created"] for row in data["tags"]] == [False, True]
        assert saved(db.session.get(Tag, COPY)) == before
        assert db.commits == db.flushes == 1


def test_second_add_failure_rolls_back_the_whole_batch(tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        body = request(client, choice="cloud-source-keep-diary")
        body["copies"].append({"from_tag_id": str(OTHER_USER_ID), "id": str(SECOND),
                               "name": "第二个独立名称", "color": None})
        add = db.add
        calls = 0

        def fail_second(row):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("second insert")
            add(row)

        monkeypatch.setattr(db, "add", fail_second)
        assert client.post(URL, json=body).status_code == 500 and calls == 2
        assert db.session.get(Tag, COPY) is None and db.session.get(Tag, SECOND) is None
        assert db.commits == 0 and db.rollbacks > 0


def test_readonly_presence_never_creates_missing_tags(tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        body, before = request(client), original_state(db)
        result = client.post(f"{URL}/review", json=body)
        assert result.status_code == 409
        assert result.headers["Cache-Control"] == "no-store"
        assert db.session.get(Tag, COPY) is None
        assert db.commits == db.flushes == 0 and original_state(db) == before


def test_readonly_presence_has_no_writes_and_preserves_creation_identity(tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        body = request(client)
        first = success(client.post(URL, json=body))
        before, counts = original_state(db), (db.commits, db.flushes)
        result = success(client.post(f"{URL}/review", json=body))
        assert result["tags_confirmed"] and not result["tags"][0]["created"]
        assert result["tags"][0]["created_at"] == first["tags"][0]["created_at"]
        assert not result["resolution_enabled"] and not result["diary_sync_enabled"]
        assert original_state(db) == before and (db.commits, db.flushes) == counts


@pytest.mark.parametrize("mode", ["deleted", "name", "color", "foreign", "stale"])
def test_readonly_presence_changes_fail_without_recreation(mode, tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        body = request(client)
        success(client.post(URL, json=body))
        tag = db.session.get(Tag, COPY)
        if mode == "deleted":
            db.session.delete(tag)
        elif mode == "name":
            tag.name = "已改变"
        elif mode == "color":
            tag.color = "blue"
        elif mode == "foreign":
            tag.user_id = OTHER_USER_ID
        else:
            db.session.get(DiaryEntry, ID).title = "已改变"
        db.session.commit()
        before, counts = original_state(db), (db.commits, db.flushes)
        result = client.post(f"{URL}/review", json=body)
        assert result.status_code == 409 and result.headers["Cache-Control"] == "no-store"
        assert original_state(db) == before and (db.commits, db.flushes) == counts
        if mode == "deleted":
            assert db.session.get(Tag, COPY) is None


def test_readonly_presence_batch_missing_member_does_not_create_it(tmp_path, monkeypatch):
    with fixture(tmp_path, monkeypatch) as (client, db, _):
        body = request(client, choice="cloud-source-keep-diary")
        success(client.post(URL, json=body))
        body["copies"].append({
            "from_tag_id": str(SECOND), "id": str(uuid.UUID(int=PLAN.int + 5)),
            "name": "第二个明确副本", "color": None,
        })
        counts = db.commits, db.flushes
        result = client.post(f"{URL}/review", json=body)
        assert result.status_code == 409 and (db.commits, db.flushes) == counts
        assert db.session.get(Tag, uuid.UUID(int=PLAN.int + 5)) is None
