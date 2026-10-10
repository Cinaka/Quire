"""Add private immutable first-conversion verification; no P2/P3 changes.

Revision ID: p4_convert_receipts
Revises: p4_schedules
"""

import sqlalchemy as sa

from alembic import op

revision: str = "p4_convert_receipts"
down_revision: str = "p4_schedules"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # No guessed receipt backfill: legacy terminal identity must not be recreated.
    op.add_column("schedules", sa.Column("converted_receipt", sa.JSON(), nullable=True))


def downgrade() -> None:
    # Loses first-intent verification, NOT converted identity; back up before any downgrade.
    op.drop_column("schedules", "converted_receipt")
