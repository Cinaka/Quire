"""Opt-in storage rehearsal in an EMPTY, DISPOSABLE MySQL test database ONLY.

Not an application/Alembic/backup/IndexedDB migration acceptance test.
The configured schema must be named quire_uuid32_test_<suffix>. Never point this
at a local development database containing data, staging or production.
"""

import asyncio
import json
import os
import re
import uuid
from datetime import datetime

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.uuid_storage_plan import UUID_COLUMNS, build_storage_plan, quoted
from app.db.uuid_storage_inspection import inspect_uuid_storage

TEST_URL = os.environ.get("QUIRE_TEST_UUID32_MYSQL_URL")
pytestmark = pytest.mark.skipif(
    not TEST_URL, reason="opt-in: empty disposable quire_uuid32_test_* MySQL database required",
)
NULLABLE = {
    ("diary_entries", "from_schedule_id"), ("media", "entry_id"),
    ("schedules", "converted_entry_id"),
}
STAMP = datetime(2020, 1, 2, 3, 4, 5, 123000)


def table_ddl(table):
    parts = [
        f"{quoted(name)} BINARY(16) "
        + ("NULL" if (table, name) in NULLABLE else "NOT NULL")
        for name in UUID_COLUMNS[table]
    ]
    primary = "`entry_id`, `tag_id`" if table == "entry_tags" else "`id`"
    parts += [
        f"PRIMARY KEY ({primary})",
        "`updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) "
        "ON UPDATE CURRENT_TIMESTAMP(3)",
        "`payload` JSON NULL",
    ]
    if "user_id" in UUID_COLUMNS[table]:
        parts.append("INDEX idx_owner (`user_id`, `updated_at`)")
    if table == "diary_entries":
        parts.append("UNIQUE KEY uk_from_schedule (`from_schedule_id`)")
    if table == "schedules":
        parts += [
            "`status` TINYINT NOT NULL DEFAULT 0",
            "`converted_at` DATETIME(3) NULL",
            "UNIQUE KEY uk_schedule_converted_entry (`converted_entry_id`)",
            "CONSTRAINT ck_schedule_status CHECK (`status` IN (0, 1))",
            "CONSTRAINT ck_schedule_conversion CHECK ("
            "(`status` = 0 AND `converted_entry_id` IS NULL AND `converted_at` IS NULL) OR "
            "(`status` = 1 AND `converted_entry_id` IS NOT NULL "
            "AND `converted_entry_id` = `id` AND `converted_at` IS NOT NULL))",
        ]
    return f"CREATE TABLE {quoted(table)} (" + ", ".join(parts) + ") ENGINE=InnoDB"


def fixtures():
    user, entry, pending, tag, media, refresh, checkin = [uuid.UUID(value).bytes for value in (
        "01a0c67c515a76618dae30dc09147cd6", "01a01dfa6c0a72a6a7f576323ee01718",
        "01a01e0ef90574aa894eff02c02fd000", "01a01e1f7ca871989103f7613da26b83",
        "01a0221c95ad753ea8f712b5075a909e", "550e8400e29b41d4a716446655440000",
        "01a0222468cb7619a249aba91cff5ba6",
    )]
    return {
        "users": [{"id": user}],
        "diary_entries": [
            {"id": entry, "user_id": user, "from_schedule_id": entry},
            {"id": pending, "user_id": user, "from_schedule_id": None},
        ],
        "tags": [{"id": tag, "user_id": user}],
        "media": [{"id": media, "user_id": user, "entry_id": None}],
        "entry_tags": [{"entry_id": entry, "tag_id": tag},
                       {"entry_id": pending, "tag_id": tag}],
        "refresh_sessions": [{"id": refresh, "user_id": user}],
        "checkins": [{"id": checkin, "user_id": user}],
        "schedules": [
            {"id": entry, "user_id": user, "converted_entry_id": entry,
             "status": 1, "converted_at": STAMP},
            {"id": pending, "user_id": user, "converted_entry_id": None,
             "status": 0, "converted_at": None},
        ],
    }


