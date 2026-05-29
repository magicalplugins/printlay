"""Create spot_colours table for user-managed spot colour presets.

Revision ID: 0029
Revises: 0028
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "spot_colours",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("display_color", sa.String(length=20), nullable=False, server_default="'#FF00FF'"),
        sa.Column("sort_order", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_spot_colours")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            ondelete="CASCADE",
            name=op.f("fk_spot_colours_user_id_users"),
        ),
    )
    op.create_index(
        op.f("ix_spot_colours_user_id"),
        "spot_colours",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_spot_colours_user_id"), table_name="spot_colours")
    op.drop_table("spot_colours")
