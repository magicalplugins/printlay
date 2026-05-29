"""Add category column to leads table.

Categories collected at submission time so the admin inbox can be
triaged faster as volume grows. Existing leads default to "general"
(was the implicit pre-category meaning).

Revision ID: 0020
Revises: 0019
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "leads",
        sa.Column(
            "category",
            sa.String(32),
            nullable=False,
            server_default="general",
        ),
    )
    op.create_index("ix_leads_category", "leads", ["category"])


def downgrade() -> None:
    op.drop_index("ix_leads_category", table_name="leads")
    op.drop_column("leads", "category")
