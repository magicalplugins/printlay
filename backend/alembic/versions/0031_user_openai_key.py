"""Add per-user encrypted OpenAI API key column.

Revision ID: 0031
Revises: 0030
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("openai_api_key_enc", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "openai_api_key_enc")
