"""Real ASGI/JWT/SQLite and temporary-file checks; not MySQL lock integration."""

import os
import uuid
from types import SimpleNamespace

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core import abuse_middleware
from app.core.config import settings
from app.core.request_limits import AttemptLimiter
from app.core.security import create_access_token, decode_token
from app.db.session import get_db
from app.main import app
from app.models.media import Media

A = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456")
B = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123457")
ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123458")
OTHER = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123459")
PNG = b"\x89PNG\r\n\x1a\npublic-security-fixture"
URL = f"/api/v1/media/{ID}"


class AsyncTestSession:
    def __init__(self, session):
        self.session = session
        self.statements = []
        self.fail_flush = self.fail_commit = False

    async def scalar(self, statement):
        self.statements.append(statement)
        return self.session.scalar(statement)

    async def execute(self, statement):
        self.statements.append(statement)
        return self.session.execute(statement)

    def add(self, row):
        self.session.add(row)

    async def delete(self, row):
        self.session.delete(row)

    async def flush(self):
        if self.fail_flush:
            raise RuntimeError("test flush failure")
        self.session.flush()

    async def commit(self):
        if self.fail_commit:
            raise RuntimeError("test COMMIT acknowledgement failure")
        self.session.commit()

    async def rollback(self):
        self.session.rollback()

    async def refresh(self, row):
        self.session.refresh(row)


@pytest.fixture
def api(tmp_path, monkeypatch):
    # All state is temporary; real MySQL and deployment configuration are never used.
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    monkeypatch.setattr(settings, "MEDIA_DISK_RESERVE_BYTES", 1)
    monkeypatch.setattr(settings, "MEDIA_USER_MAX_BYTES", 524288000)
    monkeypatch.setattr(settings, "MEDIA_USER_MAX_COUNT", 1000)
    monkeypatch.setattr(settings, "REGISTER_IP_PER_HOUR", 5)
    monkeypatch.setattr(settings, "REGISTER_GLOBAL_PER_DAY", 100)
    monkeypatch.setattr(settings, "LOGIN_IP_PER_MINUTE", 30)
    monkeypatch.setattr(abuse_middleware, "attempt_limiter", AttemptLimiter())
    from app.api.v1 import media

    monkeypatch.setattr(media, "attempt_limiter", AttemptLimiter())
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    with engine.begin() as connection:
        connection.execute(text("""
            CREATE TABLE users (
                id CHAR(32) PRIMARY KEY, phone VARCHAR(20), email VARCHAR(128) UNIQUE,
                password_hash VARCHAR(255), nickname VARCHAR(64), avatar VARCHAR(512),
                timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
                token_version INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """))
        connection.execute(text("""
            CREATE TABLE media (
                id CHAR(32) PRIMARY KEY, user_id CHAR(32) NOT NULL, entry_id CHAR(32),
                url VARCHAR(512) NOT NULL, thumb_url VARCHAR(512),
                width INTEGER, height INTEGER, size BIGINT, sort_order INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """))
        # Registration also persists a real refresh session through issue_auth().
        # This is a temporary SQLite fixture, not a production schema migration.
        connection.execute(text("""
            CREATE TABLE refresh_sessions (
                id CHAR(32) PRIMARY KEY, user_id CHAR(32) NOT NULL,
                token_version INTEGER NOT NULL,
                expires_at DATETIME NOT NULL, revoked_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """))
        connection.execute(text("INSERT INTO users (id, email) VALUES (:id, :email)"), [
            {"id": A.hex, "email": "a@example.test"},
            {"id": B.hex, "email": "b@example.test"},
        ])
    previous = app.dependency_overrides.copy()
    try:
        with Session(engine) as session:
            db = AsyncTestSession(session)

            async def override_db():
                yield db

            app.dependency_overrides[get_db] = override_db
            # Deliberately no auth override: real JWT verification and User SELECT execute.
            def token(owner):
                return create_access_token(SimpleNamespace(id=owner, token_version=0))
            with TestClient(app, raise_server_exceptions=False) as client:
                yield SimpleNamespace(
                    client=client, db=db, root=tmp_path,
                    a={"Authorization": f"Bearer {token(A)}"},
                    b={"Authorization": f"Bearer {token(B)}"},
                )
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)
        engine.dispose()


