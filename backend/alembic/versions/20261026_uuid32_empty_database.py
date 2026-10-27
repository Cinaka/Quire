"""Switch an EMPTY database from binary UUIDs to lowercase hex32 storage.

Revision ID: uuid32_empty_v1
Revises: p4_convert_receipts

Frozen/self-contained: no imports from mutable app helpers. This is NOT a
legacy-data migration. Stop all writers; set QUIRE_UUID32_EMPTY_DB_ACK=1 only
for the migration invocation. Reject any business rows, including on downgrade.
MySQL DDL commits implicitly; empty partial conversions may be safely retried.
"""

import hashlib
import os
import re

revision = "uuid32_empty_v1"
down_revision = "p4_convert_receipts"
branch_labels = None
depends_on = None

# Freeze the inventory in this revision. Do not import current ORM metadata.
UUID_COLUMNS = {
    "users": ("id",),
    "diary_entries": ("id", "user_id", "from_schedule_id"),
    "tags": ("id", "user_id"),
    "media": ("id", "user_id", "entry_id"),
    "entry_tags": ("entry_id", "tag_id"),
    "refresh_sessions": ("id", "user_id"),
    "checkins": ("id", "user_id"),
    "schedules": ("id", "user_id", "converted_entry_id"),
}
NULLABLE = {
    ("diary_entries", "from_schedule_id"), ("media", "entry_id"),
    ("schedules", "converted_entry_id"),
}


def _verify_server(version, sql_mode):
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", version)
    if (not match or tuple(map(int, match.groups())) < (8, 0, 16)
            or "mariadb" in version.lower()):
        raise RuntimeError("UUID32 empty cutover requires MySQL 8.0.16+")
    if not {mode.strip().upper() for mode in sql_mode.split(",")} & {
        "STRICT_TRANS_TABLES", "STRICT_ALL_TABLES",
    }:
        raise RuntimeError("UUID32 empty cutover requires strict SQL mode")


def _storage_kind(column):
    if column["data_type"] == "binary" and column["length"] == 16:
        return "binary16"
    if (column["data_type"] == "char" and column["length"] == 32
            and column["charset"] == "ascii" and column["collation"] == "ascii_bin"):
        return "hex32"
    return "unsupported"


def _plan(columns, engines, row_counts, direction, *, foreign_keys=0, triggers=0,
          prefix_indexes=0):
    """Pure empty-schema planner. All validation happens before returning ANY DDL."""
    if direction not in {"upgrade", "downgrade"}:
        raise RuntimeError("Unsupported UUID32 migration direction")
    expected_tables = set(UUID_COLUMNS)
    if not expected_tables <= set(engines) or any(
        engines[table].lower() != "innodb" for table in UUID_COLUMNS
    ):
        raise RuntimeError("All eight UUID tables must exist and use InnoDB")
    if set(row_counts) != expected_tables or any(
        type(value) is not int or value != 0 for value in row_counts.values()
    ):
        raise RuntimeError("UUID32 migration requires ALL eight business tables to be empty")
    if foreign_keys or triggers or prefix_indexes:
        raise RuntimeError("Foreign keys, triggers or UUID prefix indexes require manual review")
    indexed = {}
    for column in columns:
        table, name = column["table"], column["name"]
        if table not in UUID_COLUMNS:
            continue
        key = (table, name)
        if key in indexed:
            raise RuntimeError("Duplicate UUID migration metadata")
        indexed[key] = column
        if column["generation"]:
            raise RuntimeError("Generated columns require separate review")
        if (name.endswith("_id") and column["data_type"] == "binary"
                and column["length"] == 16 and name not in UUID_COLUMNS[table]):
            raise RuntimeError("An additional binary identifier requires review")
    target = "hex32" if direction == "upgrade" else "binary16"
    sql_type = ("CHAR(32) CHARACTER SET ascii COLLATE ascii_bin"
                if direction == "upgrade" else "BINARY(16)")
    statements = []
    for table, names in UUID_COLUMNS.items():
        kinds = []
        parts = []
        for name in names:
            key = (table, name)
            column = indexed.get(key)
            if column is None or _storage_kind(column) == "unsupported":
                raise RuntimeError("Unexpected UUID storage; no automatic type guessing")
            if column["nullable"] != (key in NULLABLE):
                raise RuntimeError("UUID nullability differs from the reviewed schema")
            if column["default"] is not None or column["extra"] or column["comment"]:
                raise RuntimeError("UUID column attributes differ from the reviewed schema")
            kinds.append(_storage_kind(column))
            null = "NULL DEFAULT NULL" if key in NULLABLE else "NOT NULL"
            parts.append(f"MODIFY COLUMN `{name}` {sql_type} {null}")
        # Only empty tables may tolerate an interrupted migration's mixed types.
        if any(kind != target for kind in kinds):
            statements.append(f"ALTER TABLE `{table}` " + ", ".join(parts))
    return statements


