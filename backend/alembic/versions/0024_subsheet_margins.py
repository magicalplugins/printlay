"""Add sub_sheet_gap_mm and sub_sheet_padding_mm to sticker_sheets.

Revision ID: 0024
Revises: 0023
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sticker_sheets",
        sa.Column("sub_sheet_gap_mm", sa.Float, nullable=False, server_default="5.0"),
    )
    op.add_column(
        "sticker_sheets",
        sa.Column("sub_sheet_padding_mm", sa.Float, nullable=False, server_default="5.0"),
    )


def downgrade() -> None:
    op.drop_column("sticker_sheets", "sub_sheet_padding_mm")
    op.drop_column("sticker_sheets", "sub_sheet_gap_mm")
