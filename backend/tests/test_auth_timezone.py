import os

import pytest
from pydantic import ValidationError

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

from app.api.v1.auth import RegisterRequest


def register_request(timezone: str) -> RegisterRequest:
    return RegisterRequest(
        email="person@example.com",
        password="correct-horse-battery-staple",
        timezone=timezone,
    )


def test_registration_accepts_iana_timezone() -> None:
    assert register_request("Asia/Shanghai").timezone == "Asia/Shanghai"
    assert register_request("America/New_York").timezone == "America/New_York"


def test_registration_normalizes_timezone_whitespace() -> None:
    assert register_request("  Asia/Shanghai  ").timezone == "Asia/Shanghai"


def test_registration_rejects_invalid_timezone() -> None:
    with pytest.raises(ValidationError) as captured:
        register_request("Shanghai")

    assert "必须是有效的 IANA 时区" in str(captured.value)


def test_registration_rejects_empty_timezone() -> None:
    with pytest.raises(ValidationError):
        register_request("   ")
