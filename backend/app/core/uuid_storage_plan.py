"""Reviewed UUID storage conversion plan. Pure functions; NEVER execute SQL here.

Not an Alembic revision. Keep inactive until ORM, APIs, browser, backup and media
have a coordinated cutover. MySQL DDL commits implicitly: restore a verified
backup after interruption, rather than guessing whether bytes were converted.
"""

import re
from dataclasses import dataclass

UUID_COLUMNS: dict[str, tuple[str, ...]] = {
    "users": ("id",),
    "diary_entries": ("id", "user_id", "from_schedule_id"),
    "tags": ("id", "user_id"),
    "media": ("id", "user_id", "entry_id"),
    "entry_tags": ("entry_id", "tag_id"),
    "refresh_sessions": ("id", "user_id"),
    "checkins": ("id", "user_id"),
    "schedules": ("id", "user_id", "converted_entry_id"),
}
_IDENTIFIER = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]*\Z")


class MigrationPlanError(ValueError):
    """An explicitly unsupported precondition; no automatic schema guessing."""


@dataclass(frozen=True)
class ColumnState:
    table: str
    name: str
    data_type: str
    length: int | None
    nullable: bool
    charset: str | None = None
    collation: str | None = None
    default: str | None = None
    extra: str = ""
    comment: str = ""
    generation: str = ""


@dataclass(frozen=True)
class MySQLState:
    server_version: str
    sql_mode: str
    # Only the eight reviewed application tables, but ALL their columns.
    columns: tuple[ColumnState, ...]
    engines: tuple[tuple[str, str], ...]
    foreign_key_count: int = 0
    trigger_count: int = 0
    partial_uuid_index_count: int = 0


@dataclass(frozen=True)
class PlannedStatement:
    phase: str
    table: str
    sql: str


@dataclass(frozen=True)
class StoragePlan:
    direction: str
    statements: tuple[PlannedStatement, ...]


def quoted(identifier: str) -> str:
    if not isinstance(identifier, str) or not _IDENTIFIER.fullmatch(identifier):
        raise MigrationPlanError("Unsupported SQL identifier in reviewed table metadata")
    return f"`{identifier}`"


def _state_kind(column: ColumnState) -> str:
    if column.data_type == "binary" and column.length == 16:
        return "binary16"
    if (column.data_type == "char" and column.length == 32
            and column.charset == "ascii" and column.collation == "ascii_bin"):
        return "hex32"
    return "unsupported"


def _validate(state: MySQLState, direction: str) -> dict[tuple[str, str], ColumnState]:
    if direction not in {"upgrade", "downgrade"}:
        raise MigrationPlanError("Direction must be upgrade or downgrade")
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", state.server_version)
    if (not match or tuple(map(int, match.groups())) < (8, 0, 16)
            or "mariadb" in state.server_version.lower()):
        raise MigrationPlanError("This conversion plan requires MySQL 8.0.16 or later")
    modes = {mode.strip().upper() for mode in state.sql_mode.split(",")}
    if not modes & {"STRICT_TRANS_TABLES", "STRICT_ALL_TABLES"}:
        raise MigrationPlanError("Strict SQL mode is required to prevent silent truncation")
    engines = dict(state.engines)
    if any(engines.get(table, "").lower() != "innodb" for table in UUID_COLUMNS):
        raise MigrationPlanError("All eight reviewed tables must exist and use InnoDB")
    if state.foreign_key_count:
        raise MigrationPlanError("Physical foreign keys need a separately reviewed migration")
    if state.trigger_count:
        raise MigrationPlanError("Table triggers need a separately reviewed migration")
    if state.partial_uuid_index_count:
        raise MigrationPlanError("UUID prefix indexes need a separately reviewed migration")
    columns: dict[tuple[str, str], ColumnState] = {}
    for column in state.columns:
        if column.table not in UUID_COLUMNS:
            raise MigrationPlanError("Metadata contains an unreviewed table")
        quoted(column.name)
        key = (column.table, column.name)
        if key in columns:
            raise MigrationPlanError("Duplicate column metadata")
        columns[key] = column
        if column.generation:
            raise MigrationPlanError("Generated columns need a separately reviewed migration")
        if (column.name.endswith("_id") and column.data_type == "binary"
                and column.length == 16 and column.name not in UUID_COLUMNS[column.table]):
            raise MigrationPlanError("An additional binary identifier needs review")
    expected = "binary16" if direction == "upgrade" else "hex32"
    for table, names in UUID_COLUMNS.items():
        for name in names:
            column = columns.get((table, name))
            if column is None or _state_kind(column) != expected:
                raise MigrationPlanError(
                    "Unexpected or mixed UUID storage; do not retry a partial conversion",
                )
            # MODIFY COLUMN must not silently discard a default/comment/extra attribute.
            if column.default is not None or column.comment or column.extra:
                raise MigrationPlanError("UUID column attributes differ from reviewed models")
    return columns


def build_storage_plan(state: MySQLState, direction: str = "upgrade") -> StoragePlan:
    """Render 24 statements; not a data validator, transaction or execution API.

    Pre-execution and post-execution data checks belong to the cutover runner.
    In particular, downgrade requires every non-null source ID to match exactly
    lowercase ASCII hex32 before UNHEX. Rendering SQL grants no permission to run it.
    """
    columns = _validate(state, direction)
    statements: list[PlannedStatement] = []
    # Widen every source UUID column first. No direct BINARY -> CHAR coercion.
    for table, names in UUID_COLUMNS.items():
        parts = []
        for name in names:
            null = "NULL DEFAULT NULL" if columns[(table, name)].nullable else "NOT NULL"
            parts.append(f"MODIFY COLUMN {quoted(name)} VARBINARY(32) {null}")
        statements.append(PlannedStatement(
            "widen", table, f"ALTER TABLE {quoted(table)} " + ", ".join(parts),
        ))
    for table, names in UUID_COLUMNS.items():
        # All IDs in one table change in ONE statement, preserving constraints such
        # as schedules.converted_entry_id = schedules.id throughout the update.
        parts = []
        for name in names:
            expression = (f"LOWER(HEX({quoted(name)}))" if direction == "upgrade"
                          else f"UNHEX({quoted(name)})")
            parts.append(f"{quoted(name)} = {expression}")
        for (owner, name), column in columns.items():
            if owner == table and name not in names and "on update" in column.extra.lower():
                # Preserve sync watermarks, instead of stamping every historical row now.
                parts.append(f"{quoted(name)} = {quoted(name)}")
        statements.append(PlannedStatement(
            "convert", table, f"UPDATE {quoted(table)} SET " + ", ".join(parts),
        ))
    target = ("CHAR(32) CHARACTER SET ascii COLLATE ascii_bin"
              if direction == "upgrade" else "BINARY(16)")
    for table, names in UUID_COLUMNS.items():
        parts = []
        for name in names:
            null = "NULL DEFAULT NULL" if columns[(table, name)].nullable else "NOT NULL"
            parts.append(f"MODIFY COLUMN {quoted(name)} {target} {null}")
        statements.append(PlannedStatement(
            "finalize", table, f"ALTER TABLE {quoted(table)} " + ", ".join(parts),
        ))
    return StoragePlan(direction, tuple(statements))
