"""Affiliate system tables + user.referred_by_affiliate_id.

Revision ID: 0035
Revises: 0034
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0035"
down_revision = "0034"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "affiliate_profiles",
        sa.Column("id", UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), nullable=True),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("name", sa.String(200), nullable=True),
        sa.Column("ref_code", sa.String(32), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("stripe_connect_account_id", sa.String(64), nullable=True),
        sa.Column("stripe_connect_onboarding_complete", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("commission_rate", sa.Float(), nullable=False, server_default=sa.text("0.20")),
        sa.Column("min_payout_threshold_pence", sa.Integer(), nullable=False, server_default=sa.text("5000")),
        sa.Column("payout_day_of_month", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column("pending_balance_pence", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("total_earned_pence", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("total_paid_pence", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_affiliate_profiles")),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_affiliate_profiles_user_id_users"), ondelete="SET NULL"),
        sa.UniqueConstraint("user_id", name=op.f("uq_affiliate_profiles_user_id")),
        sa.UniqueConstraint("email", name=op.f("uq_affiliate_profiles_email")),
        sa.UniqueConstraint("ref_code", name=op.f("uq_affiliate_profiles_ref_code")),
    )

    op.create_table(
        "affiliate_clicks",
        sa.Column("id", UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("affiliate_id", UUID(as_uuid=True), nullable=False),
        sa.Column("ip_hash", sa.String(64), nullable=False),
        sa.Column("user_agent_snippet", sa.String(200), nullable=True),
        sa.Column("landing_path", sa.String(512), nullable=True),
        sa.Column("clicked_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("converted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_affiliate_clicks")),
        sa.ForeignKeyConstraint(["affiliate_id"], ["affiliate_profiles.id"], name=op.f("fk_affiliate_clicks_affiliate_id_affiliate_profiles"), ondelete="CASCADE"),
    )
    op.create_index(op.f("ix_affiliate_clicks_affiliate_id"), "affiliate_clicks", ["affiliate_id"])

    op.create_table(
        "affiliate_conversions",
        sa.Column("id", UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("affiliate_id", UUID(as_uuid=True), nullable=False),
        sa.Column("click_id", UUID(as_uuid=True), nullable=True),
        sa.Column("referred_user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("stripe_invoice_id", sa.String(64), nullable=True),
        sa.Column("stripe_charge_amount_pence", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("commission_pence", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("commission_type", sa.String(20), nullable=False, server_default="first_payment"),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("converted_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_affiliate_conversions")),
        sa.ForeignKeyConstraint(["affiliate_id"], ["affiliate_profiles.id"], name=op.f("fk_affiliate_conversions_affiliate_id_affiliate_profiles"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["click_id"], ["affiliate_clicks.id"], name=op.f("fk_affiliate_conversions_click_id_affiliate_clicks"), ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["referred_user_id"], ["users.id"], name=op.f("fk_affiliate_conversions_referred_user_id_users"), ondelete="CASCADE"),
    )
    op.create_index(op.f("ix_affiliate_conversions_affiliate_id"), "affiliate_conversions", ["affiliate_id"])

    op.create_table(
        "affiliate_payouts",
        sa.Column("id", UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("affiliate_id", UUID(as_uuid=True), nullable=False),
        sa.Column("stripe_transfer_id", sa.String(64), nullable=True),
        sa.Column("amount_pence", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("period_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_affiliate_payouts")),
        sa.ForeignKeyConstraint(["affiliate_id"], ["affiliate_profiles.id"], name=op.f("fk_affiliate_payouts_affiliate_id_affiliate_profiles"), ondelete="CASCADE"),
    )
    op.create_index(op.f("ix_affiliate_payouts_affiliate_id"), "affiliate_payouts", ["affiliate_id"])

    op.add_column(
        "users",
        sa.Column(
            "referred_by_affiliate_id",
            UUID(as_uuid=True),
            sa.ForeignKey("affiliate_profiles.id", ondelete="SET NULL", name=op.f("fk_users_referred_by_affiliate_id_affiliate_profiles")),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "referred_by_affiliate_id")
    op.drop_table("affiliate_payouts")
    op.drop_table("affiliate_conversions")
    op.drop_table("affiliate_clicks")
    op.drop_table("affiliate_profiles")
