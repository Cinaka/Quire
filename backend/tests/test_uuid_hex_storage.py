"""Target UUID32 adapters only; application models remain on UUIDBinary until cutover."""

import json
import uuid

import pytest
from pydantic import BaseModel, ValidationError
from sqlalchemy import Column, MetaData, Table
from sqlalchemy.dialects import mysql, sqlite
from sqlalchemy.schema import CreateTable

from app.db.uuid_hex import UUIDHexText
from app.schemas.uuid_hex import UUIDHex

TEXT = "01a01dfa-6c0a-72a6-a7f5-76323ee01718"
HEX = "01a01dfa6c0a72a6a7f576323ee01718"


class Payload(BaseModel):
    id: UUIDHex


def test_mysql_storage_is_ascii_char32():
    table = Table("uuid32_probe", MetaData(), Column("id", UUIDHexText(), primary_key=True))
    ddl = str(CreateTable(table).compile(dialect=mysql.dialect()))
    assert "CHAR(32)" in ddl and "ascii" in ddl and "ascii_bin" in ddl


def test_database_adapter_keeps_python_uuid_but_stores_hex():
    kind = UUIDHexText()
    for value in (TEXT, HEX, uuid.UUID(TEXT)):
        assert kind.process_bind_param(value, mysql.dialect()) == HEX
    assert kind.process_result_value(HEX, mysql.dialect()) == uuid.UUID(TEXT)
    assert kind.process_bind_param(None, sqlite.dialect()) is None
    assert kind.process_result_value(None, sqlite.dialect()) is None


def test_storage_rejects_noncanonical_data():
    for value in (TEXT, HEX.upper(), "x" * 32, uuid.UUID(TEXT).bytes):
        with pytest.raises(ValueError):
            UUIDHexText().process_result_value(value, mysql.dialect())


def test_json_output_is_hex32_for_both_input_forms():
    for value in (TEXT, HEX):
        payload = Payload(id=value)
        assert payload.id == uuid.UUID(TEXT)
        assert json.loads(payload.model_dump_json()) == {"id": HEX}


def test_json_schema_and_validation_are_explicit():
    shape = Payload.model_json_schema(mode="serialization")["properties"]["id"]
    assert shape["pattern"] == "^[0-9a-f]{32}$"
    with pytest.raises(ValidationError):
        Payload(id="urn:uuid:" + TEXT)
