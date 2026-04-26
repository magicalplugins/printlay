"""user profile (phone/company), official catalogues, subscriptions

Revision ID: 0008
Revises: 0007
Create Date: 2026-04-18

Three loosely-related schema changes that ship together because the admin
work needs all of them:

* `users.phone`, `users.company_name`: collected via a one-time profile
  completion gate after sign-up. Phone is required for SMS outreach;
  company is optional. Existing users will be prompted to fill these
  on next login (the `needs_profile` flag in /me drives the redirect).

* `asset_categories.is_official` + `assets.is_official`: marks
  admin-curated catalogues that any subscriber can opt-in to. Owned
  by the admin user that uploaded them (we don't copy bytes per
  subscriber - read-only single source of truth).

* `catalogue_subscriptions`: many-to-many between users and official
  asset_categories. A row means "this user has this official catalogue
  visible in their /catalogue page". Subscribed via self-serve from a
  Browse panel, or pushed by the admin from the admin page.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ---- users: phone + company ----
    op.add_column("users", sa.Column("phone", sa.String(length=32), nullable=True))
    op.add_column("users", sa.Column("company_name", sa.String(length=200), nullable=True))

    # ---- asset_categories: official flag ----
    op.add_column(
        "asset_categories",
        sa.Column(
            "is_official",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.create_index(
        op.f("ix_asset_categories_is_official"),
        "asset_categories",
        ["is_official"],
    )
    op.alter_column("asset_categories", "is_official", server_default=None)

    # ---- assets: official flag (mirrored from category for fast filtering) ----
    op.add_column(
        "assets",
        sa.Column(
            "is_official",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.alter_column("assets", "is_official", server_default=None)

    # ---- catalogue_subscriptions ----
    op.create_table(
        "catalogue_subscriptions",
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
        sa.Column(
            "category_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_catalogue_subscriptions")),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"],
            ondelete="CASCADE",
            name=op.f("fk_catalogue_subscriptions_user_id_users"),
        ),
        sa.ForeignKeyConstraint(
            ["category_id"], ["asset_categories.id"],
            ondelete="CASCADE",
            name=op.f("fk_catalogue_subscriptions_category_id_asset_categories"),
        ),
        sa.UniqueConstraint(
            "user_id", "category_id",
            name=op.f("uq_catalogue_subscriptions_user_id"),
        ),
    )
    op.create_index(
        op.f("ix_catalogue_subscriptions_user_id"),
        "catalogue_subscriptions", ["user_id"],
    )
    op.create_index(
        op.f("ix_catalogue_subscriptions_category_id"),
        "catalogue_subscriptions", ["category_id"],
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_catalogue_subscriptions_category_id"), table_name="catalogue_subscriptions")
    op.drop_index(op.f("ix_catalogue_subscriptions_user_id"), table_name="catalogue_subscriptions")
    op.drop_table("catalogue_subscriptions")
    op.drop_column("assets", "is_official")
    op.drop_index(op.f("ix_asset_categories_is_official"), table_name="asset_categories")
    op.drop_column("asset_categories", "is_official")
    op.drop_column("users", "company_name")
    op.drop_column("users", "phone")
