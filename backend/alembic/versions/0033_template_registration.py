"""Add cutter registration settings to templates.

Revision ID: 0033
Revises: 0032
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0033"
down_revision = "0032"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "templates",
        sa.Column("registration_type", sa.String(length=16), nullable=True),
    )
    op.add_column(
        "templates",
        sa.Column(
            "mark_offset_mm",
            sa.Float(),
            nullable=False,
            server_default="5.0",
        ),
    )
    op.add_column(
        "templates",
        sa.Column("max_zone_length_mm", sa.Float(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("templates", "max_zone_length_mm")
    op.drop_column("templates", "mark_offset_mm")
    op.drop_column("templates", "registration_type")
