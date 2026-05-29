"""Add optional phone column to leads table.

Phone is offered (but not required) for pre-sales enquiries so the
admin can call back quickly when someone's actively shopping.

Revision ID: 0021
Revises: 0020
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "leads",
        sa.Column("phone", sa.String(40), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("leads", "phone")
