"""Add DTF sheet builder columns to sticker_sheets.

Adds ``sheet_type`` ('sticker' or 'dtf') to control whether cut lines are
included in export, and ``mirror_output`` (bool) for DTF film printing.

Revision ID: 0042
Revises: 0041
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0042"
down_revision = "0041"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sticker_sheets",
        sa.Column("sheet_type", sa.String(length=10), nullable=True),
    )
    op.add_column(
        "sticker_sheets",
        sa.Column("mirror_output", sa.Boolean(), nullable=True),
    )
    op.execute("UPDATE sticker_sheets SET sheet_type = 'sticker' WHERE sheet_type IS NULL")
    op.execute("UPDATE sticker_sheets SET mirror_output = false WHERE mirror_output IS NULL")
    op.alter_column("sticker_sheets", "sheet_type", nullable=False, server_default="sticker")
    op.alter_column("sticker_sheets", "mirror_output", nullable=False, server_default="false")


def downgrade() -> None:
    op.drop_column("sticker_sheets", "mirror_output")
    op.drop_column("sticker_sheets", "sheet_type")
