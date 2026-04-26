"""color profiles for per-printer RGB swap rules

Revision ID: 0009
Revises: 0008
Create Date: 2026-04-18

Wave 1 of the colour-swap feature: per-user named profiles holding an
ordered list of exact RGB swaps, plus per-job draft swaps and an
optional FK link from a job to a profile.

Why two storage spots on `jobs`:

* `color_profile_id` is the live link. Editing the profile flows
  through to every linked job at the next generate (swaps are
  resolved fresh, never snapshotted).
* `color_swaps_draft` is a JSONB list of swaps the user has been
  tweaking on the job page but hasn't yet promoted to a saved
  profile - lets them iterate without naming things prematurely.

The actual swap structure (validated server-side) is:
    [{"source": [r,g,b], "target": [r,g,b], "label": "Card red"}, ...]

Both colour values are 0-255 sRGB integers. The pikepdf rewriter
emits them as `r g b rg` / `r g b RG` (DeviceRGB) so Adobe's picker
reads back the exact same triplet you typed.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "color_profiles",
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
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column(
            "swaps",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
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
        sa.PrimaryKeyConstraint("id", name=op.f("pk_color_profiles")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            ondelete="CASCADE",
            name=op.f("fk_color_profiles_user_id_users"),
        ),
    )
    op.create_index(
        op.f("ix_color_profiles_user_id"),
        "color_profiles",
        ["user_id"],
    )

    op.add_column(
        "jobs",
        sa.Column(
            "color_profile_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    # SET NULL on profile delete so old jobs keep working - they just
    # generate without swaps until the user attaches a new profile.
    op.create_foreign_key(
        op.f("fk_jobs_color_profile_id_color_profiles"),
        "jobs",
        "color_profiles",
        ["color_profile_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        op.f("ix_jobs_color_profile_id"),
        "jobs",
        ["color_profile_id"],
    )

    op.add_column(
        "jobs",
        sa.Column(
            "color_swaps_draft",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("jobs", "color_swaps_draft")
    op.drop_index(op.f("ix_jobs_color_profile_id"), table_name="jobs")
    op.drop_constraint(
        op.f("fk_jobs_color_profile_id_color_profiles"),
        "jobs",
        type_="foreignkey",
    )
    op.drop_column("jobs", "color_profile_id")
    op.drop_index(op.f("ix_color_profiles_user_id"), table_name="color_profiles")
    op.drop_table("color_profiles")
