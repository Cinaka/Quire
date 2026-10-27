"""Read-only UUID32 inventory/check. No DDL, DML, migration, file or ID rewriting.

Default: print the reviewed column inventory, without loading .env or connecting.
Explicit --check: read MySQL metadata and aggregate integrity counts.
Explicit --plan: SELECT metadata and print proposed SQL; NEVER execute that SQL.
Do not pass a password/URL in argv. A read-only database account is recommended.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

# Script execution from backend/tools must still find the backend app package.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.uuid_storage_plan import (  # noqa: E402
    UUID_COLUMNS,
    MigrationPlanError,
    build_storage_plan,
)

# These referential checks do not assume physical FK constraints exist in MySQL.
# Some missing diary references may be intentional tombstone/purge states: report,
# never repair or delete anything automatically.
REFERENCES = (
    ("diary_entries", "user_id", "users", "id"),
    ("tags", "user_id", "users", "id"),
    ("media", "user_id", "users", "id"),
    ("refresh_sessions", "user_id", "users", "id"),
    ("checkins", "user_id", "users", "id"),
    ("schedules", "user_id", "users", "id"),
    ("entry_tags", "entry_id", "diary_entries", "id"),
    ("entry_tags", "tag_id", "tags", "id"),
)


async def check_database():
    from sqlalchemy import text
    from sqlalchemy.engine import make_url
    from sqlalchemy.ext.asyncio import create_async_engine

    from app.core.config import settings

    if make_url(settings.database_url).get_backend_name() != "mysql":
        raise RuntimeError("UUID32 preflight requires MySQL")
    engine = create_async_engine(settings.database_url, echo=False)
    try:
        async with engine.connect() as connection:
            # All SQL in this tool is SELECT, with a fixed identifier allowlist.
            result = await connection.execute(text("""
                SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH,
                       CHARACTER_SET_NAME, COLLATION_NAME
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
            """))
            schema = {(row[0], row[1]): row for row in result}
            report = {"read_only": True, "columns": [], "references": []}
            for table, columns in UUID_COLUMNS.items():
                for column in columns:
                    row = schema.get((table, column))
                    if row is None:
                        report["columns"].append({"table": table, "column": column,
                                                  "state": "missing"})
                        continue
                    kind, length = row[2], row[3]
                    target = kind == "char" and length == 32 and row[4:6] == ("ascii", "ascii_bin")
                    legacy = kind == "binary" and length == 16
                    item = {"table": table, "column": column,
                            "state": "hex32" if target else "binary16" if legacy else "unexpected"}
                    if target or legacy:
                        expression = f"LOWER(HEX(`{column}`))" if legacy else f"`{column}`"
                        query = f"""
                            SELECT COUNT(*) FROM `{table}`
                            WHERE `{column}` IS NOT NULL
                              AND NOT REGEXP_LIKE({expression}, '^[0-9a-f]{{32}}$', 'c')
                        """
                        item["invalid_count"] = (await connection.execute(text(query))).scalar_one()
                    report["columns"].append(item)
            for table, column, parent, key in REFERENCES:
                if (table, column) not in schema or (parent, key) not in schema:
                    continue
                query = f"""
                    SELECT COUNT(*) FROM `{table}` AS child
                    LEFT JOIN `{parent}` AS parent ON child.`{column}` = parent.`{key}`
                    WHERE child.`{column}` IS NOT NULL AND parent.`{key}` IS NULL
                """
                count = (await connection.execute(text(query))).scalar_one()
                report["references"].append({"table": table, "column": column,
                                             "parent": parent, "unmatched_count": count})
            return report
    finally:
        await engine.dispose()


async def plan_database(direction):
    from dataclasses import asdict

    from sqlalchemy.engine import make_url
    from sqlalchemy.ext.asyncio import create_async_engine

    from app.core.config import settings
    from app.db.uuid_storage_inspection import inspect_uuid_storage

    if make_url(settings.database_url).get_backend_name() != "mysql":
        raise MigrationPlanError("UUID32 planner requires MySQL")
    engine = create_async_engine(settings.database_url, echo=False)
    try:
        async with engine.connect() as connection:
            state = await connection.run_sync(inspect_uuid_storage)
        plan = build_storage_plan(state, direction)
        return {
            "read_only": True,
            "mode": "sql-preview-only",
            "executable_cutover": False,
            "warning": "No row validation, backup verification or SQL execution performed",
            **asdict(plan),
        }
    finally:
        await engine.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true", help="Run SELECT-only MySQL checks")
    group.add_argument("--plan", choices=("upgrade", "downgrade"),
                       help="SELECT metadata and print proposed SQL; NEVER execute it")
    args = parser.parse_args()
    if not args.check and not args.plan:
        print(json.dumps({"mode": "inventory-only", "columns": UUID_COLUMNS}, indent=2))
        return 0
    try:
        report = asyncio.run(plan_database(args.plan) if args.plan else check_database())
    except MigrationPlanError as error:
        print(f"UUID32 SQL preview refused: {error}", file=sys.stderr)
        return 1
    except Exception:
        # Do not print connection URL, SQL parameters, account identifiers or credentials.
        print("Read-only UUID32 check failed; verify connectivity and SELECT permissions.",
              file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2))
    if args.plan:
        return 0
    # A successful scan is not proof of cross-store migration safety.
    return int(any(item["state"] in {"missing", "unexpected"}
                   or item.get("invalid_count", 0) for item in report["columns"]))


if __name__ == "__main__":
    raise SystemExit(main())
