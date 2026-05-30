"""Add sticker_session_prefix to assets for re-editable stickers.

Revision ID: 0034
Revises: 0033
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0034"
down_revision = "0033"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "assets",
        sa.Column("sticker_session_prefix", sa.String(length=512), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("assets", "sticker_session_prefix")
