"""Add min_length_m to pricing_profiles for minimum billable length.

Revision ID: 0046
"""
from alembic import op
import sqlalchemy as sa


revision = "0046"
down_revision = "0045"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE pricing_profiles ADD COLUMN IF NOT EXISTS min_length_m FLOAT NOT NULL DEFAULT 0.0"
    )


def downgrade() -> None:
    op.drop_column("pricing_profiles", "min_length_m")
