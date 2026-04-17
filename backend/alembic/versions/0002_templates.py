"""templates table

Revision ID: 0002
Revises: 0001
Create Date: 2026-04-17

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "templates",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("units", sa.String(length=8), nullable=False, server_default="mm"),
        sa.Column("r2_key", sa.String(length=512), nullable=False),
        sa.Column("page_width", sa.Float(), nullable=False),
        sa.Column("page_height", sa.Float(), nullable=False),
        sa.Column(
            "positions_layer",
            sa.String(length=64),
            nullable=False,
            server_default="POSITIONS",
        ),
        sa.Column(
            "has_ocg",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("shapes", postgresql.JSONB(), nullable=False),
        sa.Column("generation_params", postgresql.JSONB(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_templates")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            ondelete="CASCADE",
            name=op.f("fk_templates_user_id_users"),
        ),
        sa.CheckConstraint(
            "source in ('uploaded','generated')",
            name=op.f("ck_templates_source"),
        ),
    )
    op.create_index(
        op.f("ix_templates_user_id"), "templates", ["user_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_templates_user_id"), table_name="templates")
    op.drop_table("templates")
