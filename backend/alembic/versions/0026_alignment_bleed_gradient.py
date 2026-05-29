"""Add sticker alignment, bleed, and gradient columns.

Revision ID: 0026
Revises: 0025
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sticker_sheets", sa.Column("sticker_align_h", sa.String(10), nullable=True))
    op.add_column("sticker_sheets", sa.Column("sticker_align_v", sa.String(10), nullable=True))
    op.add_column("sticker_sheets", sa.Column("sub_sheet_bleed_mm", sa.Float, nullable=True))
    op.add_column("sticker_sheets", sa.Column("sub_sheet_fill_color2", sa.String(20), nullable=True))
    op.add_column("sticker_sheets", sa.Column("sub_sheet_gradient_angle", sa.Float, nullable=True))


def downgrade() -> None:
    op.drop_column("sticker_sheets", "sub_sheet_gradient_angle")
    op.drop_column("sticker_sheets", "sub_sheet_fill_color2")
    op.drop_column("sticker_sheets", "sub_sheet_bleed_mm")
    op.drop_column("sticker_sheets", "sticker_align_v")
    op.drop_column("sticker_sheets", "sticker_align_h")