async def snapshot(connection, binary):
    result = {}
    for table, names in UUID_COLUMNS.items():
        fields = [f"LOWER(HEX({quoted(name)}))" if binary else quoted(name) for name in names]
        # JSON content must NOT undergo an indiscriminate UUID-looking text replacement.
        sql = (f"SELECT {', '.join(fields)}, `updated_at`, `payload` "
               f"FROM {quoted(table)} ORDER BY "
               + ", ".join(str(index + 1) for index in range(len(names))))
        result[table] = tuple(tuple(row) for row in await connection.execute(text(sql)))
    return result


async def constraints_and_indexes(connection):
    checks = tuple(tuple(row) for row in await connection.execute(text("""
        SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME
    """)))
    indexes = tuple(tuple(row) for row in await connection.execute(text("""
        SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
    """)))
    return checks, indexes


async def run_rehearsal():
    try:
        url = make_url(TEST_URL)
    except Exception:
        raise AssertionError("Invalid disposable MySQL test URL") from None
    if url.drivername != "mysql+asyncmy":
        raise AssertionError("Use the installed mysql+asyncmy test driver")
    if not re.fullmatch(r"quire_uuid32_test_[a-z0-9_]+", url.database or ""):
        raise AssertionError("Refusing non-disposable database name")
    engine = create_async_engine(url, echo=False)
    try:
        async with engine.connect() as connection:
            lock = (await connection.execute(text(
                "SELECT GET_LOCK('quire_uuid32_disposable_rehearsal', 0)",
            ))).scalar_one()
            if lock != 1:
                raise AssertionError("Another disposable UUID32 rehearsal is running")
            created = []
            try:
                existing = (await connection.execute(text("""
                    SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
                """))).scalar_one()
                if existing != 0:
                    raise AssertionError("Refusing to modify a non-empty test schema")
                for table in UUID_COLUMNS:
                    await connection.execute(text(table_ddl(table)))
                    created.append(table)
                for table, rows in fixtures().items():
                    for row in rows:
                        values = {**row, "updated_at": STAMP,
                                  "payload": json.dumps({"note": "UUID-like text is not an ID: "
                                                        "01a01dfa-6c0a-72a6-a7f5-76323ee01718"})}
                        names = list(values)
                        sql = (f"INSERT INTO {quoted(table)} ("
                               + ", ".join(quoted(name) for name in names) + ") VALUES ("
                               + ", ".join(f":p{index}" for index in range(len(names))) + ")")
                        await connection.execute(text(sql), {
                            f"p{index}": values[name] for index, name in enumerate(names)
                        })
                await connection.commit()
                before = await snapshot(connection, binary=True)
                protections = await constraints_and_indexes(connection)
                state = await connection.run_sync(inspect_uuid_storage)
                upgrade = build_storage_plan(state)
                for statement in upgrade.statements:
                    await connection.execute(text(statement.sql))
                await connection.commit()
                assert await snapshot(connection, binary=False) == before
                assert await constraints_and_indexes(connection) == protections
                state = await connection.run_sync(inspect_uuid_storage)
                for column in state.columns:
                    if column.name in UUID_COLUMNS[column.table]:
                        assert (column.data_type, column.length,
                                column.charset, column.collation) == (
                            "char", 32, "ascii", "ascii_bin",
                        )
                        invalid = (await connection.execute(text(
                            f"SELECT COUNT(*) FROM {quoted(column.table)} "
                            f"WHERE {quoted(column.name)} IS NOT NULL AND NOT REGEXP_LIKE("
                            f"{quoted(column.name)}, '^[0-9a-f]{{32}}$', 'c')",
                        ))).scalar_one()
                        assert invalid == 0
                for statement in build_storage_plan(state, "downgrade").statements:
                    await connection.execute(text(statement.sql))
                await connection.commit()
                assert await snapshot(connection, binary=True) == before
                assert await constraints_and_indexes(connection) == protections
                state = await connection.run_sync(inspect_uuid_storage)
                assert all(column.data_type == "binary" and column.length == 16
                           for column in state.columns
                           if column.name in UUID_COLUMNS[column.table])
            finally:
                # Only tables successfully CREATED BY THIS TEST are dropped. No DROP DATABASE.
                await connection.rollback()
                for table in reversed(created):
                    await connection.execute(text(f"DROP TABLE {quoted(table)}"))
                await connection.execute(text(
                    "SELECT RELEASE_LOCK('quire_uuid32_disposable_rehearsal')",
                ))
                await connection.commit()
    finally:
        await engine.dispose()


