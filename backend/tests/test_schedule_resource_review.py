"""HTTP/SQLite resource review tests; filesystem evidence is not a remote CAS lock."""

import hashlib
from contextlib import contextmanager
from copy import deepcopy

import pytest
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from test_schedule_convert import client_fixture, diary
from test_schedule_deletion import terminal
from test_schedule_writes import AT, ID, OTHER_USER_ID, USER_ID, mysql_error, stored, success

from app.core.config import settings
from app.models.diary_entry import DiaryEntry
from app.models.entry_tag import EntryTag
from app.models.media import Media
from app.models.tag import Tag

URL = f"/api/v1/schedules/{ID}/review/resources"
PNG = b"\x89PNG\r\n\x1a\n" + b"test bytes"

@contextmanager
def resource_fixture(tmp_path, monkeypatch, *, foreign_media=False, foreign_tag=False,
                     missing_file=False, unknown_receipt=False, authenticated=True):
    monkeypatch.setattr(settings, "MEDIA_ROOT", tmp_path)
    monkeypatch.setattr(settings, "MEDIA_PUBLIC_PREFIX", "/media")
    body = {"schemaVersion": 1, "doc": {"type": "doc", "content": [
        {"type": "image", "attrs": {"src": f"local://media/{OTHER_USER_ID}"}},
    ]}}
    source = terminal(converted_receipt=None) if unknown_receipt else terminal()
    with client_fixture(
        [source], [diary(content=body)], authenticated=authenticated,
    ) as (client, db):
        db.session.execute(text("""
            CREATE TABLE media (
                id BLOB PRIMARY KEY, user_id BLOB NOT NULL, entry_id BLOB, url VARCHAR(512),
                thumb_url VARCHAR(512), width INTEGER, height INTEGER, size BIGINT,
                sort_order INTEGER NOT NULL, created_at DATETIME NOT NULL
            )
        """))
        db.session.execute(text("""
            CREATE TABLE tags (
                id BLOB PRIMARY KEY, user_id BLOB NOT NULL, name VARCHAR(32) NOT NULL,
                color VARCHAR(16), created_at DATETIME NOT NULL
            )
        """))
        db.session.add(Media(
            id=OTHER_USER_ID, user_id=OTHER_USER_ID if foreign_media else USER_ID,
            entry_id=ID, url=f"/media/{OTHER_USER_ID.hex[:4]}/{OTHER_USER_ID}.png",
            thumb_url=None, width=2, height=1, size=len(PNG), sort_order=0, created_at=AT,
        ))
        db.session.add(Tag(
            id=ID, user_id=OTHER_USER_ID if foreign_tag else USER_ID,
            name="private foreign label" if foreign_tag else "当前标签", color="green", created_at=AT,
        ))
        db.session.add(EntryTag(entry_id=ID, tag_id=ID))
        db.session.commit()
        directory = tmp_path / OTHER_USER_ID.hex[:4]
        directory.mkdir(exist_ok=True)
        path = directory / f"{OTHER_USER_ID}.png"
        if not missing_file:
            path.write_bytes(PNG)
        yield client, db, path


def test_current_resource_hash_tags_and_metadata_are_private_read_only(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, _):
        before = db.commits, db.flushes
        data = success(client.get(URL))
        assert data["read_only"] and data["resolution_enabled"] is False
        assert data["proof_scope"] == "current_entry_resources" and data["resources_complete"]
        assert data["review"]["receipt_known"] and data["media_ids"] == [str(OTHER_USER_ID)]
        image = data["media"][0]["original"]
        assert image["state"] == "verified" and image["size"] == len(PNG)
        assert image["sha256"] == hashlib.sha256(PNG).hexdigest()
        assert data["media"][0]["thumbnail"]["state"] == "not_present"
        assert data["tags"][0]["name"] == "当前标签"
        forbidden = {"user_id", "url", "thumb_url", "path", "converted_receipt", "confirmed"}
        for resource in [data, *data["media"], *data["tags"], image]:
            assert forbidden.isdisjoint(resource)
        assert (db.commits, db.flushes) == before
        assert success(client.get(URL)) == data


