"""Opt-in actual Axios -> loopback -> ASGI + JWT + SQLite contract; simulated frontend DB."""

import base64
import json
import os
import secrets
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from p4_resource_http_bridge import resource_http_bridge
from sqlalchemy import text
from test_schedule_resource_review import resource_fixture
from test_schedule_writes import ID, OTHER_USER_ID, USER_ID

from app.core.config import settings
from app.core.security import create_access_token, get_current_user
from app.main import app
from app.models.media import Media

# No user data, credentials, server migrations or installed dependency changes.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1s"
    "AAAAASUVORK5CYII="
)
ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(
    os.environ.get("QUIRE_P4_HTTP_CONTRACT") != "1",
    reason="opt-in test: QUIRE_P4_HTTP_CONTRACT=1; requires installed frontend Axios + TypeScript",
)


def add_fixture_auth_users(db):
    # Existing resource fixture has only users.id. Expand only its in-memory test table.
    columns = {
        "phone": "VARCHAR(20)", "email": "VARCHAR(128)", "password_hash": "VARCHAR(255)",
        "nickname": "VARCHAR(64)", "avatar": "VARCHAR(512)",
        "timezone": "VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai'",
        "token_version": "INTEGER NOT NULL DEFAULT 0",
        "created_at": "DATETIME", "updated_at": "DATETIME",
    }
    for name, shape in columns.items():
        db.session.execute(text(f"ALTER TABLE users ADD COLUMN {name} {shape}"))
    db.session.execute(text(
        "UPDATE users SET created_at='2026-10-08 10:00:00', updated_at='2026-10-08 10:00:00'"
    ))
    db.session.commit()


def backend_snapshot(db):
    return {
        table: db.session.execute(text(f"SELECT * FROM {table} ORDER BY 1")).all()
        for table in ("users", "schedules", "diary_entries", "media", "tags", "entry_tags")
    }


@pytest.mark.parametrize("scenario", ["roundtrip", "stale_image", "unknown_receipt"])
def test_actual_frontend_transport_and_backend_jwt_contract(scenario, tmp_path, monkeypatch):
    node = shutil.which("node")
    assert node, "Install/use the existing project Node runtime before running this opt-in test"
    monkeypatch.setattr(settings, "JWT_SECRET", secrets.token_urlsafe(48))
    with resource_fixture(
        tmp_path, monkeypatch, unknown_receipt=scenario == "unknown_receipt",
    ) as (client, db, path):
        add_fixture_auth_users(db)
        # Remove only auth override: actual security decodes JWT and queries temporary users.
        app.dependency_overrides.pop(get_current_user, None)
        path.write_bytes(PNG)
        thumbnail = path.with_name(f"{OTHER_USER_ID}_thumb.png")
        thumbnail.write_bytes(PNG)
        row = db.session.get(Media, OTHER_USER_ID)
        row.width, row.height, row.size = 1, 1, len(PNG)
        row.thumb_url = f"/media/{OTHER_USER_ID.hex[:4]}/{thumbnail.name}"
        db.session.commit()
        before = backend_snapshot(db)
        changed = False

        def before_image():
            nonlocal changed
            if scenario == "stale_image" and not changed:
                changed = True
                path.write_bytes(PNG[:-1] + bytes([PNG[-1] ^ 1]))

        with resource_http_bridge(client, str(ID), str(OTHER_USER_ID), before_image) as bridge:
            payload = {key: bridge[key] for key in ("origin", "nonce", "source_id", "media_id")}
            payload.update({
                "user_id": str(USER_ID), "scenario": scenario,
                "token": create_access_token(SimpleNamespace(id=USER_ID, token_version=0)),
                "other_token": create_access_token(
                    SimpleNamespace(id=OTHER_USER_ID, token_version=0),
                ),
            })
            # stdin only: never tokens in argv, environment, logs, snapshots or artifacts.
            try:
                result = subprocess.run(
                    [node, str(ROOT / "frontend/scripts/check-p4-resource-http.cjs")],
                    cwd=ROOT / "frontend", input=json.dumps(payload), text=True,
                    capture_output=True, timeout=60, check=False,
                )
            except subprocess.TimeoutExpired:
                pytest.fail("Isolated HTTP contract timed out; captured streams withheld")
            phases = (
                "configuration", "handshake", "backend-authentication", "frontend-transport",
                "resource-proof", "download-prepare", "confirmed-transaction",
                "persisted-bytes-and-protection",
            )
            phase = next((p for p in phases if f"failed at {p};" in result.stderr), "startup")
            assert result.returncode == 0, (
                f"Isolated HTTP contract failed at {phase}; streams withheld. Check installed "
                "frontend Axios/TypeScript and the contract guide; do not paste tokens."
            )
            assert json.loads(result.stdout) == {
                "scenario": scenario, "passed": True, "repaired": scenario == "roundtrip",
            }
            images = [record for record in bridge["records"] if record["image"]]
            if scenario == "roundtrip":
                assert len(images) == 2
                assert all(r["status"] == 200 and r["no_store"] and r["has_bytes"] for r in images)
            elif scenario == "stale_image":
                assert changed and len(images) == 1
                assert images[0] == {
                    "image": True, "status": 409, "no_store": True, "has_bytes": False,
                }
            else:
                assert images == []
        assert backend_snapshot(db) == before
        assert db.commits == db.flushes == 0
        assert thumbnail.read_bytes() == PNG
        assert path.read_bytes() == (PNG[:-1] + bytes([PNG[-1] ^ 1]) if changed else PNG)
