import asyncio
import os
import uuid
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

from app.api.v1.sync import SyncMedia, push_media
from app.core.config import settings
from app.core.media_storage import media_disk_paths, remove_media_paths
from app.models.media import Media

USER_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456")
ENTRY_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123457")
MEDIA_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123458")


def media_payload(entry_id: uuid.UUID | None) -> SyncMedia:
    return SyncMedia(
        id=MEDIA_ID,
        entry_id=entry_id,
        sort_order=1,
        width=800,
        height=600,
        size=1234,
        mime="image/webp",
        created_at=datetime(2026, 9, 22, 0, 0),
    )


def test_sync_media_accepts_null_entry_id() -> None:
    assert media_payload(None).entry_id is None


def test_remove_media_paths_deletes_original_and_thumbnail(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    monkeypatch.setattr(settings, "MEDIA_PUBLIC_PREFIX", "/media")
    folder = tmp_path / str(USER_ID)
    folder.mkdir()
    original = folder / "image.webp"
    thumbnail = folder / "image.thumb.webp"
    original.write_bytes(b"original")
    thumbnail.write_bytes(b"thumbnail")

    paths = media_disk_paths(
        f"/media/{USER_ID}/image.webp",
        f"/media/{USER_ID}/image.thumb.webp",
    )
    remove_media_paths(paths)

    assert not original.exists()
    assert not thumbnail.exists()


def test_push_media_unlink_defers_files_until_after_commit(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    monkeypatch.setattr(settings, "MEDIA_PUBLIC_PREFIX", "/media")
    folder = tmp_path / str(USER_ID)
    folder.mkdir()
    original = folder / "image.webp"
    thumbnail = folder / "image.thumb.webp"
    original.write_bytes(b"original")
    thumbnail.write_bytes(b"thumbnail")
    row = Media(
        id=MEDIA_ID,
        user_id=USER_ID,
        entry_id=ENTRY_ID,
        url=f"/media/{USER_ID}/image.webp",
        thumb_url=f"/media/{USER_ID}/image.thumb.webp",
    )
    db = SimpleNamespace(
        scalar=AsyncMock(return_value=row),
        delete=AsyncMock(),
        execute=AsyncMock(),
    )
    user = SimpleNamespace(id=USER_ID)

    result, paths = asyncio.run(push_media(db, user, media_payload(None)))

    assert result == {"id": str(MEDIA_ID), "status": "applied"}
    db.delete.assert_awaited_once_with(row)
    db.execute.assert_awaited_once()
    assert original.exists()
    assert thumbnail.exists()

    remove_media_paths(paths)
    assert not original.exists()
    assert not thumbnail.exists()


def test_push_unknown_orphan_is_idempotent() -> None:
    db = SimpleNamespace(
        scalar=AsyncMock(return_value=None),
        delete=AsyncMock(),
        execute=AsyncMock(),
        add=MagicMock(),
    )
    user = SimpleNamespace(id=USER_ID)

    first, first_paths = asyncio.run(push_media(db, user, media_payload(None)))
    second, second_paths = asyncio.run(push_media(db, user, media_payload(None)))

    assert first["status"] == "applied"
    assert second["status"] == "applied"
    assert first_paths == []
    assert second_paths == []
    db.delete.assert_not_awaited()
    db.execute.assert_not_awaited()
    db.add.assert_not_called()


def test_media_path_mapping_rejects_paths_outside_public_prefix(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    monkeypatch.setattr(settings, "MEDIA_PUBLIC_PREFIX", "/media")

    assert media_disk_paths("/other/file.webp", "/media/../../outside.webp") == []
