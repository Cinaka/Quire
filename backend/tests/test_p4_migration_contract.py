"""Offline structural checks only; these do not run Alembic or connect to MySQL."""

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "alembic/versions/20261008_add_schedules.py"
MODEL = ROOT / "app/models/schedule.py"


def calls(tree: ast.AST, attribute: str) -> list[ast.Call]:
    return [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and (
            (isinstance(node.func, ast.Attribute) and node.func.attr == attribute)
            or (isinstance(node.func, ast.Name) and node.func.id == attribute)
        )
    ]


class MigrationContractTests(unittest.TestCase):
    def test_revision_and_no_other_table_mutation(self) -> None:
        tree = ast.parse(MIGRATION.read_text())
        revisions = {
            node.target.id: ast.literal_eval(node.value)
            for node in tree.body
            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)
        }
        self.assertEqual(revisions["revision"], "p4_schedules")
        self.assertEqual(revisions["down_revision"], "p3_checkins")
        self.assertEqual(
            [ast.literal_eval(c.args[0]) for c in calls(tree, "create_table")], ["schedules"],
        )
        self.assertEqual(
            [ast.literal_eval(c.args[0]) for c in calls(tree, "drop_table")], ["schedules"],
        )
        self.assertFalse(calls(tree, "add_column") or calls(tree, "alter_column"))

    def test_columns_and_mysql_time_precision(self) -> None:
        tree = ast.parse(MIGRATION.read_text())
        columns = {ast.literal_eval(c.args[0]): c for c in calls(tree, "Column")}
        self.assertEqual(set(columns), {
            "id", "user_id", "remind_date", "title", "content", "content_text", "status",
            "converted_entry_id", "converted_at", "client_updated_at", "deleted_at",
            "created_at", "updated_at",
        })
        for name in ["converted_at", "client_updated_at", "deleted_at", "created_at", "updated_at"]:
            column_type = columns[name].args[1]
            self.assertEqual(column_type.func.attr, "DATETIME")
            self.assertEqual(ast.literal_eval(column_type.keywords[0].value), 3)
        for name in ["id", "user_id", "converted_entry_id"]:
            self.assertEqual(ast.literal_eval(columns[name].args[1].args[0]), 16)

    def test_model_and_migration_share_indexes_and_constraints(self) -> None:
        migration = ast.parse(MIGRATION.read_text())
        model = ast.parse(MODEL.read_text())
        model_indexes = {ast.literal_eval(c.args[0]) for c in calls(model, "Index")}
        migration_indexes = {ast.literal_eval(c.args[0]) for c in calls(migration, "create_index")}
        self.assertEqual(model_indexes, migration_indexes)
        for attribute in ["CheckConstraint", "UniqueConstraint"]:
            left = {
                ast.literal_eval(k.value) for c in calls(model, attribute)
                for k in c.keywords if k.arg == "name"
            }
            right = {
                ast.literal_eval(k.value) for c in calls(migration, attribute)
                for k in c.keywords if k.arg == "name"
            }
            self.assertEqual(left, right)
            self.assertTrue(left)
        source = MODEL.read_text()
        self.assertIn("converted_entry_id = id", source)
        self.assertNotIn("ForeignKey", source)

    def test_model_is_registered_for_alembic(self) -> None:
        source = (ROOT / "app/models/__init__.py").read_text()
        self.assertIn("from app.models.schedule import Schedule", source)
        self.assertIn('"Schedule"', source)


if __name__ == "__main__":
    unittest.main()
