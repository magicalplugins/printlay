"""Add trial_invites table for admin-issued extended-trial invites.

Revision ID: 0015
Revises: 0014
Create Date: 2026-05-21

Single-use links granting >7-day trials to hand-picked prospects. See
backend/models/trial_invite.py for lifecycle.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "trial_invites",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.Column("trial_days", sa.Integer(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "invited_by_user_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "accepted_user_id", postgresql.UUID(as_uuid=True), nullable=True
        ),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["invited_by_user_id"],
            ["users.id"],
            ondelete="SET NULL",
            name=op.f("fk_trial_invites_invited_by_user_id_users"),
        ),
        sa.ForeignKeyConstraint(
            ["accepted_user_id"],
            ["users.id"],
            ondelete="SET NULL",
            name=op.f("fk_trial_invites_accepted_user_id_users"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trial_invites")),
        sa.UniqueConstraint("token", name=op.f("uq_trial_invites_token")),
    )
    op.create_index(
        op.f("ix_trial_invites_email"), "trial_invites", ["email"], unique=False
    )
    op.create_index(
        op.f("ix_trial_invites_token"), "trial_invites", ["token"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_trial_invites_token"), table_name="trial_invites")
    op.drop_index(op.f("ix_trial_invites_email"), table_name="trial_invites")
    op.drop_table("trial_invites")
