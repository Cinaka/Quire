"""Authentication UUID32 HTTP/JWT contracts, with mocked database dependencies."""

import asyncio
import json
from contextlib import contextmanager
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, Response
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient

from app.api.v1.auth import REFRESH_COOKIE, AuthResponse, logout, refresh, user_response
from app.api.v1.sessions import SessionResponse, current_session_id
from app.core.ids import new_id
from app.core.security import (
    create_access_token,
    create_refresh_token,
    create_token,
    decode_token,
    get_current_user,
)
from app.core.time import utcnow
from app.db.session import get_db
from app.main import app
from app.schemas.envelope import ok


def user():
    return SimpleNamespace(id=new_id(), email="person@example.com", nickname="青简",
                           timezone="Asia/Shanghai", token_version=3)


def session(owner):
    return SimpleNamespace(id=new_id(), user_id=owner.id, token_version=owner.token_version,
                           created_at=utcnow(), expires_at=utcnow() + timedelta(days=1),
                           revoked_at=None)


@contextmanager
def client_for(owner, rows):
    db = SimpleNamespace(
        scalars=AsyncMock(return_value=SimpleNamespace(all=lambda: rows)),
        scalar=AsyncMock(return_value=rows[0] if rows else None),
        commit=AsyncMock(),
    )
    previous = app.dependency_overrides.copy()

    async def override_db():
        yield db

    app.dependency_overrides[get_current_user] = lambda: owner
    app.dependency_overrides[get_db] = override_db
    client = TestClient(app, raise_server_exceptions=False)
    try:
        yield client, db
    finally:
        client.close()
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)


def test_nested_auth_response_serializes_only_identity_fields():
    owner = user()
    owner.nickname = str(owner.id)
    response = ok(AuthResponse(
        user=user_response(owner), access_token="opaque-token", expires_in=60,
    ))
    data = json.loads(response.model_dump_json())["data"]
    assert data["user"]["id"] == owner.id.hex
    assert data["user"]["nickname"] == str(owner.id)
    assert data["access_token"] == "opaque-token"
    assert user_response(owner).id == owner.id


def test_session_response_keeps_uuid_in_python_and_hex_in_json():
    row = session(user())
    value = SessionResponse(id=row.id, createdAt=row.created_at, expiresAt=row.expires_at,
                            current=True)
    assert value.id == row.id
    assert value.model_dump(mode="json")["id"] == row.id.hex


def test_me_http_response_uses_hex32():
    owner = user()
    with client_for(owner, []) as (client, _):
        response = client.get("/api/v1/auth/me")
    assert response.status_code == 200
    assert response.json()["data"]["id"] == owner.id.hex


def test_sessions_http_response_and_current_cookie_agree():
    owner = user()
    row = session(owner)
    token = create_refresh_token(owner, row.id)
    with client_for(owner, [row]) as (client, _):
        client.cookies.set(REFRESH_COOKIE, token)
        response = client.get("/api/v1/auth/sessions")
    assert response.status_code == 200
    data = response.json()["data"]
    assert data[0]["id"] == row.id.hex
    assert data[0]["current"] is True


def test_revoke_session_accepts_hex32_path():
    owner = user()
    row = session(owner)
    with client_for(owner, [row]) as (client, db):
        response = client.delete(f"/api/v1/auth/sessions/{row.id.hex}")
    assert response.status_code == 200
    assert row.revoked_at is not None
    db.commit.assert_awaited_once()


def test_revoke_session_rejects_urn_before_database_query():
    owner = user()
    row = session(owner)
    with client_for(owner, [row]) as (client, db):
        response = client.delete(f"/api/v1/auth/sessions/urn:uuid:{row.id}")
    assert response.status_code == 422
    db.scalar.assert_not_awaited()
    db.commit.assert_not_awaited()


def test_access_and_refresh_claims_are_hex32():
    owner = user()
    row = session(owner)
    access = decode_token(create_access_token(owner), "access")
    refreshed = decode_token(create_refresh_token(owner, row.id), "refresh")
    assert access["sub"] == refreshed["sub"] == owner.id.hex
    assert refreshed["jti"] == row.id.hex
    assert current_session_id(create_refresh_token(owner, row.id)) == row.id


def test_legacy_exact_token_ids_are_read_without_rewriting_identity():
    owner = user()
    row = session(owner)
    token = create_token(owner, "refresh", timedelta(minutes=1),
                         {"sub": str(owner.id), "jti": str(row.id)})
    assert current_session_id(token) == row.id


def test_bad_refresh_identifier_is_401_before_database_query():
    owner = user()
    token = create_token(owner, "refresh", timedelta(minutes=1),
                         {"jti": "urn:uuid:" + str(new_id())})
    db = SimpleNamespace(scalar=AsyncMock())
    with pytest.raises(HTTPException) as captured:
        asyncio.run(refresh(Response(), token, db))
    assert captured.value.status_code == 401
    db.scalar.assert_not_awaited()


def test_new_access_subject_can_load_the_same_owner():
    owner = user()
    db = SimpleNamespace(scalar=AsyncMock(return_value=owner))
    credentials = HTTPAuthorizationCredentials(
        scheme="Bearer", credentials=create_access_token(owner),
    )
    assert asyncio.run(get_current_user(credentials, db)) is owner


def test_logout_accepts_new_hex32_refresh_session():
    owner = user()
    row = session(owner)
    db = SimpleNamespace(scalar=AsyncMock(return_value=row), commit=AsyncMock())
    result = asyncio.run(logout(Response(), create_refresh_token(owner, row.id), db))
    assert result.data is None
    assert row.revoked_at is not None
    db.commit.assert_awaited_once()
