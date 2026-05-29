"""Add spot colour columns for cut lines, sub-sheets, marks.

Revision ID: 0028
Revises: 0027
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sticker_sheets", sa.Column("spot_color_cutlines", sa.String(40), nullable=True))
    op.add_column("sticker_sheets", sa.Column("spot_color_subsheets", sa.String(40), nullable=True))
    op.add_column("sticker_sheets", sa.Column("spot_color_marks", sa.String(40), nullable=True))


def downgrade() -> None:
    op.drop_column("sticker_sheets", "spot_color_marks")
    op.drop_column("sticker_sheets", "spot_color_subsheets")
    op.drop_column("sticker_sheets", "spot_color_cutlines")
