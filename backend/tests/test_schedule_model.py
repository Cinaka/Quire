"""Model/DDL compilation tests; require project dependencies, not a running database."""

import unittest

from sqlalchemy.dialects import mysql
from sqlalchemy.schema import CreateIndex, CreateTable

from app.db.base import Base
from app.models.schedule import Schedule


class ScheduleModelTests(unittest.TestCase):
    def test_registered_table_and_native_types(self) -> None:
        table = Schedule.__table__
        self.assertIs(Base.metadata.tables["schedules"], table)
        self.assertEqual(table.c.id.type.impl.length, 16)
        self.assertEqual(table.c.remind_date.type.__class__.__name__, "Date")
        self.assertEqual(table.c.status.type.__class__.__name__, "TINYINT")
        self.assertFalse(table.c.client_updated_at.nullable)
        for name in ["created_at", "updated_at", "client_updated_at", "converted_at", "deleted_at"]:
            self.assertEqual(table.c[name].type.fsp, 3)
        self.assertFalse(table.foreign_keys)

    def test_mysql_ddl_preserves_identity_and_charset(self) -> None:
        ddl = str(CreateTable(Schedule.__table__).compile(dialect=mysql.dialect()))
        for part in ["InnoDB", "utf8mb4", "utf8mb4_0900_ai_ci", "uk_schedule_converted_entry",
                     "ck_schedule_status", "ck_schedule_conversion", "converted_entry_id = id"]:
            self.assertIn(part, ddl)

    def test_user_scoped_indexes_compile(self) -> None:
        columns = {index.name: [column.name for column in index.columns]
                   for index in Schedule.__table__.indexes}
        self.assertEqual(columns, {
            "idx_schedule_user_date": ["user_id", "remind_date"],
            "idx_schedule_user_updated": ["user_id", "updated_at", "id"],
            "idx_schedule_user_status_date": ["user_id", "status", "remind_date"],
        })
        for index in Schedule.__table__.indexes:
            self.assertIn("CREATE INDEX", str(CreateIndex(index).compile(dialect=mysql.dialect())))