def upload(api, *, ident=ID, headers=None, data=PNG, thumb=False, fields=None):
    files = {"file": ("public.png", data, "image/png")}
    if thumb:
        files["thumb"] = ("thumb.png", PNG, "image/png")
    return api.client.post(
        f"/api/v1/media/{ident}", headers=headers or api.a, files=files, data=fields or {},
    )


def original(api, ident=ID):
    return api.root / ident.hex[:4] / f"{ident.hex}.png"


def test_upload_owner_get_and_private_headers(api):
    response = upload(api, thumb=True)
    assert response.status_code == 200, response.text
    assert original(api).read_bytes() == PNG
    for variant in ("original", "thumbnail"):
        response = api.client.get(f"{URL}/{variant}", headers=api.a)
        assert response.status_code == 200 and response.content == PNG
        assert response.headers["cache-control"] == "private, no-store"
        assert response.headers["vary"] == "Authorization"


def test_no_token_invalid_token_and_foreign_user_cannot_read(api):
    assert upload(api).status_code == 200
    for headers, expected in (({}, 401), ({"Authorization": "Bearer bad"}, 401), (api.b, 404)):
        response = api.client.get(f"{URL}/original", headers=headers)
        assert response.status_code == expected
        assert response.headers["cache-control"] == "private, no-store"
        assert PNG not in response.content


def test_direct_legacy_media_path_never_serves_file(api):
    assert upload(api).status_code == 200
    for url in ("/media", f"/media/{ID.hex[:4]}/{ID}.png"):
        response = api.client.get(url, headers=api.a)
        assert response.status_code == 404 and PNG not in response.content


def test_cross_user_same_id_upload_leaves_bytes_and_owner_unchanged(api):
    assert upload(api).status_code == 200
    response = upload(api, headers=api.b, data=PNG + b"foreign")
    assert response.status_code == 404
    assert original(api).read_bytes() == PNG
    assert api.db.session.get(Media, ID).user_id == A


def test_complete_same_owner_retry_does_not_overwrite(api):
    assert upload(api).status_code == 200
    assert upload(api, data=PNG + b"different").status_code == 200
    assert original(api).read_bytes() == PNG


def test_partial_repair_cannot_replace_existing_original(api):
    assert upload(api, thumb=True).status_code == 200
    (api.root / ID.hex[:4] / f"{ID.hex}_thumb.png").unlink()
    assert upload(api, data=PNG + b"different", thumb=True).status_code == 409
    assert original(api).read_bytes() == PNG


def test_account_quota_counts_physical_thumbnail_and_ignores_client_size(api, monkeypatch):
    assert upload(api, thumb=True).status_code == 200
    api.db.session.get(Media, ID).size = -999999
    api.db.session.commit()
    monkeypatch.setattr(settings, "MEDIA_USER_MAX_BYTES", len(PNG) * 2)
    response = upload(api, ident=OTHER)
    assert response.status_code == 413
    assert not original(api, OTHER).exists()


def test_account_count_limit(api, monkeypatch):
    assert upload(api).status_code == 200
    monkeypatch.setattr(settings, "MEDIA_USER_MAX_COUNT", 1)
    assert upload(api, ident=OTHER).status_code == 413
    assert not original(api, OTHER).exists()


def test_flush_failure_cleans_only_new_files(api):
    api.db.fail_flush = True
    assert upload(api).status_code == 500
    assert not original(api).exists()
    assert api.db.session.get(Media, ID) is None


def test_uncertain_commit_returns_error_but_retains_possible_committed_bytes(api):
    api.db.fail_commit = True
    response = upload(api)
    assert response.status_code == 503 and "未确认" in response.json()["message"]
    assert original(api).read_bytes() == PNG


