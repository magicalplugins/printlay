"""Add placement_r2_key to assets for fast generation.

Revision ID: 0044
"""
from alembic import op
import sqlalchemy as sa

revision = "0044"
down_revision = "0043"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE assets ADD COLUMN IF NOT EXISTS placement_r2_key VARCHAR(512)"
    )


def downgrade() -> None:
    op.drop_column("assets", "placement_r2_key")
