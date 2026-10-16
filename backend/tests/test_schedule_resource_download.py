"""Source-scoped authenticated download HTTP/SQLite tests; not a frontend restore."""

import base64
import hashlib
import os
import uuid
from copy import deepcopy

import pytest
from sqlalchemy.exc import OperationalError
from test_schedule_convert import client_fixture
from test_schedule_resource_review import PNG, resource_fixture
from test_schedule_writes import AT, ID, OTHER_USER_ID, USER_ID, mysql_error, stored, success

from app.main import app
from app.models.diary_entry import DiaryEntry
from app.models.media import Media
from app.models.schedule import Schedule

URL = f"/api/v1/schedules/{ID}/review/resources/{OTHER_USER_ID}/original"


def expected(data=PNG, mime="image/png", **changes):
    values = {"expected_size": len(data), "expected_mime": mime,
              "expected_sha256": hashlib.sha256(data).hexdigest()}
    values.update(changes)
    return values


def test_current_original_download_is_repeatable_private_read_only(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, path):
        original_file = path.read_bytes()
        reply = client.get(URL, params=expected())
        data = success(reply)
        assert data["read_only"] and data["resolution_enabled"] is False
        assert data["proof_scope"] == "current_entry_image_bytes"
        assert data["schedule_id"] == str(ID) and data["media_id"] == str(OTHER_USER_ID)
        assert data["variant"] == "original" and data["size"] == len(PNG)
        assert data["sha256"] == expected()["expected_sha256"]
        assert base64.b64decode(data["data_base64"], validate=True) == PNG
        assert {"user_id", "url", "thumb_url", "path", "receipt", "confirmed"}.isdisjoint(data)
        assert reply.headers["Cache-Control"] == "no-store"
        assert reply.headers["Pragma"] == "no-cache"
        assert reply.headers["X-Content-Type-Options"] == "nosniff"
        assert success(client.get(URL, params=expected())) == data
        assert path.read_bytes() == original_file and db.commits == db.flushes == 0


def test_thumbnail_uses_its_own_path_size_mime_and_hash(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, path):
        body = b"GIF89a" + b"tiny thumbnail"
        thumbnail = path.with_name(f"{OTHER_USER_ID}_thumb.gif")
        thumbnail.write_bytes(body)
        row = db.session.get(Media, OTHER_USER_ID)
        row.thumb_url = f"/media/{OTHER_USER_ID.hex[:4]}/{thumbnail.name}"
        db.session.commit()
        data = success(client.get(URL.replace("/original", "/thumbnail"),
                                  params=expected(body, "image/gif")))
        assert data["variant"] == "thumbnail" and data["mime"] == "image/gif"
        assert base64.b64decode(data["data_base64"]) == body
        assert db.commits == db.flushes == 0


@pytest.mark.parametrize("changes", [
    {"expected_size": len(PNG) + 1}, {"expected_sha256": "0" * 64},
    {"expected_mime": "image/jpeg"},
])
def test_stale_image_proof_is_409_without_new_bytes(changes, tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, _):
        reply = client.get(URL, params=expected(**changes))
        assert reply.status_code == 409 and "data_base64" not in reply.text
        assert reply.headers["Cache-Control"] == "no-store"
        assert db.commits == db.flushes == 0


@pytest.mark.parametrize("changes", [
    {"expected_size": 0}, {"expected_size": 10 * 1024 * 1024 + 1},
    {"expected_sha256": "bad"}, {"expected_sha256": "A" * 64},
    {"expected_mime": "text/html"},
])
def test_bad_proof_query_is_422(changes, tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, _, _):
        assert client.get(URL, params=expected(**changes)).status_code == 422


@pytest.mark.parametrize("missing", ["expected_size", "expected_sha256", "expected_mime"])
def test_each_current_proof_field_is_required(missing, tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, _, _):
        params = expected()
        del params[missing]
        assert client.get(URL, params=params).status_code == 422


def test_authenticated_source_and_media_binding_required(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch, foreign_media=True) as (client, db, _):
        assert client.get(URL, params=expected()).status_code == 404
        assert db.commits == db.flushes == 0


def test_no_authentication_never_downloads_bytes(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch, authenticated=False) as (client, _, _):
        assert client.get(URL, params=expected()).status_code == 401


