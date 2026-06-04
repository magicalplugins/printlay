"""Affiliate funnel events (signups / leads) tracking.

Revision ID: 0037
Revises: 0036
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0037"
down_revision = "0036"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "affiliate_events",
        sa.Column("id", UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("affiliate_id", UUID(as_uuid=True), nullable=False),
        sa.Column("event_type", sa.String(24), nullable=False),
        sa.Column("referred_user_id", UUID(as_uuid=True), nullable=True),
        sa.Column("lead_id", UUID(as_uuid=True), nullable=True),
        sa.Column("detail", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_affiliate_events")),
        sa.ForeignKeyConstraint(["affiliate_id"], ["affiliate_profiles.id"], name=op.f("fk_affiliate_events_affiliate_id_affiliate_profiles"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["referred_user_id"], ["users.id"], name=op.f("fk_affiliate_events_referred_user_id_users"), ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["lead_id"], ["leads.id"], name=op.f("fk_affiliate_events_lead_id_leads"), ondelete="SET NULL"),
    )
    op.create_index(op.f("ix_affiliate_events_affiliate_id"), "affiliate_events", ["affiliate_id"])
    op.create_index(op.f("ix_affiliate_events_event_type"), "affiliate_events", ["event_type"])


def downgrade() -> None:
    op.drop_index(op.f("ix_affiliate_events_event_type"), table_name="affiliate_events")
    op.drop_index(op.f("ix_affiliate_events_affiliate_id"), table_name="affiliate_events")
    op.drop_table("affiliate_events")
