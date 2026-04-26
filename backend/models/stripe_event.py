"""Idempotency ledger for Stripe webhooks.

Stripe retries failed deliveries (and occasionally double-delivers
successful ones), so every event ID is recorded here on first processing.
The webhook handler does an `INSERT ... ON CONFLICT DO NOTHING` to claim
the ID atomically — if the insert is a no-op, the event has already been
processed and we return 200 without re-running side effects.

We never need to query this table for application logic; it's purely a
de-dup store. A periodic admin task can prune events older than ~90 days
(Stripe will not retry beyond that window) but it's not required.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base


class StripeEvent(Base):
    __tablename__ = "stripe_events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    """Stripe event ID, e.g. `evt_1Abc123XyZ`."""
    type: Mapped[str] = mapped_column(String(96), nullable=False, index=True)
    """Event type, e.g. `customer.subscription.updated`. Recorded for
    debugging only — handlers branch on this in code, not via SQL."""
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    def __repr__(self) -> str:
        return f"<StripeEvent {self.id} type={self.type}>"
