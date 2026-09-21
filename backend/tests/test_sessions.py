import os
import uuid

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

from app.api.v1.sessions import current_session_id
from app.core.security import create_refresh_token


class StubUser:
    id = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456")
    token_version = 3


def test_current_session_id_reads_refresh_jti() -> None:
    session_id = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123457")
    token = create_refresh_token(StubUser(), session_id)  # type: ignore[arg-type]
    assert current_session_id(token) == session_id
    assert current_session_id("not-a-token") is None
    assert current_session_id(None) is None