def test_lock_statements_compile_as_current_mysql_reads(api):
    assert upload(api).status_code == 200
    sql = [str(s.compile(dialect=mysql.dialect())) for s in api.db.statements]
    assert any("users.id" in s and "FOR UPDATE" in s for s in sql)
    assert any("media.user_id" in s and "FOR UPDATE" in s for s in sql)


def test_request_limits_cover_registration_before_password_hash(api, monkeypatch):
    from app.api.v1 import auth

    calls = []
    monkeypatch.setattr(auth, "hash_password", lambda value: calls.append(value) or "test-hash")
    monkeypatch.setattr(settings, "REGISTER_IP_PER_HOUR", 1)
    body = {"email": "first@example.test", "password": "test-password"}
    first = api.client.post("/api/v1/auth/register", json=body)
    assert first.status_code == 200
    assert auth.REFRESH_COOKIE in first.cookies
    assert api.db.session.scalar(text("SELECT COUNT(*) FROM refresh_sessions")) == 1
    assert api.db.session.scalar(text("SELECT COUNT(*) FROM users")) == 3
    response = api.client.post("/api/v1/auth/register", json=body)
    assert response.status_code == 429 and len(calls) == 1
    assert response.headers["retry-after"]
    assert response.json()["code"] == 429
    assert api.db.session.scalar(text("SELECT COUNT(*) FROM refresh_sessions")) == 1
    assert api.db.session.scalar(text("SELECT COUNT(*) FROM users")) == 3


def test_login_attempts_limited_even_before_account_lookup(api, monkeypatch):
    monkeypatch.setattr(settings, "LOGIN_IP_PER_MINUTE", 1)
    body = {"email": "unknown@example.test", "password": "test-password"}
    assert api.client.post("/api/v1/auth/login", json=body).status_code == 401
    response = api.client.post("/api/v1/auth/login", json=body)
    assert response.status_code == 429 and response.headers["retry-after"]


def test_upload_attempts_limited_before_multipart_body(api, monkeypatch):
    monkeypatch.setattr(settings, "UPLOAD_IP_PER_MINUTE", 1)
    assert upload(api).status_code == 200
    assert upload(api, ident=OTHER).status_code == 429
    assert not original(api, OTHER).exists()


def test_symlink_in_complete_record_is_not_accepted_as_safe_upload(api):
    assert upload(api).status_code == 200
    target = api.root / "private-target"
    target.write_bytes(PNG)
    original(api).unlink()
    original(api).symlink_to(target)
    assert upload(api).status_code == 503
    assert target.read_bytes() == PNG
    assert api.client.get(f"{URL}/original", headers=api.a).status_code == 404


def test_fixture_covers_models_used_by_registration(api):
    from app.models.refresh_session import RefreshSession
    from app.models.user import User

    for model in (User, Media, RefreshSession):
        table = model.__tablename__
        columns = {row[1] for row in api.db.session.execute(text(f"PRAGMA table_info({table})"))}
        assert set(model.__table__.columns.keys()) <= columns


def test_real_jwt_subject_matches_text_uuid_seed(api):
    token = api.a["Authorization"].removeprefix("Bearer ")
    assert decode_token(token, "access")["sub"] == A.hex
    row = api.db.session.execute(text(
        "SELECT id, typeof(id), length(id) FROM users WHERE id = :id"
    ), {"id": A.hex}).one()
    assert tuple(row) == (A.hex, "text", 32)
    response = upload(api)
    assert response.status_code == 200, response.text
    media = api.db.session.execute(text(
        "SELECT id, user_id, typeof(id), typeof(user_id) FROM media WHERE id = :id"
    ), {"id": ID.hex}).one()
    assert tuple(media) == (ID.hex, A.hex, "text", "text")


@pytest.mark.parametrize("remove_user", [False, True])
def test_real_jwt_rejects_revoked_version_or_missing_user(api, remove_user):
    statement = (
        "DELETE FROM users WHERE id = :id" if remove_user else
        "UPDATE users SET token_version = token_version + 1 WHERE id = :id"
    )
    api.db.session.execute(text(statement), {"id": A.hex})
    api.db.session.commit()
    response = upload(api)
    assert response.status_code == 401, response.text
    assert response.json()["message"] == "登录已失效"
    assert api.db.session.get(Media, ID) is None
    assert not original(api).exists()


