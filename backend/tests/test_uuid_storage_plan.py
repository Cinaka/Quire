"""Dependency-free tests of the inactive SQL planner, not MySQL execution tests."""

import unittest
from dataclasses import replace

from app.core.uuid_storage_plan import (
    UUID_COLUMNS,
    ColumnState,
    MigrationPlanError,
    MySQLState,
    build_storage_plan,
    quoted,
)


def source_state(hex32=False):
    columns = []
    for table, names in UUID_COLUMNS.items():
        for name in names:
            columns.append(ColumnState(
                table, name, "char" if hex32 else "binary", 32 if hex32 else 16,
                nullable=name in {"from_schedule_id", "converted_entry_id", "entry_id"}
                and table != "entry_tags",
                charset="ascii" if hex32 else None,
                collation="ascii_bin" if hex32 else None,
            ))
        columns.append(ColumnState(
            table, "updated_at", "datetime", None, False,
            extra="DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)",
        ))
    return MySQLState(
        "8.0.46-0ubuntu0.24.04.4", "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION",
        tuple(columns), tuple((table, "InnoDB") for table in UUID_COLUMNS),
    )


class UUIDStoragePlanTests(unittest.TestCase):
    def setUp(self):
        self.state = source_state()

    def change_column(self, **changes):
        return replace(self.state, columns=(
            replace(self.state.columns[0], **changes), *self.state.columns[1:],
        ))

    def assert_refused(self, state, direction="upgrade"):
        with self.assertRaises(MigrationPlanError):
            build_storage_plan(state, direction)

    def test_inventory_is_eight_tables_eighteen_identifiers(self):
        self.assertEqual(len(UUID_COLUMNS), 8)
        self.assertEqual(sum(map(len, UUID_COLUMNS.values())), 18)

    def test_three_phases_each_cover_all_tables(self):
        plan = build_storage_plan(self.state)
        self.assertEqual(len(plan.statements), 24)
        for offset, phase in ((0, "widen"), (8, "convert"), (16, "finalize")):
            group = plan.statements[offset:offset + 8]
            self.assertEqual([item.phase for item in group], [phase] * 8)
            self.assertEqual([item.table for item in group], list(UUID_COLUMNS))

    def test_widens_without_direct_binary_to_char_coercion(self):
        for item in build_storage_plan(self.state).statements[:8]:
            self.assertIn("VARBINARY(32)", item.sql)
            self.assertNotIn("CHAR(", item.sql)
            self.assertEqual(item.sql.count("MODIFY COLUMN"), len(UUID_COLUMNS[item.table]))

    def test_upgrade_converts_exactly_eighteen_columns(self):
        updates = build_storage_plan(self.state).statements[8:16]
        self.assertEqual(sum(item.sql.count("LOWER(HEX(") for item in updates), 18)
        self.assertTrue(all("UUID_TO_BIN" not in item.sql for item in updates))
        self.assertTrue(all("REPLACE(" not in item.sql for item in updates))

    def test_schedule_identifiers_change_in_one_update(self):
        updates = [item for item in build_storage_plan(self.state).statements
                   if item.phase == "convert" and item.table == "schedules"]
        self.assertEqual(len(updates), 1)
        for name in UUID_COLUMNS["schedules"]:
            self.assertIn(f"`{name}` = LOWER(HEX(`{name}`))", updates[0].sql)

    def test_freezes_all_auto_updated_timestamps(self):
        extra = ColumnState("users", "last_changed", "timestamp", None, False,
                            extra="on update CURRENT_TIMESTAMP")
        state = replace(self.state, columns=(*self.state.columns, extra))
        for item in build_storage_plan(state).statements[8:16]:
            self.assertIn("`updated_at` = `updated_at`", item.sql)
            if item.table == "users":
                self.assertIn("`last_changed` = `last_changed`", item.sql)

    def test_no_guessed_timestamp_assignment_if_column_absent(self):
        state = replace(self.state, columns=tuple(
            item for item in self.state.columns if item.name != "updated_at"
        ))
        self.assertTrue(all("updated_at" not in item.sql
                            for item in build_storage_plan(state).statements))

    def test_target_is_ascii_binary_collated_char32(self):
        targets = build_storage_plan(self.state).statements[16:]
        self.assertEqual(sum(item.sql.count(
            "CHAR(32) CHARACTER SET ascii COLLATE ascii_bin",
        ) for item in targets), 18)

    def test_nullability_is_preserved_in_both_alters(self):
        for item in build_storage_plan(self.state).statements:
            if item.table == "schedules" and item.phase != "convert":
                self.assertIn("NOT NULL", item.sql)
                self.assertIn("NULL DEFAULT NULL", item.sql)

    def test_downgrade_uses_unhex_and_binary16(self):
        plan = build_storage_plan(source_state(hex32=True), "downgrade")
        self.assertEqual(sum(item.sql.count("UNHEX(") for item in plan.statements), 18)
        self.assertEqual(sum(item.sql.count("BINARY(16)") for item in plan.statements), 18)
        self.assertTrue(all("LOWER(HEX(" not in item.sql for item in plan.statements))

    def test_inputs_are_not_mutated(self):
        original = source_state()
        build_storage_plan(self.state)
        self.assertEqual(self.state, original)

    def test_invalid_direction_refused(self):
        self.assert_refused(self.state, "reset")

    def test_old_mysql_and_mariadb_refused(self):
        for version in ("5.7.44", "8.0.15", "10.11.4-MariaDB", "unknown"):
            self.assert_refused(replace(self.state, server_version=version))

    def test_non_strict_mode_refused(self):
        self.assert_refused(replace(self.state, sql_mode="NO_ENGINE_SUBSTITUTION"))

    def test_strict_all_tables_supported(self):
        state = replace(self.state, sql_mode="STRICT_ALL_TABLES")
        self.assertEqual(len(build_storage_plan(state).statements), 24)

    def test_non_innodb_and_missing_tables_refused(self):
        self.assert_refused(replace(self.state, engines=self.state.engines[1:]))
        self.assert_refused(replace(self.state, engines=(("users", "MyISAM"),
                                                        *self.state.engines[1:])))

    def test_incoming_or_outgoing_foreign_keys_refused(self):
        self.assert_refused(replace(self.state, foreign_key_count=1))

    def test_table_triggers_refused(self):
        self.assert_refused(replace(self.state, trigger_count=1))

    def test_uuid_prefix_indexes_refused(self):
        self.assert_refused(replace(self.state, partial_uuid_index_count=1))

    def test_missing_and_duplicate_column_metadata_refused(self):
        self.assert_refused(replace(self.state, columns=self.state.columns[1:]))
        self.assert_refused(replace(self.state, columns=(
            *self.state.columns, self.state.columns[0],
        )))

    def test_intermediate_and_mixed_types_refused(self):
        self.assert_refused(self.change_column(data_type="varbinary", length=32))
        self.assert_refused(self.change_column(data_type="char", length=32,
                                               charset="ascii", collation="ascii_bin"))
        self.assert_refused(self.change_column(length=32))

    def test_target_wrong_charset_or_collation_refused(self):
        state = source_state(hex32=True)
        self.assert_refused(replace(state, columns=(
            replace(state.columns[0], collation="ascii_general_ci"), *state.columns[1:],
        )), "downgrade")
        self.assert_refused(replace(state, columns=(
            replace(state.columns[0], charset="utf8mb4"), *state.columns[1:],
        )), "downgrade")

    def test_already_converted_schema_not_mistaken_for_fresh_source(self):
        self.assert_refused(source_state(hex32=True))
        self.assert_refused(self.state, "downgrade")

    def test_uuid_attributes_not_silently_discarded(self):
        for changes in ({"default": "UUID()"}, {"comment": "identity"},
                        {"extra": "DEFAULT_GENERATED"}):
            self.assert_refused(self.change_column(**changes))

    def test_generated_columns_refused(self):
        extra = ColumnState("users", "derived", "varchar", 32, True,
                            generation="hex(id)")
        self.assert_refused(replace(self.state, columns=(*self.state.columns, extra)))

    def test_new_identifier_requires_review(self):
        extra = ColumnState("users", "organization_id", "binary", 16, True)
        self.assert_refused(replace(self.state, columns=(*self.state.columns, extra)))

    def test_unreviewed_table_refused(self):
        self.assert_refused(self.change_column(table="unreviewed"))

    def test_sql_identifier_injection_refused(self):
        for name in ("id`", "id; DROP TABLE users", "id\n", "id.name", ""):
            with self.assertRaises(MigrationPlanError):
                quoted(name)
        self.assertEqual(quoted("updated_at"), "`updated_at`")


if __name__ == "__main__":
    unittest.main()
