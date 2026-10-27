"""Read-only MySQL metadata adapter for the inactive UUID32 storage planner."""

from sqlalchemy import text

from app.core.uuid_storage_plan import UUID_COLUMNS, ColumnState, MySQLState


def inspect_uuid_storage(connection) -> MySQLState:
    """Use a SQLAlchemy synchronous connection (or AsyncConnection.run_sync).

    SELECT only. No DDL, table locks, migration execution or data rewriting.
    """
    version, mode = connection.execute(text("SELECT VERSION(), @@SESSION.sql_mode")).one()
    rows = connection.execute(text("""
        SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH,
               IS_NULLABLE, CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_DEFAULT,
               EXTRA, COLUMN_COMMENT, GENERATION_EXPRESSION
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME, ORDINAL_POSITION
    """))
    columns = tuple(
        ColumnState(
            table=row[0], name=row[1], data_type=row[2], length=row[3],
            nullable=row[4] == "YES", charset=row[5], collation=row[6],
            default=row[7], extra=row[8] or "", comment=row[9] or "",
            generation=row[10] or "",
        )
        for row in rows if row[0] in UUID_COLUMNS
    )
    engines = tuple(
        (row[0], row[1] or "") for row in connection.execute(text("""
            SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE()
        """)) if row[0] in UUID_COLUMNS
    )
    # Include incoming constraints from other tables/schemas visible to this account.
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
    partial_indexes = sum(
        1 for row in connection.execute(text("""
            SELECT TABLE_NAME, COLUMN_NAME, SUB_PART FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND SUB_PART IS NOT NULL
        """))
        if row[0] in UUID_COLUMNS and row[1] in UUID_COLUMNS[row[0]]
    )
    return MySQLState(version, mode, columns, engines, foreign_keys, triggers, partial_indexes)