def test_foreign_source_has_no_byte_access(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, _):
        row = db.session.get(Schedule, ID)
        row.user_id = OTHER_USER_ID
        db.session.commit()
        assert client.get(URL, params=expected()).status_code == 404
        assert db.commits == db.flushes == 0


def test_wrong_entry_media_binding_has_no_byte_access(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, _):
        row = db.session.get(Media, OTHER_USER_ID)
        row.entry_id = USER_ID
        db.session.commit()
        assert client.get(URL, params=expected()).status_code == 404


def test_unknown_receipt_keeps_protection_and_returns_no_bytes(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch, unknown_receipt=True) as (client, db, _):
        assert client.get(URL, params=expected()).status_code == 409
        assert db.commits == db.flushes == 0


def test_pending_source_cannot_download_before_resource_tables_exist():
    with client_fixture([stored()]) as (client, db):
        assert client.get(URL, params=expected()).status_code == 409
        assert db.commits == db.flushes == 0


@pytest.mark.parametrize("kind", ["unreferenced", "future", "external", "purged"])
def test_current_body_reference_is_required(kind, tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, _):
        entry = db.session.get(DiaryEntry, ID)
        if kind == "purged":
            db.session.delete(entry)
        elif kind == "unreferenced":
            entry.content = None
        else:
            body = deepcopy(entry.content)
            if kind == "future":
                body["schemaVersion"] = 999
            else:
                body["doc"]["content"][0]["attrs"]["src"] = "https://private.example/image"
            entry.content = body
        db.session.commit()
        reply = client.get(URL, params=expected())
        assert reply.status_code == (404 if kind == "unreferenced" else 409)
        assert "data_base64" not in reply.text and db.commits == db.flushes == 0


def test_deleted_current_diary_can_read_without_restoring_it(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, _):
        entry = db.session.get(DiaryEntry, ID)
        entry.deleted_at = AT
        db.session.commit()
        assert base64.b64decode(success(client.get(URL, params=expected()))["data_base64"]) == PNG
        assert db.session.get(DiaryEntry, ID).deleted_at == AT
        assert db.commits == db.flushes == 0


@pytest.mark.parametrize("kind", ["missing", "symlink", "fifo", "unsafe-path", "changed"])
def test_unverified_disk_content_never_downloads(kind, tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, path):
        if kind == "missing":
            path.unlink()
        elif kind == "symlink":
            private = tmp_path / "private.png"
            private.write_bytes(PNG)
            path.unlink()
            path.symlink_to(private)
        elif kind == "fifo":
            path.unlink()
            os.mkfifo(path)
        elif kind == "unsafe-path":
            db.session.get(Media, OTHER_USER_ID).url = "https://private.example/image?token=secret"
            db.session.commit()
        else:
            path.write_bytes(PNG[:-1] + b"!")
        reply = client.get(URL, params=expected())
        assert reply.status_code == (404 if kind == "missing" else 409)
        assert "data_base64" not in reply.text and "token=secret" not in reply.text
        assert db.commits == db.flushes == 0


def test_missing_thumbnail_is_not_substituted_with_original(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, _, _):
        assert client.get(URL.replace("/original", "/thumbnail"),
                          params=expected()).status_code == 404


@pytest.mark.parametrize("path", [URL.replace(str(ID), str(uuid.uuid4())),
                                 URL.replace(str(OTHER_USER_ID), str(uuid.uuid4())),
                                 URL.replace("/original", "/unknown")])
def test_invalid_path_identity_or_variant_is_rejected(path, tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, _, _):
        assert client.get(path, params=expected()).status_code == 422


def test_download_lock_conflict_is_409_without_private_sql(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, _):
        async def locked(*_args, **_kwargs):
            raise OperationalError("private SQL", {}, mysql_error(1213))
        db.scalar = locked
        reply = client.get(URL, params=expected())
        assert reply.status_code == 409 and "private SQL" not in reply.text
        assert db.rollbacks >= 1 and db.commits == db.flushes == 0


def test_download_path_is_present_in_expanded_openapi():
    path = "/api/v1/schedules/{schedule_id}/review/resources/{media_id}/{variant}"
    assert path in app.openapi()["paths"]
