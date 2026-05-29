"""Add page_count to assets table.

Multi-page PDFs (e.g. double-sided sticker artwork) need per-assignment
page selection. Default 1 covers every existing asset — they were all
treated as single-page before this migration.

Revision ID: 0022
Revises: 0021
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "assets",
        sa.Column(
            "page_count",
            sa.Integer(),
            nullable=False,
            server_default="1",
        ),
    )


def downgrade() -> None:
    op.drop_column("assets", "page_count")
