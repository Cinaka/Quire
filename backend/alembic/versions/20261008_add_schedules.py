"""Add P4 schedules without changing P2/P3 data.

Revision ID: p4_schedules
Revises: p3_checkins
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision: str = "p4_schedules"
down_revision: str = "p3_checkins"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "schedules",
        sa.Column("id", sa.BINARY(16), nullable=False),
        sa.Column("user_id", sa.BINARY(16), nullable=False),
        sa.Column("remind_date", sa.Date(), nullable=False),
        sa.Column("title", sa.String(255), nullable=True),
        sa.Column("content", sa.JSON(), nullable=True),
        sa.Column("content_text", mysql.MEDIUMTEXT(), nullable=True),
        sa.Column("status", mysql.TINYINT(), server_default=sa.text("0"), nullable=False),
        sa.Column("converted_entry_id", sa.BINARY(16), nullable=True),
        sa.Column("converted_at", mysql.DATETIME(fsp=3), nullable=True),
        sa.Column("client_updated_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("deleted_at", mysql.DATETIME(fsp=3), nullable=True),
        sa.Column(
            "created_at", mysql.DATETIME(fsp=3),
            server_default=sa.text("CURRENT_TIMESTAMP(3)"), nullable=False,
        ),
        sa.Column(
            "updated_at", mysql.DATETIME(fsp=3),
            server_default=sa.text("CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("converted_entry_id", name="uk_schedule_converted_entry"),
        sa.CheckConstraint("status IN (0, 1)", name="ck_schedule_status"),
        sa.CheckConstraint(
            "(status = 0 AND converted_entry_id IS NULL AND converted_at IS NULL) OR "
            "(status = 1 AND converted_entry_id IS NOT NULL "
            "AND converted_entry_id = id AND converted_at IS NOT NULL)",
            name="ck_schedule_conversion",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_0900_ai_ci",
    )
    op.create_index("idx_schedule_user_date", "schedules", ["user_id", "remind_date"])
    op.create_index("idx_schedule_user_updated", "schedules", ["user_id", "updated_at", "id"])
    op.create_index(
        "idx_schedule_user_status_date", "schedules", ["user_id", "status", "remind_date"],
    )


def downgrade() -> None:
    # 有损：删除预简与永久来源身份。部署降级前必须备份并获得明确确认。
    op.drop_index("idx_schedule_user_status_date", table_name="schedules")
    op.drop_index("idx_schedule_user_updated", table_name="schedules")
    op.drop_index("idx_schedule_user_date", table_name="schedules")
    op.drop_table("schedules")
