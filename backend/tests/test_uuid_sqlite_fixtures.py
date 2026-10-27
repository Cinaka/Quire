"""Check literal SQLite fixture DDL without importing the application or its dependencies."""

import ast
import sqlite3
import unittest
import uuid
from contextlib import closing
from pathlib import Path

TESTS = Path(__file__).resolve().parent
FIXTURES = (
    "test_schedule_writes.py",
    "test_schedule_queries.py",
    "test_schedule_convert.py",
    "test_schedule_resource_review.py",
    "test_p7_media_security.py",
)
UUID_COLUMNS = {
    "users": {"id"},
    "schedules": {"id", "user_id", "converted_entry_id"},
    "diary_entries": {"id", "user_id", "from_schedule_id"},
    "entry_tags": {"entry_id", "tag_id"},
    "media": {"id", "user_id", "entry_id"},
    "tags": {"id", "user_id"},
    "refresh_sessions": {"id", "user_id"},
}


class UUIDSQLiteFixtureTests(unittest.TestCase):
    def test_fixture_uuid_columns_are_char32(self):
        seen = []
        for filename in FIXTURES:
            tree = ast.parse((TESTS / filename).read_text())
            statements = [
                node.value for node in ast.walk(tree)
                if isinstance(node, ast.Constant) and isinstance(node.value, str)
                and node.value.lstrip().upper().startswith("CREATE TABLE ")
            ]
            with closing(sqlite3.connect(":memory:")) as connection:
                for statement in statements:
                    connection.execute(statement)
                tables = connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
                for (table,) in tables:
                    with self.subTest(filename=filename, table=table):
                        self.assertIn(table, UUID_COLUMNS)
                        columns = {
                            row[1]: row[2] for row in connection.execute(
                                f'PRAGMA table_info("{table}")'
                            )
                        }
                        for column in UUID_COLUMNS[table]:
                            self.assertEqual(columns[column].upper(), "CHAR(32)")
                        seen.append(table)
        self.assertEqual(len(seen), 11)
        self.assertEqual(set(seen), set(UUID_COLUMNS))

    def test_fixture_uuid_seeds_do_not_use_binary_values(self):
        for filename in FIXTURES:
            tree = ast.parse((TESTS / filename).read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.Attribute):
                    with self.subTest(filename=filename, line=node.lineno):
                        self.assertNotEqual(node.attr, "bytes")
                        self.assertFalse(
                            node.attr == "fromhex" and isinstance(node.value, ast.Name)
                            and node.value.id == "bytes"
                        )

    def test_text_lookup_matches_hex_seed_but_not_legacy_blob(self):
        identifier = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456")
        with closing(sqlite3.connect(":memory:")) as connection:
            connection.execute("CREATE TABLE legacy_users (id BLOB PRIMARY KEY)")
            connection.execute("INSERT INTO legacy_users VALUES (?)", (identifier.bytes,))
            self.assertIsNone(connection.execute(
                "SELECT id FROM legacy_users WHERE id = ?", (identifier.hex,)
            ).fetchone())
            connection.execute("CREATE TABLE users (id CHAR(32) PRIMARY KEY)")
            connection.execute("INSERT INTO users VALUES (?)", (identifier.hex,))
            self.assertEqual(connection.execute(
                "SELECT id, typeof(id), length(id) FROM users WHERE id = ?",
                (identifier.hex,),
            ).fetchone(), (identifier.hex, "text", 32))


if __name__ == "__main__":
    unittest.main()
