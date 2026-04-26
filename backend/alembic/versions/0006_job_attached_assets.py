"""job-attached (ephemeral) assets

Revision ID: 0006
Revises: 0005
Create Date: 2026-04-18

Adds support for assets that are uploaded directly into a Job (not the
catalogue). These have `job_id` set and `category_id` NULL. They never
appear in the catalogue UI, and are deleted when the parent Job is deleted.

Changes:
    - assets.category_id: NOT NULL -> NULLABLE
    - assets.job_id: new nullable FK -> jobs.id ON DELETE CASCADE
    - CHECK (category_id IS NOT NULL OR job_id IS NOT NULL)
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("assets", "category_id", existing_type=sa.dialects.postgresql.UUID(), nullable=True)
    op.add_column(
        "assets",
        sa.Column("job_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        op.f("fk_assets_job_id_jobs"),
        "assets",
        "jobs",
        ["job_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(op.f("ix_assets_job_id"), "assets", ["job_id"])
    op.create_check_constraint(
        op.f("ck_assets_category_or_job"),
        "assets",
        "category_id IS NOT NULL OR job_id IS NOT NULL",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_assets_category_or_job"), "assets", type_="check")
    op.drop_index(op.f("ix_assets_job_id"), table_name="assets")
    op.drop_constraint(op.f("fk_assets_job_id_jobs"), "assets", type_="foreignkey")
    op.drop_column("assets", "job_id")
    op.alter_column("assets", "category_id", existing_type=sa.dialects.postgresql.UUID(), nullable=False)
