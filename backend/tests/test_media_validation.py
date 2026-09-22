import os
import uuid

import pytest
from fastapi import HTTPException

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

from app.api.v1.media import detect_image_mime, stored_media_files_exist, validate_image_bytes
from app.core.config import settings
from app.models.media import Media


@pytest.mark.parametrize(
    ("data", "mime"),
    [
        (b"\xff\xd8\xff\xe0jpeg", "image/jpeg"),
        (b"\x89PNG\r\n\x1a\npng", "image/png"),
        (b"GIF89agif", "image/gif"),
        (b"RIFF\x04\x00\x00\x00WEBPwebp", "image/webp"),
    ],
)
def test_detect_image_mime_uses_file_signature(data: bytes, mime: str) -> None:
    assert detect_image_mime(data) == mime
    assert validate_image_bytes(data, mime) == mime


def test_validate_image_rejects_mime_mismatch() -> None:
    with pytest.raises(HTTPException) as caught:
        validate_image_bytes(b"\x89PNG\r\n\x1a\npng", "image/jpeg")
    assert caught.value.status_code == 422


def test_validate_image_rejects_empty_or_fake_content() -> None:
    with pytest.raises(HTTPException) as empty:
        validate_image_bytes(b"", "image/png")
    assert empty.value.status_code == 422

    with pytest.raises(HTTPException) as fake:
        validate_image_bytes(b"not-an-image", "image/png")
    assert fake.value.status_code == 422


def test_stored_media_requires_original_and_thumbnail(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    monkeypatch.setattr(settings, "MEDIA_PUBLIC_PREFIX", "/media")
    folder = tmp_path / "abcd"
    folder.mkdir()
    original = folder / "image.webp"
    thumbnail = folder / "image_thumb.webp"
    row = Media(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        entry_id=None,
        url="/media/abcd/image.webp",
        thumb_url="/media/abcd/image_thumb.webp",
    )

    assert stored_media_files_exist(row) is False
    original.write_bytes(b"original")
    assert stored_media_files_exist(row) is False
    thumbnail.write_bytes(b"thumbnail")
    assert stored_media_files_exist(row) is True
