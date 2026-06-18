"""Embeddable widget foundations.

Adds the tables that power the customer-facing sticker-builder widget +
WooCommerce/Shopify order pipeline:

  - merchant_api_keys   (machine-to-machine auth for the plugin)
  - widget_settings     (per-merchant origins + webhook secret)
  - pricing_profiles    (reusable pricing rules)
  - products            (what a store product links to)
  - widget_sessions     (ephemeral design sessions the iframe authenticates with)
  - print_orders        (the 'ready to print' queue)
  - webhook_events      (idempotency ledger for inbound platform webhooks)

Revision ID: 0039
Revises: 0038
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0039"
down_revision = "0038"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "merchant_api_keys",
        sa.Column("id", UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(100), nullable=False, server_default="API key"),
        sa.Column("prefix", sa.String(20), nullable=False),
        sa.Column("key_hash", sa.String(64), nullable=False),
        sa.Column("scopes", JSONB(), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_merchant_api_keys")),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_merchant_api_keys_user_id_users"), ondelete="CASCADE"),
        sa.UniqueConstraint("key_hash", name=op.f("uq_merchant_api_keys_key_hash")),
    )
    op.create_index(op.f("ix_merchant_api_keys_user_id"), "merchant_api_keys", ["user_id"])
    op.create_index(op.f("ix_merchant_api_keys_prefix"), "merchant_api_keys", ["prefix"])

    op.create_table(
        "widget_settings",
        sa.Column("id", UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("allowed_origins", JSONB(), nullable=True),
        sa.Column("webhook_secret", sa.String(64), nullable=True),
        sa.Column("default_cutter_preset_id", UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_widget_settings")),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_widget_settings_user_id_users"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["default_cutter_preset_id"], ["cutter_presets.id"], name=op.f("fk_widget_settings_default_cutter_preset_id_cutter_presets"), ondelete="SET NULL"),
        sa.UniqueConstraint("user_id", name=op.f("uq_widget_settings_user_id")),
    )

    op.create_table(
        "pricing_profiles",
        sa.Column("id", UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(120), nullable=False, server_default="Default pricing"),
        sa.Column("currency", sa.String(3), nullable=False, server_default="GBP"),
        sa.Column("sheet_width_mm", sa.Float(), nullable=False, server_default="300.0"),
        sa.Column("price_per_metre", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("gap_mm", sa.Float(), nullable=False, server_default="3.0"),
        sa.Column("margin_pct", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("handling_fee", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("min_order_price", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("vinyl_surcharges", JSONB(), nullable=True),
        sa.Column("finish_surcharges", JSONB(), nullable=True),
        sa.Column("quantity_breaks", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pricing_profiles")),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_pricing_profiles_user_id_users"), ondelete="CASCADE"),
    )
    op.create_index(op.f("ix_pricing_profiles_user_id"), "pricing_profiles", ["user_id"])

    op.create_table(
        "products",
        sa.Column("id", UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(200), nullable=False, server_default="Custom stickers"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("enabled_cut_styles", JSONB(), nullable=True),
        sa.Column("min_size_mm", sa.Float(), nullable=False, server_default="20.0"),
        sa.Column("max_size_mm", sa.Float(), nullable=False, server_default="300.0"),
        sa.Column("vinyl_types", JSONB(), nullable=True),
        sa.Column("finishes", JSONB(), nullable=True),
        sa.Column("bleed_mm", sa.Float(), nullable=False, server_default="3.0"),
        sa.Column("safe_mm", sa.Float(), nullable=False, server_default="4.0"),
        sa.Column("pricing_profile_id", UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_products")),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_products_user_id_users"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["pricing_profile_id"], ["pricing_profiles.id"], name=op.f("fk_products_pricing_profile_id_pricing_profiles"), ondelete="SET NULL"),
    )
    op.create_index(op.f("ix_products_user_id"), "products", ["user_id"])

    op.create_table(
        "widget_sessions",
        sa.Column("id", UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("product_id", UUID(as_uuid=True), nullable=False),
        sa.Column("token", sa.String(64), nullable=False),
        sa.Column("external_ref", sa.String(120), nullable=True),
        sa.Column("asset_id", UUID(as_uuid=True), nullable=True),
        sa.Column("params", JSONB(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="open"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_widget_sessions")),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_widget_sessions_user_id_users"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], name=op.f("fk_widget_sessions_product_id_products"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"], name=op.f("fk_widget_sessions_asset_id_assets"), ondelete="SET NULL"),
        sa.UniqueConstraint("token", name=op.f("uq_widget_sessions_token")),
    )
    op.create_index(op.f("ix_widget_sessions_user_id"), "widget_sessions", ["user_id"])
    op.create_index(op.f("ix_widget_sessions_token"), "widget_sessions", ["token"])

    op.create_table(
        "print_orders",
        sa.Column("id", UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("platform", sa.String(20), nullable=False),
        sa.Column("external_order_id", sa.String(120), nullable=False),
        sa.Column("customer_ref", sa.String(200), nullable=True),
        sa.Column("line_items", JSONB(), nullable=True),
        sa.Column("quote_token", sa.String(512), nullable=True),
        sa.Column("amount_total", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("currency", sa.String(3), nullable=False, server_default="GBP"),
        sa.Column("status", sa.String(20), nullable=False, server_default="draft"),
        sa.Column("sheet_id", UUID(as_uuid=True), nullable=True),
        sa.Column("output_r2_key", sa.String(512), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_print_orders")),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_print_orders_user_id_users"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["sheet_id"], ["sticker_sheets.id"], name=op.f("fk_print_orders_sheet_id_sticker_sheets"), ondelete="SET NULL"),
        sa.UniqueConstraint("platform", "external_order_id", name="uq_print_orders_platform_external_order_id"),
    )
    op.create_index(op.f("ix_print_orders_user_id"), "print_orders", ["user_id"])
    op.create_index(op.f("ix_print_orders_external_order_id"), "print_orders", ["external_order_id"])
    op.create_index(op.f("ix_print_orders_status"), "print_orders", ["status"])

    op.create_table(
        "webhook_events",
        sa.Column("id", sa.String(160), nullable=False),
        sa.Column("platform", sa.String(20), nullable=False),
        sa.Column("type", sa.String(64), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_webhook_events")),
    )
    op.create_index(op.f("ix_webhook_events_platform"), "webhook_events", ["platform"])


def downgrade() -> None:
    op.drop_table("webhook_events")
    op.drop_table("print_orders")
    op.drop_table("widget_sessions")
    op.drop_table("products")
    op.drop_table("pricing_profiles")
    op.drop_table("widget_settings")
    op.drop_table("merchant_api_keys")
