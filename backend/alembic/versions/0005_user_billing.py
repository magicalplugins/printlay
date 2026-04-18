"""user billing fields (LMFWC license + grace period)

Revision ID: 0005
Revises: 0004
Create Date: 2026-04-17

Adds the columns the entitlements layer needs:
    license_key, license_status, license_expires_at,
    license_activations_used, license_activations_max,
    license_validated_at

Also flips the default `tier` from `'basic'` to `'internal_beta'`. We keep any
existing rows on whatever tier they already have - the change is server_default
only, applied to *new* rows.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("license_key", sa.String(length=128), nullable=True),
    )
    op.create_unique_constraint(
        op.f("uq_users_license_key"), "users", ["license_key"]
    )
    op.add_column("users", sa.Column("license_status", sa.String(length=32), nullable=True))
    op.add_column(
        "users",
        sa.Column("license_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("license_activations_used", sa.Integer(), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("license_activations_max", sa.Integer(), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("license_validated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.alter_column(
        "users",
        "tier",
        existing_type=sa.String(length=32),
        server_default="internal_beta",
    )


def downgrade() -> None:
    op.alter_column(
        "users",
        "tier",
        existing_type=sa.String(length=32),
        server_default="basic",
    )
    op.drop_column("users", "license_validated_at")
    op.drop_column("users", "license_activations_max")
    op.drop_column("users", "license_activations_used")
    op.drop_column("users", "license_expires_at")
    op.drop_column("users", "license_status")
    op.drop_constraint(op.f("uq_users_license_key"), "users", type_="unique")
    op.drop_column("users", "license_key")
