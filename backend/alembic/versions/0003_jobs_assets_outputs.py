"""jobs, asset_categories, assets, outputs

Revision ID: 0003
Revises: 0002
Create Date: 2026-04-17

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def _id_col() -> sa.Column:
    return sa.Column(
        "id",
        postgresql.UUID(as_uuid=True),
        server_default=sa.text("gen_random_uuid()"),
        nullable=False,
    )


def _user_fk(name: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["user_id"], ["users.id"], ondelete="CASCADE", name=op.f(f"fk_{name}_user_id_users")
    )


def _created_col() -> sa.Column:
    return sa.Column(
        "created_at",
        sa.DateTime(timezone=True),
        server_default=sa.text("now()"),
        nullable=False,
    )


def upgrade() -> None:
    op.create_table(
        "asset_categories",
        _id_col(),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        _created_col(),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_asset_categories")),
        _user_fk("asset_categories"),
    )
    op.create_index(
        op.f("ix_asset_categories_user_id"),
        "asset_categories",
        ["user_id"],
    )

    op.create_table(
        "assets",
        _id_col(),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("category_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=False),
        sa.Column("r2_key", sa.String(length=512), nullable=False),
        sa.Column("r2_key_original", sa.String(length=512), nullable=True),
        sa.Column("thumbnail_r2_key", sa.String(length=512), nullable=True),
        sa.Column("width_pt", sa.Float(), nullable=False),
        sa.Column("height_pt", sa.Float(), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False, server_default="0"),
        _created_col(),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_assets")),
        _user_fk("assets"),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["asset_categories.id"],
            ondelete="CASCADE",
            name=op.f("fk_assets_category_id_asset_categories"),
        ),
        sa.CheckConstraint(
            "kind in ('pdf','svg','png','jpg')", name=op.f("ck_assets_kind")
        ),
    )
    op.create_index(op.f("ix_assets_user_id"), "assets", ["user_id"])
    op.create_index(op.f("ix_assets_category_id"), "assets", ["category_id"])

    op.create_table(
        "jobs",
        _id_col(),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("template_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column(
            "slot_order",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "assignments",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        _created_col(),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_jobs")),
        _user_fk("jobs"),
        sa.ForeignKeyConstraint(
            ["template_id"],
            ["templates.id"],
            ondelete="CASCADE",
            name=op.f("fk_jobs_template_id_templates"),
        ),
    )
    op.create_index(op.f("ix_jobs_user_id"), "jobs", ["user_id"])
    op.create_index(op.f("ix_jobs_template_id"), "jobs", ["template_id"])

    op.create_table(
        "outputs",
        _id_col(),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("job_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("r2_key", sa.String(length=512), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("slots_filled", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("slots_total", sa.Integer(), nullable=False, server_default="0"),
        _created_col(),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_outputs")),
        _user_fk("outputs"),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["jobs.id"],
            ondelete="CASCADE",
            name=op.f("fk_outputs_job_id_jobs"),
        ),
    )
    op.create_index(op.f("ix_outputs_user_id"), "outputs", ["user_id"])
    op.create_index(op.f("ix_outputs_job_id"), "outputs", ["job_id"])


def downgrade() -> None:
    op.drop_table("outputs")
    op.drop_table("jobs")
    op.drop_table("assets")
    op.drop_table("asset_categories")
