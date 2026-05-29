"""Add sub-sheet customisation columns.

Background image, fill colour/gradient, title text and font.

Revision ID: 0025
Revises: 0024
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sticker_sheets", sa.Column("sub_sheet_bg_r2_key", sa.String(512), nullable=True))
    op.add_column("sticker_sheets", sa.Column("sub_sheet_bg_url", sa.String(1024), nullable=True))
    op.add_column("sticker_sheets", sa.Column("sub_sheet_fill_color", sa.String(100), nullable=True))
    op.add_column("sticker_sheets", sa.Column("sub_sheet_title", sa.String(200), nullable=True))
    op.add_column("sticker_sheets", sa.Column("sub_sheet_title_font", sa.String(60), nullable=True))
    op.add_column("sticker_sheets", sa.Column("sub_sheet_title_size_mm", sa.Float, nullable=True))


def downgrade() -> None:
    op.drop_column("sticker_sheets", "sub_sheet_title_size_mm")
    op.drop_column("sticker_sheets", "sub_sheet_title_font")
    op.drop_column("sticker_sheets", "sub_sheet_title")
    op.drop_column("sticker_sheets", "sub_sheet_fill_color")
    op.drop_column("sticker_sheets", "sub_sheet_bg_url")
    op.drop_column("sticker_sheets", "sub_sheet_bg_r2_key")
