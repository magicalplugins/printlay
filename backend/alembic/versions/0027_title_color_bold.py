"""Add title_color and title_bold columns.

Revision ID: 0027
Revises: 0026
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sticker_sheets", sa.Column("sub_sheet_title_color", sa.String(20), nullable=True))
    op.add_column("sticker_sheets", sa.Column("sub_sheet_title_bold", sa.Boolean, nullable=True))


def downgrade() -> None:
    op.drop_column("sticker_sheets", "sub_sheet_title_bold")
    op.drop_column("sticker_sheets", "sub_sheet_title_color")