def test_mysql_storage_upgrade_and_downgrade_preserve_identity_and_watermarks():
    asyncio.run(run_rehearsal())


async def run_empty_cutover_rehearsal():
    import importlib.util
    from pathlib import Path

    from sqlalchemy import Column, MetaData, Table, select

    from app.db.uuid_hex import UUIDHexText

    try:
        url = make_url(TEST_URL)
    except Exception:
        raise AssertionError("Invalid disposable MySQL test URL") from None
    if (url.drivername != "mysql+asyncmy"
            or not re.fullmatch(r"quire_uuid32_test_[a-z0-9_]+", url.database or "")):
        raise AssertionError("Refusing non-disposable MySQL database")
    path = (Path(__file__).resolve().parents[1] / "alembic/versions"
            / "20261026_uuid32_empty_database.py")
    spec = importlib.util.spec_from_file_location("quire_empty_cutover_rehearsal", path)
    revision = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(revision)
    engine = create_async_engine(url, echo=False)
    try:
        async with engine.connect() as connection:
            lock = (await connection.execute(text(
                "SELECT GET_LOCK('quire_uuid32_disposable_rehearsal', 0)",
            ))).scalar_one()
            if lock != 1:
                raise AssertionError("Another disposable UUID32 rehearsal is running")
            created = []
            try:
                existing = (await connection.execute(text("""
                    SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
                """))).scalar_one()
                if existing != 0:
                    raise AssertionError("Refusing to modify a non-empty test schema")
                for table in UUID_COLUMNS:
                    await connection.execute(text(table_ddl(table)))
                    created.append(table)
                await connection.run_sync(lambda sync: revision._run(sync, "upgrade"))
                state = await connection.run_sync(inspect_uuid_storage)
                assert all(column.data_type == "char" and column.length == 32
                           and column.charset == "ascii" and column.collation == "ascii_bin"
                           for column in state.columns
                           if column.name in UUID_COLUMNS[column.table])
                probe = Table("users", MetaData(),
                              Column("id", UUIDHexText(), primary_key=True))
                identifier = uuid.UUID("01a0c67c515a76618dae30dc09147cd6")
                await connection.execute(probe.insert().values(id=identifier))
                await connection.commit()
                assert (await connection.execute(text("SELECT id FROM users"))).scalar_one() == (
                    identifier.hex
                )
                for key in (identifier, identifier.hex, str(identifier)):
                    assert (await connection.execute(
                        select(probe.c.id).where(probe.c.id == key),
                    )).scalar_one() == identifier
                # Any business rows must block both retry and downgrade before any ALTER.
                for direction in ("upgrade", "downgrade"):
                    with pytest.raises(RuntimeError, match="ALL eight business tables"):
                        await connection.run_sync(lambda sync, step=direction: (
                            revision._run(sync, step)
                        ))
                # This DELETE affects only the row created by this disposable test.
                await connection.execute(text("DELETE FROM users"))
                await connection.commit()
                await connection.run_sync(lambda sync: revision._run(sync, "downgrade"))
                state = await connection.run_sync(inspect_uuid_storage)
                assert all(column.data_type == "binary" and column.length == 16
                           for column in state.columns
                           if column.name in UUID_COLUMNS[column.table])
            finally:
                await connection.rollback()
                for table in reversed(created):
                    await connection.execute(text(f"DROP TABLE {quoted(table)}"))
                await connection.execute(text(
                    "SELECT RELEASE_LOCK('quire_uuid32_disposable_rehearsal')",
                ))
                await connection.commit()
    finally:
        await engine.dispose()


def test_empty_cutover_then_new_insert_stores_hex32(monkeypatch):
    monkeypatch.setenv("QUIRE_UUID32_EMPTY_DB_ACK", "1")
    asyncio.run(run_empty_cutover_rehearsal())
