"""The JSON error envelope must preserve HTTP exception response headers."""

import asyncio
import json

import pytest
from fastapi import HTTPException

from app.main import http_exc_handler


@pytest.mark.parametrize("status,headers", [
    (409, {"Cache-Control": "no-store", "Pragma": "no-cache"}),
    (401, {"WWW-Authenticate": "Bearer"}),
    (404, None),
])
def test_http_error_envelope_preserves_headers(status, headers):
    exc = HTTPException(status_code=status, detail="expected error", headers=headers)
    response = asyncio.run(http_exc_handler(None, exc))
    assert response.status_code == status
    assert json.loads(response.body) == {
        "code": status, "message": "expected error", "data": None,
    }
    for name, value in (headers or {}).items():
        assert response.headers[name] == value
    assert response.headers["content-type"] == "application/json"
    assert exc.headers == headers
