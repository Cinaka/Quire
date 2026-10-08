"""add daily check-ins

Revision ID: p3_checkins
Revises: p2_refresh_sessions
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "p3_checkins"
down_revision = "p2_refresh_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "checkins",
        sa.Column("id", sa.BINARY(16), nullable=False),
        sa.Column("user_id", sa.BINARY(16), nullable=False),
        sa.Column("checkin_date", sa.Date(), nullable=False),
        sa.Column(
            "created_at",
            mysql.DATETIME(fsp=3),
            server_default=sa.text("CURRENT_TIMESTAMP(3)"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "checkin_date", name="uk_checkins_user_date"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_0900_ai_ci",
        mysql_engine="InnoDB",
    )


def downgrade() -> None:
    op.drop_table("checkins")
