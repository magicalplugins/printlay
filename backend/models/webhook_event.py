"""Generic idempotency ledger for inbound platform webhooks (WooCommerce/Shopify).

Mirrors the Stripe `stripe_events` pattern: the webhook handler does an
`INSERT ... ON CONFLICT DO NOTHING` keyed on a deterministic id (platform +
external id + event type) to claim the event atomically. A no-op insert means
the event was already processed, so we return 200 without re-running side
effects. Purely a de-dup store — never queried for application logic.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base


class WebhookEvent(Base):
    __tablename__ = "webhook_events"

    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    """Deterministic event key, e.g. 'woocommerce:order_paid:1234'."""

    platform: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(64), nullable=False)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    def __repr__(self) -> str:
        return f"<WebhookEvent {self.id}>"
