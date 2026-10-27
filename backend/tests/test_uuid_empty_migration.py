"""Tests of the actual frozen revision's pure guards/planner, without executing DDL."""

import importlib.util
import os
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

REVISION_PATH = (Path(__file__).resolve().parents[1] / "alembic/versions"
                 / "20261026_uuid32_empty_database.py")
spec = importlib.util.spec_from_file_location("quire_uuid32_empty_revision", REVISION_PATH)
revision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(revision)


def schema(hex32=False):
    columns = []
    for table, names in revision.UUID_COLUMNS.items():
        for name in names:
            columns.append({
                "table": table, "name": name,
                "data_type": "char" if hex32 else "binary", "length": 32 if hex32 else 16,
                "nullable": (table, name) in revision.NULLABLE,
                "charset": "ascii" if hex32 else None,
                "collation": "ascii_bin" if hex32 else None,
                "default": None, "extra": "", "comment": "", "generation": "",
            })
    return columns


class UUIDEmptyMigrationTests(unittest.TestCase):
    def setUp(self):
        self.columns = schema()
        self.engines = dict.fromkeys(revision.UUID_COLUMNS, "InnoDB")
        self.counts = dict.fromkeys(revision.UUID_COLUMNS, 0)

    def plan(self, **kwargs):
        return revision._plan(self.columns, self.engines, self.counts, "upgrade", **kwargs)

    def test_revision_follows_current_head(self):
        self.assertEqual(revision.revision, "uuid32_empty_v1")
        self.assertEqual(revision.down_revision, "p4_convert_receipts")

    def test_eight_tables_eighteen_columns(self):
        self.assertEqual(len(self.engines), 8)
        self.assertEqual(len(self.columns), 18)

    def test_upgrade_is_eight_direct_alters_no_intermediate_or_dml(self):
        sql = self.plan()
        self.assertEqual(len(sql), 8)
        self.assertEqual(sum(item.count("MODIFY COLUMN") for item in sql), 18)
        for item in sql:
            self.assertTrue(item.startswith("ALTER TABLE `"))
            for forbidden in ("VARBINARY", "UPDATE ", "DELETE ", "TRUNCATE", "DROP "):
                self.assertNotIn(forbidden, item)

    def test_target_is_char32_ascii_bin(self):
        self.assertEqual(sum(item.count("CHAR(32) CHARACTER SET ascii COLLATE ascii_bin")
                             for item in self.plan()), 18)

    def test_all_tables_are_empty_before_any_plan(self):
        for table in self.counts:
            self.counts[table] = 1
            with self.assertRaisesRegex(RuntimeError, "ALL eight business tables"):
                self.plan()
            self.counts[table] = 0

    def test_rejects_negative_or_boolean_counts(self):
        for value in (-1, True, False, "0", None):
            self.counts["users"] = value
            with self.assertRaises(RuntimeError):
                self.plan()

    def test_incomplete_or_extra_count_inventory_refused(self):
        del self.counts["users"]
        with self.assertRaises(RuntimeError):
            self.plan()
        self.counts["users"] = 0
        self.counts["unknown"] = 0
        with self.assertRaises(RuntimeError):
            self.plan()

    def test_all_target_columns_are_idempotent_only_if_empty(self):
        self.columns = schema(hex32=True)
        self.assertEqual(self.plan(), [])
        self.counts["users"] = 1
        with self.assertRaises(RuntimeError):
            self.plan()

    def test_interrupted_empty_conversion_can_resume(self):
        self.columns[0] = schema(hex32=True)[0]
        sql = self.plan()
        self.assertEqual(len(sql), 7)
        self.assertTrue(all(not item.startswith("ALTER TABLE `users`") for item in sql))

    def test_partial_table_conversion_is_atomic_per_table(self):
        position = next(index for index, item in enumerate(self.columns)
                        if item["table"] == "schedules" and item["name"] == "id")
        self.columns[position] = schema(hex32=True)[position]
        sql = next(item for item in self.plan() if item.startswith("ALTER TABLE `schedules`"))
        self.assertEqual(sql.count("MODIFY COLUMN"), 3)

    def test_mixed_types_never_resume_with_rows(self):
        self.columns[0] = schema(hex32=True)[0]
        self.counts["diary_entries"] = 1
        with self.assertRaises(RuntimeError):
            self.plan()

    def test_nullable_relationships_preserved(self):
        sql = "\n".join(self.plan())
        self.assertEqual(sql.count(" NULL DEFAULT NULL"), 3)
        self.assertEqual(sql.count(" NOT NULL"), 15)

    def test_changed_nullability_refused(self):
        self.columns[0]["nullable"] = True
        with self.assertRaisesRegex(RuntimeError, "nullability"):
            self.plan()

    def test_unrecognized_storage_refused(self):
        for kind, length in (("varbinary", 32), ("binary", 32), ("varchar", 32)):
            self.columns = schema()
            self.columns[0].update(data_type=kind, length=length)
            with self.assertRaises(RuntimeError):
                self.plan()

    def test_wrong_target_charset_collation_refused(self):
        for values in ({"charset": "utf8mb4"}, {"collation": "ascii_general_ci"}):
            self.columns = schema(hex32=True)
            self.columns[0].update(values)
            with self.assertRaises(RuntimeError):
                self.plan()

    def test_missing_or_duplicate_column_refused(self):
        self.columns.pop()
        with self.assertRaises(RuntimeError):
            self.plan()
        self.columns = schema()
        self.columns.append(deepcopy(self.columns[0]))
        with self.assertRaises(RuntimeError):
            self.plan()

    def test_extra_column_attributes_refused(self):
        for values in ({"default": "UUID()"}, {"extra": "DEFAULT_GENERATED"},
                       {"comment": "custom"}, {"generation": "hex(id)"}):
            self.columns = schema()
            self.columns[0].update(values)
            with self.assertRaises(RuntimeError):
                self.plan()

    def test_new_binary_foreign_identifier_refused(self):
        extra = deepcopy(self.columns[0])
        extra["name"] = "organization_id"
        self.columns.append(extra)
        with self.assertRaises(RuntimeError):
            self.plan()

    def test_missing_or_non_innodb_table_refused(self):
        del self.engines["users"]
        with self.assertRaises(RuntimeError):
            self.plan()
        self.engines["users"] = "MyISAM"
        with self.assertRaises(RuntimeError):
            self.plan()

    def test_external_schema_features_refused(self):
        for features in ({"foreign_keys": 1}, {"triggers": 1}, {"prefix_indexes": 1}):
            with self.assertRaises(RuntimeError):
                self.plan(**features)

    def test_downgrade_is_empty_only(self):
        columns = schema(hex32=True)
        sql = revision._plan(columns, self.engines, self.counts, "downgrade")
        self.assertEqual(sum(item.count("BINARY(16)") for item in sql), 18)
        self.counts["users"] = 1
        with self.assertRaises(RuntimeError):
            revision._plan(columns, self.engines, self.counts, "downgrade")

    def test_already_binary_downgrade_noop(self):
        self.assertEqual(revision._plan(
            self.columns, self.engines, self.counts, "downgrade",
        ), [])

    def test_invalid_direction_refused(self):
        with self.assertRaises(RuntimeError):
            revision._plan(self.columns, self.engines, self.counts, "reset")

    def test_metadata_not_mutated(self):
        before = deepcopy((self.columns, self.engines, self.counts))
        self.plan()
        self.assertEqual(before, (self.columns, self.engines, self.counts))

    def test_supported_mysql_version_and_strict_modes(self):
        for mode in ("STRICT_TRANS_TABLES", "STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION"):
            revision._verify_server("8.0.46-0ubuntu0.24.04.4", mode)

    def test_old_server_or_non_strict_mode_refused(self):
        for version, mode in (("5.7.44", "STRICT_TRANS_TABLES"),
                              ("8.0.15", "STRICT_TRANS_TABLES"),
                              ("10.11.4-MariaDB", "STRICT_ALL_TABLES"),
                              ("8.0.46", "NO_ENGINE_SUBSTITUTION")):
            with self.assertRaises(RuntimeError):
                revision._verify_server(version, mode)

    def test_operator_ack_is_required_before_connection_use(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "Stop all writers"):
                revision._run(None, "upgrade")

    def test_wrong_dialect_refused_before_connection_use(self):
        with patch.dict(os.environ, {"QUIRE_UUID32_EMPTY_DB_ACK": "1"}):
            with self.assertRaisesRegex(RuntimeError, "requires MySQL"):
                revision._run(SimpleNamespace(dialect=SimpleNamespace(name="sqlite")), "upgrade")


if __name__ == "__main__":
    unittest.main()
