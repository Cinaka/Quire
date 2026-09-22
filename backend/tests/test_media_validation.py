import os

import pytest
from fastapi import HTTPException

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

from app.api.v1.media import detect_image_mime, validate_image_bytes


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
