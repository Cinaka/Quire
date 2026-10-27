"""Actual ASGI business UUID32 contracts with mocked DB; not MySQL integration."""

from contextlib import contextmanager
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient
from test_schedule_writes import ID, OTHER_USER_ID, USER_ID

from app.api.v1 import sync
from app.core.security import get_current_user
from app.core.time import utcnow
from app.db.session import get_db
from app.main import app

AT = utcnow() - timedelta(minutes=1)
OWNER = SimpleNamespace(id=USER_ID)


def entry(ident=ID):
    return SimpleNamespace(
        id=ident, user_id=USER_ID, entry_date=AT.date(), sort_order=0, title=str(ID),
        content={"text": str(ID)}, content_text=str(ID), mood=None, weather=None,
        from_schedule_id=ID, client_updated_at=AT, deleted_at=None,
        created_at=AT, updated_at=AT,
    )


def rows(*values):
    return SimpleNamespace(scalars=lambda: list(values))


@contextmanager
def client_for(db):
    previous = app.dependency_overrides.copy()

    async def override_db():
        yield db

    app.dependency_overrides[get_current_user] = lambda: OWNER
    app.dependency_overrides[get_db] = override_db
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            yield client
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)


def database(**changes):
    values = dict(scalar=AsyncMock(), execute=AsyncMock(), add=MagicMock(),
                  refresh=AsyncMock(), commit=AsyncMock(), rollback=AsyncMock())
    values.update(changes)
    return SimpleNamespace(**values)


@pytest.mark.parametrize("identifier", [ID.hex, str(ID).upper()])
def test_get_entry_normalizes_identity_without_changing_text(identifier):
    db = database(scalar=AsyncMock(return_value=entry()), execute=AsyncMock(return_value=rows(
        SimpleNamespace(entry_id=ID, tag_id=OTHER_USER_ID),
    )))
    with client_for(db) as client:
        response = client.get(f"/api/v1/entries/{identifier}")
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["id"] == data["from_schedule_id"] == ID.hex
    assert data["tag_ids"] == [OTHER_USER_ID.hex]
    assert data["title"] == data["content_text"] == str(ID)
    assert data["content"] == {"text": str(ID)}
    assert "user_id" not in data


@pytest.mark.parametrize("path", [
    f"/api/v1/entries/urn:uuid:{ID}", f"/api/v1/tags/urn:uuid:{ID}",
])
def test_bad_path_uuid_is_422_before_database_lookup(path):
    db = database()
    with client_for(db) as client:
        response = (client.put(path, json={"name": "标签"}) if "/tags/" in path
                    else client.get(path))
    assert response.status_code == 422, response.text
    db.scalar.assert_not_awaited()
    db.execute.assert_not_awaited()
    db.commit.assert_not_awaited()


@pytest.mark.parametrize("query", [f"tag_id=urn:uuid:{ID}", f"tag_id=%20{ID.hex}"])
def test_entry_tag_filter_rejects_bad_uuid_before_query(query):
    db = database()
    with client_for(db) as client:
        response = client.get("/api/v1/entries?" + query)
    assert response.status_code == 422
    db.scalar.assert_not_awaited()
    db.execute.assert_not_awaited()


def test_missing_entry_remains_404():
    db = database(scalar=AsyncMock(return_value=None))
    with client_for(db) as client:
        response = client.get(f"/api/v1/entries/{ID.hex}")
    assert response.status_code == 404
    db.commit.assert_not_awaited()


def test_tag_update_returns_hex32_and_preserves_name():
    tag = SimpleNamespace(id=ID, name="原标签", color=None, created_at=AT)
    db = database(scalar=AsyncMock(side_effect=[tag, None]))
    with client_for(db) as client:
        response = client.put(f"/api/v1/tags/{ID.hex}", json={"name": str(ID)[:32]})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["id"] == ID.hex
    assert response.json()["data"]["name"] == str(ID)[:32]
    db.commit.assert_awaited_once()


