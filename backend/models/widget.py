"""Embeddable sticker-builder widget models.

Four per-merchant entities that power the customer-facing widget:

- `WidgetSettings`  — one row per merchant: allowed embed origins, the shared
  webhook secret, and an optional default cutter preset.
- `PricingProfile`  — reusable pricing rules (sheet width, price per metre, gap,
  margin, per-vinyl/finish surcharges, quantity breaks). The price estimate
  reuses the gang-sheet math from the public calculator.
- `Product`         — the thing a WooCommerce/Shopify product links to. Holds the
  enabled cut styles, size limits, vinyl/finish options and bleed/safe defaults.
- `WidgetSession`   — an ephemeral design session minted from an API key + a
  product. The iframe authenticates with the session token, never the API key.

All money/rate fields are stored in the profile's `currency`. Bleed/safe are
applied automatically and never surfaced to the end customer as jargon.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class WidgetSettings(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "widget_settings"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    """One settings row per merchant."""

    allowed_origins: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)
    """List of origins permitted to embed the widget / call the widget API,
    e.g. ['https://shop.example.com']. Used for CORS + CSP frame-ancestors."""

    webhook_secret: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    """Shared secret used to HMAC-verify inbound order-paid webhooks from the
    merchant's plugin. Generated on first setup; rotatable from the admin."""

    default_cutter_preset_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cutter_presets.id", ondelete="SET NULL"),
        nullable=True,
    )

    def __repr__(self) -> str:
        return f"<WidgetSettings user={self.user_id}>"


class PricingProfile(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "pricing_profiles"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False, default="Default pricing")

    currency: Mapped[str] = mapped_column(
        String(3), nullable=False, default="GBP", server_default="GBP"
    )

    sheet_width_mm: Mapped[float] = mapped_column(
        Float, nullable=False, default=300.0, server_default="300.0"
    )
    """Usable print width of the merchant's media/roll."""

    price_per_metre: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0, server_default="0.0"
    )
    """Cost of one linear metre of media (in `currency`). Drives the sheet
    estimate: cost = price_per_metre * (sheet length used / 1000)."""

    gap_mm: Mapped[float] = mapped_column(
        Float, nullable=False, default=3.0, server_default="3.0"
    )
    """Spacing assumed between stickers when estimating how many fit."""

    margin_pct: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0, server_default="0.0"
    )
    """Markup applied on top of media cost (e.g. 200 = +200%)."""

    handling_fee: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0, server_default="0.0"
    )
    """Flat per-order fee added after margin (in `currency`)."""

    min_order_price: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0, server_default="0.0"
    )
    """Price floor — the estimate is never returned below this."""

    min_length_m: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0, server_default="0.0"
    )
    """Minimum billable length in metres. 0 = pro-rata, 1 = DTF sheets."""

    vinyl_surcharges: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    """Per-vinyl surcharge map, e.g. {'holographic': 0.15} where the value is a
    fraction added to the media cost (0.15 = +15%)."""

    finish_surcharges: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    """Per-finish surcharge map, same shape as vinyl_surcharges."""

    quantity_breaks: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)
    """Volume discounts, e.g. [{'min_qty': 50, 'discount_pct': 10},
    {'min_qty': 100, 'discount_pct': 20}] — highest matching break applies."""

    def __repr__(self) -> str:
        return f"<PricingProfile {self.name} user={self.user_id}>"


class Product(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "products"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False, default="Custom stickers")

    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )

    designer: Mapped[str] = mapped_column(
        String(16), nullable=False, default="cutout", server_default="cutout"
    )
    """Which design experience the customer gets:

    - ``cutout`` — single piece of artwork with background removal + a contour/
      face cut line (die-cut, face stickers).
    - ``canvas`` — a full multi-layer designer (text, shapes, multiple images,
      layers) on a geometric artboard (circle/oval/square/rectangle); the shape
      itself is the cut line, so no contour detection is needed.
    """

    enabled_cut_styles: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)
    """Which cut styles the customer may choose for this product, a subset of
    ['die_cut', 'face', 'square', 'circle']. Null/empty = all.

    For ``canvas`` products these double as the allowed artboard shapes
    (square/rectangle → rectangular artboard, circle → ellipse artboard)."""

    min_size_mm: Mapped[float] = mapped_column(
        Float, nullable=False, default=20.0, server_default="20.0"
    )
    max_size_mm: Mapped[float] = mapped_column(
        Float, nullable=False, default=300.0, server_default="300.0"
    )
    """Allowed sticker dimension range (applies to width and height)."""

    size_presets: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)
    """Fixed sizes the customer can pick, e.g.
    [{'width_mm': 10, 'height_mm': 10}, {'width_mm': 40, 'height_mm': 60}].
    Each preset is a width × height in mm (equal values = a square/circle
    preset). Null/empty = no presets. Used by the shaped (canvas) designer."""

    allow_custom_size: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    """When True the customer can also type a custom size (within min/max). When
    False and presets exist, they must pick one of the presets."""

    corner_radius: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.2, server_default="0.2"
    )
    """Default rounded-corner radius for square/rectangle artboards, as a
    fraction (0..1) of half the shorter side. 0 = sharp corners, 1 = fully
    rounded. The customer can adjust it in the designer."""

    vinyl_types: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)
    """Selectable vinyl options, e.g.
    [{'key': 'matte', 'label': 'Matte'}, {'key': 'gloss', 'label': 'Gloss'}]."""

    finishes: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)
    """Selectable finish options, same shape as vinyl_types. Null = none."""

    bleed_mm: Mapped[float] = mapped_column(
        Float, nullable=False, default=3.0, server_default="3.0"
    )
    """Applied automatically; hidden from the customer."""

    safe_mm: Mapped[float] = mapped_column(
        Float, nullable=False, default=4.0, server_default="4.0"
    )
    """Inner safe area shown only as a friendly dashed guide."""

    show_filters: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    """Whether to show photo filter options to customers in the widget."""

    show_ai_styles: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    """Whether to show AI style options (cartoon, pencil, etc.) in the widget."""

    show_hand_edit: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    """Whether to show the hand-edit cutline tool in the widget."""

    pricing_profile_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("pricing_profiles.id", ondelete="SET NULL"),
        nullable=True,
    )

    def __repr__(self) -> str:
        return f"<Product {self.name} user={self.user_id}>"


class WidgetSession(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "widget_sessions"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    """The merchant the session belongs to (resolved from the API key)."""

    product_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("products.id", ondelete="CASCADE"),
        nullable=False,
    )

    token: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    """Opaque session id embedded in the signed session token the iframe uses.
    Stored so sessions can be looked up, expired and revoked."""

    external_ref: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    """Optional cart/line reference passed by the plugin to tie back to the store."""

    asset_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("assets.id", ondelete="SET NULL"),
        nullable=True,
    )
    """The saved sticker design once the customer finishes (single sticker)."""

    params: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    """In-progress design state / chosen options."""

    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="open", server_default="open"
    )
    """'open' | 'completed' | 'expired'."""

    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    def __repr__(self) -> str:
        return f"<WidgetSession {self.token[:8]}… product={self.product_id}>"
