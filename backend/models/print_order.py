"""Print orders — the queue that incoming widget orders land in.

When a customer pays on the merchant's store, the plugin posts an order-paid
webhook. We create/finalize a `PrintOrder`, gang the design onto a sheet, and
flip the status to `ready_to_print` so it surfaces in the merchant's admin
queue. The customer only ever designs a single sticker; quantity here is the
order quantity the merchant prints copies of.

Status workflow: draft -> paid -> ready_to_print -> printed
"""
from __future__ import annotations

import uuid
from typing import Optional

from sqlalchemy import Float, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class PrintOrder(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "print_orders"
    __table_args__ = (
        UniqueConstraint(
            "platform",
            "external_order_id",
            name="uq_print_orders_platform_external_order_id",
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    """The merchant who fulfils the order."""

    platform: Mapped[str] = mapped_column(String(20), nullable=False)
    """'woocommerce' | 'shopify'."""

    external_order_id: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    """The order id in the merchant's store. (platform, external_order_id) is unique."""

    customer_ref: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    """Display reference for the admin queue (name / email / store order number)."""

    line_items: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)
    """[{'asset_id': uuid, 'session_token': str, 'options': {...}, 'qty': int,
        'unit_price': float}, ...]. Single-sticker designs; qty is order count."""

    quote_token: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    """The signed price quote the plugin sent at add-to-cart, re-verified on pay."""

    amount_total: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0, server_default="0.0"
    )
    currency: Mapped[str] = mapped_column(
        String(3), nullable=False, default="GBP", server_default="GBP"
    )

    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="draft", server_default="draft", index=True
    )
    """draft | paid | ready_to_print | printed."""

    sheet_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sticker_sheets.id", ondelete="SET NULL"),
        nullable=True,
    )
    """The gang sheet generated for fulfilment (merchant-side)."""

    output_r2_key: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    """R2 key of the generated print-ready PDF."""

    def __repr__(self) -> str:
        return f"<PrintOrder {self.platform}:{self.external_order_id} status={self.status}>"
