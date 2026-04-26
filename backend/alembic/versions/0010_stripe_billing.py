"""Replace LMFWC license columns with Stripe billing columns + trial support.

Revision ID: 0010
Revises: 0009
Create Date: 2026-04-25

Changes:
  - Drop license_key, license_status, license_expires_at,
    license_activations_used, license_activations_max, license_validated_at
  - Add trial_ends_at, stripe_customer_id, stripe_subscription_id,
    stripe_subscription_status, stripe_price_id, stripe_current_period_end,
    founder_member
  - Rename tier values: 'expert' -> 'studio', 'professional' -> 'pro',
    'internal_beta' -> 'locked' (existing users in dev had full access;
    prod users will be given a proper trial by the auth flow going forward)
  - Reset tier default to 'locked' (entitlements layer derives real plan
    from stripe_* columns and trial_ends_at)
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ---- Drop LMFWC license columns ----
    op.drop_constraint("uq_users_license_key", "users", type_="unique")
    op.drop_column("users", "license_key")
    op.drop_column("users", "license_status")
    op.drop_column("users", "license_expires_at")
    op.drop_column("users", "license_activations_used")
    op.drop_column("users", "license_activations_max")
    op.drop_column("users", "license_validated_at")

    # ---- Add trial column ----
    op.add_column(
        "users",
        sa.Column("trial_ends_at", sa.DateTime(timezone=True), nullable=True),
    )

    # ---- Add Stripe columns ----
    op.add_column(
        "users",
        sa.Column("stripe_customer_id", sa.String(length=64), nullable=True),
    )
    op.create_unique_constraint(
        "uq_users_stripe_customer_id", "users", ["stripe_customer_id"]
    )
    op.add_column(
        "users",
        sa.Column("stripe_subscription_id", sa.String(length=64), nullable=True),
    )
    op.create_unique_constraint(
        "uq_users_stripe_subscription_id", "users", ["stripe_subscription_id"]
    )
    op.add_column(
        "users",
        sa.Column("stripe_subscription_status", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("stripe_price_id", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column(
            "stripe_current_period_end", sa.DateTime(timezone=True), nullable=True
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "founder_member",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )

    # ---- Rename tier values ----
    # expert -> studio, professional -> pro, internal_beta -> locked
    op.execute(
        "UPDATE users SET tier = 'studio' WHERE tier = 'expert'"
    )
    op.execute(
        "UPDATE users SET tier = 'pro' WHERE tier = 'professional'"
    )
    op.execute(
        "UPDATE users SET tier = 'locked' WHERE tier = 'internal_beta'"
    )

    # Update column default
    op.alter_column(
        "users",
        "tier",
        existing_type=sa.String(length=32),
        server_default="locked",
    )


def downgrade() -> None:
    # Reverse tier renames
    op.execute("UPDATE users SET tier = 'internal_beta' WHERE tier = 'locked'")
    op.execute("UPDATE users SET tier = 'professional' WHERE tier = 'pro'")
    op.execute("UPDATE users SET tier = 'studio' WHERE tier = 'expert'")

    op.alter_column(
        "users",
        "tier",
        existing_type=sa.String(length=32),
        server_default="internal_beta",
    )

    # Drop Stripe columns
    op.drop_column("users", "founder_member")
    op.drop_column("users", "stripe_current_period_end")
    op.drop_column("users", "stripe_price_id")
    op.drop_column("users", "stripe_subscription_status")
    op.drop_constraint("uq_users_stripe_subscription_id", "users", type_="unique")
    op.drop_column("users", "stripe_subscription_id")
    op.drop_constraint("uq_users_stripe_customer_id", "users", type_="unique")
    op.drop_column("users", "stripe_customer_id")
    op.drop_column("users", "trial_ends_at")

    # Restore LMFWC columns
    op.add_column(
        "users",
        sa.Column("license_validated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("license_activations_max", sa.Integer(), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("license_activations_used", sa.Integer(), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("license_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("license_status", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("license_key", sa.String(length=128), nullable=True),
    )
    op.create_unique_constraint("uq_users_license_key", "users", ["license_key"])
