"""Active ORM mapping and insert/query tests; no production database connection."""

import re
import uuid

from sqlalchemy import Column, MetaData, Table, create_engine, select, text
from sqlalchemy.dialects import mysql

import app.models  # noqa: F401 -- register all eight business models
from app.core.ids import new_id, new_id_hex
from app.core.uuid_storage_plan import UUID_COLUMNS
from app.db.base import Base, UUIDBinary
from app.db.uuid_hex import UUIDHexText


def test_all_eighteen_business_uuid_columns_use_hex_storage():
    expected = {(table, column) for table, names in UUID_COLUMNS.items() for column in names}
    actual = {(table.name, column.name)
              for table in Base.metadata.tables.values() for column in table.columns
              if isinstance(column.type, UUIDHexText)}
    assert actual == expected
    assert not any(isinstance(column.type, UUIDBinary)
                   for table in Base.metadata.tables.values() for column in table.columns)
    for table, column in expected:
        ddl = str(Base.metadata.tables[table].c[column].type.compile(dialect=mysql.dialect()))
        assert "CHAR(32)" in ddl and "ascii" in ddl and "ascii_bin" in ddl


def test_server_generated_ids_remain_uuid_v7():
    for _ in range(20):
        value = new_id()
        assert isinstance(value, uuid.UUID)
        assert value.version == 7 and value.variant == uuid.RFC_4122
        encoded = new_id_hex()
        assert re.fullmatch(r"[0-9a-f]{32}", encoded)
        assert uuid.UUID(hex=encoded).version == 7


def test_new_insert_stores_plain_hex_and_can_query_both_uuid_forms():
    engine = create_engine("sqlite:///:memory:")
    table = Table("uuid32_insert_probe", MetaData(),
                  Column("id", UUIDHexText(), primary_key=True),
                  Column("user_id", UUIDHexText(), nullable=False),
                  Column("entry_id", UUIDHexText(), nullable=True))
    table.metadata.create_all(engine)
    identifier = new_id()
    owner = new_id()
    try:
        with engine.begin() as connection:
            connection.execute(table.insert().values(id=identifier, user_id=owner, entry_id=None))
            raw = connection.execute(text("SELECT id, user_id, entry_id FROM uuid32_insert_probe"))
            assert raw.one() == (identifier.hex, owner.hex, None)
            for key in (identifier, identifier.hex, str(identifier)):
                row = connection.execute(select(table).where(table.c.id == key)).one()
                assert row.id == identifier and row.user_id == owner and row.entry_id is None
    finally:
        engine.dispose()
