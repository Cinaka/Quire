"""add users.token_version

Revision ID: p2_token_version
Revises: 205a34a57552
"""
from alembic import op
import sqlalchemy as sa

revision = "p2_token_version"
down_revision = "205a34a57552"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("token_version", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("users", "token_version")