@pytest.mark.parametrize("spelling", [ID.hex, str(ID), ID.hex.upper(), str(ID).upper()])
def test_media_uuid32_upload_list_read_and_delete_aliases(api, spelling):
    response = upload(api, ident=spelling, thumb=True, fields={"entry_id": str(OTHER).upper()})
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["id"] == ID.hex and data["entry_id"] == OTHER.hex
    assert data["url"].endswith(f"/{ID.hex}.png")
    assert data["thumb_url"].endswith(f"/{ID.hex}_thumb.png")
    assert original(api).read_bytes() == PNG
    assert not (api.root / ID.hex[:4] / f"{ID}.png").exists()
    listing = api.client.get(
        "/api/v1/media", params={"entry_id": str(OTHER)}, headers=api.a,
    )
    assert listing.status_code == 200, listing.text
    assert [row["id"] for row in listing.json()["data"]] == [ID.hex]
    for variant in ["original", "thumbnail"]:
        result = api.client.get(f"/api/v1/media/{spelling}/{variant}", headers=api.a)
        assert result.status_code == 200 and result.content == PNG
    response = api.client.delete(f"/api/v1/media/{spelling}", headers=api.a)
    assert response.status_code == 200, response.text
    assert api.db.session.get(Media, ID) is None
    assert not original(api).exists()
    assert not (api.root / ID.hex[:4] / f"{ID.hex}_thumb.png").exists()


@pytest.mark.parametrize("value", ["urn:uuid:" + str(ID), "{" + str(ID) + "}",
                                   " " + ID.hex, ID.hex + " ", "bad"])
def test_media_rejects_non_exact_uuid_inputs_without_writes(api, value):
    response = upload(api, ident=value)
    assert response.status_code == 422, response.text
    response = upload(api, fields={"entry_id": value})
    assert response.status_code == 422, response.text
    response = api.client.get("/api/v1/media", params={"entry_id": value}, headers=api.a)
    assert response.status_code == 422, response.text
    response = api.client.get(f"/api/v1/media/{value}/original", headers=api.a)
    assert response.status_code == 422, response.text
    response = api.client.delete(f"/api/v1/media/{value}", headers=api.a)
    assert response.status_code == 422, response.text
    assert api.db.session.get(Media, ID) is None
    assert not original(api).exists()


@pytest.mark.parametrize("repair", [False, True])
def test_legacy_media_paths_remain_readable_and_retry_keeps_exact_paths(api, repair):
    from datetime import datetime, timezone

    folder = api.root / ID.hex[:4]
    folder.mkdir()
    old_original = folder / f"{ID}.png"
    old_thumbnail = folder / f"{ID}_thumb.png"
    old_original.write_bytes(PNG)
    if not repair:
        old_thumbnail.write_bytes(PNG)
    row = Media(
        id=ID, user_id=A, entry_id=OTHER, sort_order=0, size=len(PNG),
        url=f"/media/{ID.hex[:4]}/{ID}.png",
        thumb_url=f"/media/{ID.hex[:4]}/{ID}_thumb.png",
        created_at=datetime.now(timezone.utc).replace(tzinfo=None),
    )
    api.db.session.add(row)
    api.db.session.commit()
    response = upload(api, ident=ID.hex, thumb=True)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["id"] == ID.hex
    assert data["url"].endswith(f"/{ID}.png")
    assert data["thumb_url"].endswith(f"/{ID}_thumb.png")
    assert old_original.read_bytes() == old_thumbnail.read_bytes() == PNG
    assert not original(api).exists()
    for variant in ["original", "thumbnail"]:
        result = api.client.get(f"/api/v1/media/{ID.hex}/{variant}", headers=api.a)
        assert result.status_code == 200 and result.content == PNG
