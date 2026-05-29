"""Add custom sub-sheet dimension columns.

Revision ID: 0030
Revises: 0029
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0030"
down_revision = "0029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sticker_sheets", sa.Column("sub_sheet_custom_w_mm", sa.Float(), nullable=True))
    op.add_column("sticker_sheets", sa.Column("sub_sheet_custom_h_mm", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("sticker_sheets", "sub_sheet_custom_h_mm")
    op.drop_column("sticker_sheets", "sub_sheet_custom_w_mm")