def _snapshot(connection):
    from sqlalchemy import text

    columns = [
        {"table": row[0], "name": row[1], "data_type": row[2], "length": row[3],
         "nullable": row[4] == "YES", "charset": row[5], "collation": row[6],
         "default": row[7], "extra": row[8] or "", "comment": row[9] or "",
         "generation": row[10] or ""}
        for row in connection.execute(text("""
            SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH,
                   IS_NULLABLE, CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_DEFAULT,
                   EXTRA, COLUMN_COMMENT, GENERATION_EXPRESSION
            FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        """)) if row[0] in UUID_COLUMNS
    ]
    engines = {
        row[0]: row[1] or "" for row in connection.execute(text("""
            SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE()
        """)) if row[0] in UUID_COLUMNS
    }
    counts = {
        table: connection.execute(text(f"SELECT COUNT(*) FROM `{table}`")).scalar_one()
        for table in UUID_COLUMNS if table in engines
    }
    foreign_keys = sum(
        1 for row in connection.execute(text("""
            SELECT TABLE_SCHEMA = DATABASE(), TABLE_NAME,
                   REFERENCED_TABLE_SCHEMA = DATABASE(), REFERENCED_TABLE_NAME
            FROM information_schema.KEY_COLUMN_USAGE
            WHERE REFERENCED_TABLE_NAME IS NOT NULL
              AND (TABLE_SCHEMA = DATABASE() OR REFERENCED_TABLE_SCHEMA = DATABASE())
        """))
        if (row[0] and row[1] in UUID_COLUMNS) or (row[2] and row[3] in UUID_COLUMNS)
    )
    triggers = sum(
        1 for row in connection.execute(text("""
            SELECT EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS
            WHERE EVENT_OBJECT_SCHEMA = DATABASE()
        """)) if row[0] in UUID_COLUMNS
    )
    prefixes = sum(
        1 for row in connection.execute(text("""
            SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND SUB_PART IS NOT NULL
        """)) if row[0] in UUID_COLUMNS and row[1] in UUID_COLUMNS[row[0]]
    )
    return columns, engines, counts, {
        "foreign_keys": foreign_keys, "triggers": triggers, "prefix_indexes": prefixes,
    }


def _run(connection, direction):
    if os.environ.get("QUIRE_UUID32_EMPTY_DB_ACK") != "1":
        raise RuntimeError(
            "Stop all writers, verify empty DB, then set QUIRE_UUID32_EMPTY_DB_ACK=1",
        )
    if connection.dialect.name != "mysql":
        raise RuntimeError("UUID32 empty cutover requires MySQL, not another SQL dialect")
    from sqlalchemy import text

    version, mode = connection.execute(text("SELECT VERSION(), @@SESSION.sql_mode")).one()
    _verify_server(version, mode)
    database = connection.execute(text("SELECT DATABASE()")).scalar_one()
    if not database:
        raise RuntimeError("Select an explicit target database before UUID32 migration")
    lock = "quire_uuid32_empty_" + hashlib.sha256(database.encode()).hexdigest()[:32]
    acquired = connection.execute(text("SELECT GET_LOCK(:name, 0)"), {"name": lock}).scalar_one()
    if acquired != 1:
        raise RuntimeError("Another UUID32 migration is running")
    try:
        columns, engines, counts, features = _snapshot(connection)
        statements = _plan(columns, engines, counts, direction, **features)
        for sql in statements:
            connection.execute(text(sql))
        columns, engines, counts, features = _snapshot(connection)
        if _plan(columns, engines, counts, direction, **features):
            raise RuntimeError("UUID32 migration post-check failed")
    finally:
        connection.execute(text("SELECT RELEASE_LOCK(:name)"), {"name": lock})


def _migrate(direction):
    from alembic import context, op

    if context.is_offline_mode():
        raise RuntimeError("UUID32 empty cutover requires online emptiness checks; no --sql mode")
    _run(op.get_bind(), direction)


def upgrade():
    _migrate("upgrade")


def downgrade():
    # Never truncate fresh hex32 IDs back to binary text after users start writing.
    _migrate("downgrade")