@pytest.mark.parametrize("kind", ["foreign_media", "foreign_tag", "missing_file"])
def test_missing_or_foreign_resources_are_not_complete_or_exposed(kind, tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch, **{kind: True}) as (client, db, _):
        data = success(client.get(URL))
        assert not data["resources_complete"] and data["resource_state"] == "incomplete"
        assert "private foreign label" not in str(data)
        if kind == "foreign_media":
            assert data["missing_media_ids"] == [str(OTHER_USER_ID)] and data["media"] == []
        if kind == "foreign_tag":
            assert data["missing_tag_ids"] == [str(ID)] and data["tags"] == []
        if kind == "missing_file":
            assert data["media"][0]["original"]["state"] == "missing"
        assert db.commits == db.flushes == 0


@pytest.mark.parametrize("change", ["size", "invalid_bytes", "wrong_path", "symlink"])
def test_unverified_files_do_not_become_hash_proof(change, tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, path):
        row = db.session.get(Media, OTHER_USER_ID)
        if change == "size":
            row.size = 999
        elif change == "invalid_bytes":
            path.write_bytes(b"invalid image bytes")
        elif change == "wrong_path":
            row.url = "https://private.example/image?token=private"
        else:
            target = tmp_path / "private.png"
            target.write_bytes(PNG)
            path.unlink()
            path.symlink_to(target)
        db.session.commit()
        data = success(client.get(URL))
        assert not data["resources_complete"]
        assert data["media"][0]["original"]["state"] == "unavailable"
        assert data["media"][0]["original"]["sha256"] is None
        assert "token=private" not in str(data) and db.commits == db.flushes == 0


@pytest.mark.parametrize("kind", ["future", "external"])
def test_unsupported_content_keeps_review_but_no_resource_authority(kind, tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, _):
        row = db.session.get(DiaryEntry, ID)
        body = deepcopy(row.content)
        if kind == "future":
            body["schemaVersion"] = 999
        else:
            body["doc"]["content"][0]["attrs"]["src"] = "https://external/image"
        row.content = body
        db.session.commit()
        data = success(client.get(URL))
        assert data["resource_state"] == "unsupported" and not data["resources_complete"]
        assert data["media"] == data["tags"] == [] and data["resolution_enabled"] is False


def test_unknown_receipt_resources_never_confirm_the_first_intent(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch, unknown_receipt=True) as (client, _, _):
        data = success(client.get(URL))
        assert data["resources_complete"] and not data["review"]["receipt_known"]
        assert not data["review"]["reviewable"] and not data["resolution_enabled"]


def test_pending_source_has_no_current_resource_read(tmp_path, monkeypatch):
    with client_fixture([stored()]) as (client, db):
        data = success(client.get(URL))
        assert data["resource_state"] == "no_entry" and data["review"]["entry"] is None
        assert not data["resources_complete"] and db.commits == db.flushes == 0


def test_missing_and_foreign_source_are_404_without_resource_tables():
    for rows in [[], [terminal(user_id=OTHER_USER_ID)]]:
        with client_fixture(rows) as (client, db):
            assert client.get(URL).status_code == 404 and db.commits == db.flushes == 0


def test_resource_review_requires_authentication(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch, authenticated=False) as (client, _, _):
        assert client.get(URL).status_code == 401


def test_non_v7_id_rejected():
    with client_fixture() as (client, _):
        path = URL.replace(str(ID), "00000000-0000-4000-8000-000000000001")
        assert client.get(path).status_code == 422


def test_lock_conflict_is_409_not_private_sql(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, _):
        async def locked(*_args, **_kwargs):
            raise OperationalError("private SQL", {}, mysql_error(1213))
        db.scalar = locked
        response = client.get(URL)
        assert response.status_code == 409 and "private SQL" not in response.text
        assert db.rollbacks >= 1 and db.commits == 0


@pytest.mark.parametrize("kind", ["deleted", "purged"])
def test_current_deleted_or_absent_diary_is_not_restored(kind, tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, _):
        row = db.session.get(DiaryEntry, ID)
        if kind == "deleted":
            row.deleted_at = AT
        else:
            db.session.delete(row)
        db.session.commit()
        data = success(client.get(URL))
        assert data["review"]["entry_state"] == kind and not data["resolution_enabled"]
        if kind == "purged":
            assert data["resource_state"] == "no_entry" and data["media"] == data["tags"] == []
        else:
            assert data["resources_complete"] and data["review"]["first_entry_deleted"] is False
        assert db.commits == db.flushes == 0
