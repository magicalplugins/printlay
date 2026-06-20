"""Add optimised_at to jobs for tracking bulk optimisation.

Revision ID: 0045
"""
from alembic import op
import sqlalchemy as sa

revision = "0045"
down_revision = "0044"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS optimised_at TIMESTAMPTZ"
    )


def downgrade() -> None:
    op.drop_column("jobs", "optimised_at")
