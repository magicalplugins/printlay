"""Add stripe_events table for webhook idempotency.

Revision ID: 0011
Revises: 0010
Create Date: 2026-04-25
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "stripe_events",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("type", sa.String(length=96), nullable=False),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_stripe_events_type", "stripe_events", ["type"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_stripe_events_type", table_name="stripe_events")
    op.drop_table("stripe_events")
