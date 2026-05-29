"""Add cutter_presets and sticker_sheets tables.

Sheet Builder: operators arrange stickers on production media with
registration marks, crop marks, and export print-ready PDFs.

Revision ID: 0023
Revises: 0022
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "cutter_presets",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("media_width_mm", sa.Float, nullable=False),
        sa.Column("registration_type", sa.String(20), nullable=True),
        sa.Column("max_zone_length_mm", sa.Float, nullable=True),
        sa.Column("mark_offset_mm", sa.Float, nullable=False, server_default="5.0"),
        sa.Column("default_gap_mm", sa.Float, nullable=False, server_default="3.0"),
        sa.Column("default_edge_margin_mm", sa.Float, nullable=False, server_default="5.0"),
        sa.Column("show_crop_marks", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_cutter_presets_user_id", "cutter_presets", ["user_id"])

    op.create_table(
        "sticker_sheets",
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(200), nullable=False, server_default="Untitled"),
        sa.Column("media_width_mm", sa.Float, nullable=False),
        sa.Column("media_height_mm", sa.Float, nullable=False),
        sa.Column("mode", sa.String(10), nullable=False, server_default="roll"),
        sa.Column("sub_sheet_size", sa.String(10), nullable=True),
        sa.Column("gap_mm", sa.Float, nullable=False, server_default="3.0"),
        sa.Column("edge_margin_mm", sa.Float, nullable=False, server_default="5.0"),
        sa.Column("show_crop_marks", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("registration_type", sa.String(20), nullable=True),
        sa.Column("max_zone_length_mm", sa.Float, nullable=True),
        sa.Column("mark_offset_mm", sa.Float, nullable=False, server_default="5.0"),
        sa.Column("placements", postgresql.JSONB, nullable=True),
        sa.Column("cutter_preset_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("output_r2_key", sa.String(512), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["cutter_preset_id"], ["cutter_presets.id"], ondelete="SET NULL"),
    )
    op.create_index("ix_sticker_sheets_user_id", "sticker_sheets", ["user_id"])


def downgrade() -> None:
    op.drop_table("sticker_sheets")
    op.drop_table("cutter_presets")
