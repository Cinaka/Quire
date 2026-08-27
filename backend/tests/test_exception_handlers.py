import os

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel, field_validator

from app.main import app


class ValidationBody(BaseModel):
    value: str

    @field_validator("value")
    @classmethod
    def reject_bad(cls, value: str) -> str:
        if value == "bad":
            raise ValueError("bad value")
        return value


@app.get("/_test/http-exception")
async def raise_http_route():
    raise HTTPException(status_code=409, detail="conflict")


@app.post("/_test/validation-exception")
async def raise_validation_route(_: ValidationBody):
    return {"ok": True}


@app.get("/_test/runtime-exception")
async def raise_runtime_route():
    raise RuntimeError("boom")


client = TestClient(app, raise_server_exceptions=False)


def assert_shape(response, status: int) -> None:
    assert response.status_code == status
    assert set(response.json()) == {"code", "message", "data"}
    assert response.json()["code"] == status


def test_global_exception_shapes() -> None:
    assert_shape(client.get("/_test/missing"), 404)
    assert_shape(client.get("/_test/http-exception"), 409)
    assert_shape(
        client.post("/_test/validation-exception", json={"value": "bad"}),
        422,
    )
    assert_shape(client.get("/_test/runtime-exception"), 500)
