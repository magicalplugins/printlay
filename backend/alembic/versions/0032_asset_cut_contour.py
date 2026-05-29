"""Add cut_contour_json to assets (custom sticker cut line).

Revision ID: 0032
Revises: 0031
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0032"
down_revision = "0031"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("assets", sa.Column("cut_contour_json", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("assets", "cut_contour_json")
