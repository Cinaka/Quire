"""add refresh sessions

Revision ID: p2_refresh_sessions
Revises: p2_token_version
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

revision = "p2_refresh_sessions"
down_revision = "p2_token_version"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "refresh_sessions",
        sa.Column("id", sa.BINARY(16), nullable=False),
        sa.Column("user_id", sa.BINARY(16), nullable=False),
        sa.Column("token_version", sa.Integer(), nullable=False),
        sa.Column("expires_at", mysql.DATETIME(fsp=3), nullable=False),
        sa.Column("revoked_at", mysql.DATETIME(fsp=3), nullable=True),
        sa.Column(
            "created_at",
            mysql.DATETIME(fsp=3),
            server_default=sa.text("CURRENT_TIMESTAMP(3)"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_0900_ai_ci",
        mysql_engine="InnoDB",
    )
    op.create_index("idx_refresh_user", "refresh_sessions", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index("idx_refresh_user", table_name="refresh_sessions")
    op.drop_table("refresh_sessions")
