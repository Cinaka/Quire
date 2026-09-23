import asyncio
import os
import uuid
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

from app.core.config import settings
from app.models.media import Media
from app.services.tombstone_cleanup import purge_expired_tombstones

ENTRY_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123457")
MEDIA_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123458")
USER_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456")


class ScalarRows:
    def __init__(self, rows):
        self.rows = rows

    def all(self):
        return self.rows


def test_empty_tombstone_batch_is_a_noop() -> None:
    db = SimpleNamespace(
        scalars=AsyncMock(return_value=ScalarRows([])),
        execute=AsyncMock(),
        commit=AsyncMock(),
    )

    result = asyncio.run(purge_expired_tombstones(db))

    assert result.entries == 0
    assert result.media == 0
    db.execute.assert_not_awaited()
    db.commit.assert_not_awaited()


def test_tombstone_files_are_removed_only_after_commit(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    monkeypatch.setattr(settings, "MEDIA_PUBLIC_PREFIX", "/media")
    folder = tmp_path / "abcd"
    folder.mkdir()
    original = folder / "image.webp"
    thumbnail = folder / "image_thumb.webp"
    original.write_bytes(b"original")
    thumbnail.write_bytes(b"thumbnail")
    media = Media(
        id=MEDIA_ID,
        user_id=USER_ID,
        entry_id=ENTRY_ID,
        url="/media/abcd/image.webp",
        thumb_url="/media/abcd/image_thumb.webp",
    )

    async def commit() -> None:
        assert original.exists()
        assert thumbnail.exists()

    db = SimpleNamespace(
        scalars=AsyncMock(side_effect=[ScalarRows([ENTRY_ID]), ScalarRows([media])]),
        execute=AsyncMock(),
        commit=AsyncMock(side_effect=commit),
    )

    result = asyncio.run(
        purge_expired_tombstones(
            db,
            retention_days=180,
            batch_size=10,
            now=datetime(2026, 9, 23, 0, 0),
        )
    )

    assert result.entries == 1
    assert result.media == 1
    assert db.execute.await_count == 3
    db.commit.assert_awaited_once()
    assert not original.exists()
    assert not thumbnail.exists()
