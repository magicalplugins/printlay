"""Add spot_colors table for per-user named PDF Separation colours.

Revision ID: 0012
Revises: 0011
Create Date: 2026-04-29

Drives the new "include cut lines" feature on PDF generation. The user
maintains a personal library of named spot colours (e.g. ``CutContour``
for Roland, ``Through-cut`` for Mimaki) with a preview RGB used as the
Separation's DeviceRGB alternate. At generate time the compositor draws
each slot's outline as a stroked path tinted with the chosen Separation,
which print/cut RIPs route to the cutter rather than the printer.

The partial unique index enforces the "at most one default cut-line per
user" invariant. New users start empty and are seeded with sensible
presets (Roland CutContour, Mimaki Through-cut, Score) on first read.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "spot_colors",
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
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column(
            "rgb",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column(
            "is_cut_line_default",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_spot_colors")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            ondelete="CASCADE",
            name=op.f("fk_spot_colors_user_id_users"),
        ),
    )
    op.create_index(
        op.f("ix_spot_colors_user_id"),
        "spot_colors",
        ["user_id"],
    )
    # At most one is_cut_line_default per user. Partial index because
    # the constraint only applies to TRUE rows; a user can have many
    # FALSE rows and they don't conflict.
    op.create_index(
        "uq_spot_colors_user_default_cut_line",
        "spot_colors",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("is_cut_line_default"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_spot_colors_user_default_cut_line",
        table_name="spot_colors",
    )
    op.drop_index(op.f("ix_spot_colors_user_id"), table_name="spot_colors")
    op.drop_table("spot_colors")
