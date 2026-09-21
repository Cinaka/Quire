import os
import uuid

import pytest
from fastapi import HTTPException

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)


class StubUser:
    id = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456")
    token_version = 3


def test_password_hash_round_trip() -> None:
    encoded = hash_password("correct horse battery staple")
    assert encoded != "correct horse battery staple"
    assert verify_password("correct horse battery staple", encoded)
    assert not verify_password("wrong password", encoded)


def test_access_and_refresh_types_are_distinct() -> None:
    user = StubUser()
    session_id = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123457")
    access = create_access_token(user)  # type: ignore[arg-type]
    refresh = create_refresh_token(user, session_id)  # type: ignore[arg-type]
    assert decode_token(access, "access")["tv"] == 3
    refresh_payload = decode_token(refresh, "refresh")
    assert refresh_payload["tv"] == 3
    assert refresh_payload["jti"] == str(session_id)
    with pytest.raises(HTTPException):
        decode_token(refresh, "access")


def test_refresh_tokens_get_unique_session_ids() -> None:
    user = StubUser()
    first = decode_token(create_refresh_token(user), "refresh")  # type: ignore[arg-type]
    second = decode_token(create_refresh_token(user), "refresh")  # type: ignore[arg-type]
    assert first["jti"] != second["jti"]
