"""Ghost affiliates: vanity slugs + invite attribution.

Adds:
  - affiliate_profiles.is_ghost            (admin-created partner flag)
  - affiliate_profiles.vanity_slug         (printlay.co.uk/<slug> link)
  - affiliate_profiles.welcome_email_sent_at
  - trial_invites.affiliate_id             (which affiliate promoted an invite)

Revision ID: 0038
Revises: 0037
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0038"
down_revision = "0037"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "affiliate_profiles",
        sa.Column("is_ghost", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "affiliate_profiles",
        sa.Column("vanity_slug", sa.String(40), nullable=True),
    )
    op.add_column(
        "affiliate_profiles",
        sa.Column("welcome_email_sent_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_unique_constraint(
        op.f("uq_affiliate_profiles_vanity_slug"),
        "affiliate_profiles",
        ["vanity_slug"],
    )

    op.add_column(
        "trial_invites",
        sa.Column("affiliate_id", UUID(as_uuid=True), nullable=True),
    )
    op.create_index(
        op.f("ix_trial_invites_affiliate_id"),
        "trial_invites",
        ["affiliate_id"],
    )
    op.create_foreign_key(
        op.f("fk_trial_invites_affiliate_id_affiliate_profiles"),
        "trial_invites",
        "affiliate_profiles",
        ["affiliate_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # Drop the server_default now that existing rows are backfilled — the
    # model owns the default going forward.
    op.alter_column("affiliate_profiles", "is_ghost", server_default=None)


def downgrade() -> None:
    op.drop_constraint(
        op.f("fk_trial_invites_affiliate_id_affiliate_profiles"),
        "trial_invites",
        type_="foreignkey",
    )
    op.drop_index(op.f("ix_trial_invites_affiliate_id"), table_name="trial_invites")
    op.drop_column("trial_invites", "affiliate_id")

    op.drop_constraint(
        op.f("uq_affiliate_profiles_vanity_slug"),
        "affiliate_profiles",
        type_="unique",
    )
    op.drop_column("affiliate_profiles", "welcome_email_sent_at")
    op.drop_column("affiliate_profiles", "vanity_slug")
    op.drop_column("affiliate_profiles", "is_ghost")