def test_sync_push_ids_and_duplicate_hint_are_hex32(monkeypatch):
    updated = AsyncMock(return_value=(entry(), "applied"))
    monkeypatch.setattr(sync, "upsert_entry", updated)
    duplicate = SimpleNamespace(id=OTHER_USER_ID)
    db = database(scalar=AsyncMock(side_effect=[None, duplicate, None]))
    with client_for(db) as client:
        response = client.post("/api/v1/sync/push", json={
            "entries": [{"id": str(ID), "entry_date": AT.date().isoformat(),
                         "client_updated_at": AT.isoformat(), "title": str(ID)}],
            "tags": [{"id": str(ID), "name": "重复", "created_at": AT.isoformat()}],
            "media_meta": [{"id": str(ID), "entry_id": None, "mime": "image/png",
                            "created_at": AT.isoformat()}],
        })
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["entries"] == [{"id": ID.hex, "status": "applied"}]
    assert data["tags"] == [{"id": ID.hex, "status": "error",
                             "message": f"duplicate_tag:{OTHER_USER_ID.hex}"}]
    assert data["media_meta"] == [{"id": ID.hex, "status": "applied"}]
    assert updated.await_args.args[2] == ID
    assert updated.await_args.args[3].title == str(ID)
    db.commit.assert_awaited_once()


def test_sync_stale_ack_stays_stale_with_hex32_id(monkeypatch):
    monkeypatch.setattr(sync, "upsert_entry", AsyncMock(return_value=(entry(), "stale")))
    db = database()
    with client_for(db) as client:
        response = client.post("/api/v1/sync/push", json={"entries": [{
            "id": ID.hex, "entry_date": AT.date().isoformat(),
            "client_updated_at": AT.isoformat(),
        }]})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["entries"] == [{
        "id": ID.hex, "status": "stale", "server_client_updated_at": AT.isoformat(),
    }]


def test_sync_changes_cursor_and_all_identity_fields_are_hex32():
    media = SimpleNamespace(id=OTHER_USER_ID, entry_id=ID, sort_order=0, width=1, height=1,
                            size=10, url=f"/media/{ID}.png", thumb_url="", created_at=AT)
    tag = SimpleNamespace(id=OTHER_USER_ID, name=str(ID)[:32], color=None, created_at=AT)
    db = database(execute=AsyncMock(side_effect=[
        rows(entry(), entry(OTHER_USER_ID)),
        rows(SimpleNamespace(entry_id=ID, tag_id=OTHER_USER_ID)), rows(media), rows(tag),
    ]))
    with client_for(db) as client:
        response = client.get("/api/v1/sync/changes", params={
            "limit": 1, "since": (AT - timedelta(seconds=1)).isoformat(), "after_id": ID.hex,
        })
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["has_more"] is True and data["cursor_id"] == ID.hex
    assert data["entries"][0]["id"] == data["entries"][0]["from_schedule_id"] == ID.hex
    assert data["entries"][0]["tag_ids"] == [OTHER_USER_ID.hex]
    assert data["tags"][0]["id"] == data["media_meta"][0]["id"] == OTHER_USER_ID.hex
    assert data["media_meta"][0]["entry_id"] == ID.hex
    assert data["media_meta"][0]["url"] == media.url
    assert data["tags"][0]["name"] == str(ID)[:32]
    db.commit.assert_not_awaited()


def test_sync_changes_terminal_page_has_null_cursor():
    db = database(execute=AsyncMock(side_effect=[rows(), rows()]))
    with client_for(db) as client:
        response = client.get("/api/v1/sync/changes")
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["has_more"] is False and data["cursor_id"] is None
    assert data["entries"] == data["tags"] == data["media_meta"] == []


@pytest.mark.parametrize("target", ["query", "body"])
def test_sync_invalid_id_is_422_before_database_query(target):
    db = database()
    with client_for(db) as client:
        if target == "query":
            response = client.get(
                "/api/v1/sync/changes", params={"after_id": "urn:uuid:" + str(ID)},
            )
        else:
            response = client.post("/api/v1/sync/push", json={"media_meta": [{
                "id": ID.hex, "entry_id": "urn:uuid:" + str(ID),
                "mime": "image/png", "created_at": AT.isoformat(),
            }]})
    assert response.status_code == 422, response.text
    db.scalar.assert_not_awaited()
    db.execute.assert_not_awaited()
    db.commit.assert_not_awaited()
