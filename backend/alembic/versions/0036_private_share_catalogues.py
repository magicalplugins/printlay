"""Add is_private_share to asset_categories for private catalogue sharing.

Revision ID: 0036
Revises: 0035
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0036"
down_revision = "0035"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "asset_categories",
        sa.Column("is_private_share", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("asset_categories", "is_private_share")
