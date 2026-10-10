"""Structural receipt migration checks only, not a database upgrade."""

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "alembic/versions/20261010_add_schedule_conversion_receipts.py"


class ReceiptMigrationTests(unittest.TestCase):
    def test_new_revision_follows_p4_schedules(self):
        tree = ast.parse(MIGRATION.read_text())
        values = {node.target.id: ast.literal_eval(node.value) for node in tree.body
                  if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)}
        self.assertEqual(values["revision"], "p4_convert_receipts")
        self.assertEqual(values["down_revision"], "p4_schedules")

    def test_upgrade_adds_only_nullable_receipt_to_schedules(self):
        tree = ast.parse(MIGRATION.read_text())
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Attribute) and node.func.attr == "add_column"]
        self.assertEqual(len(calls), 1)
        self.assertEqual(ast.literal_eval(calls[0].args[0]), "schedules")
        column = calls[0].args[1]
        self.assertEqual(ast.literal_eval(column.args[0]), "converted_receipt")
        self.assertEqual(column.args[1].func.attr, "JSON")
        nullable = next(ast.literal_eval(k.value) for k in column.keywords if k.arg == "nullable")
        self.assertTrue(nullable)
        self.assertNotIn("op.execute", MIGRATION.read_text())

    def test_downgrade_never_drops_source_identity_or_other_tables(self):
        tree = ast.parse(MIGRATION.read_text())
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Attribute) and node.func.attr == "drop_column"]
        dropped = [ast.literal_eval(arg) for arg in calls[0].args]
        self.assertEqual(dropped, ["schedules", "converted_receipt"])
        self.assertNotIn("drop_table", MIGRATION.read_text())
        source = (ROOT / "app/models/schedule.py").read_text()
        self.assertIn("converted_receipt: Mapped[dict | None] = mapped_column(JSON)", source)
