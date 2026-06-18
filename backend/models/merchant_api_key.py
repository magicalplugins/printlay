"""Merchant API keys — machine-to-machine auth for the embeddable widget.

A merchant (a `users` row) creates one or more API keys in the Printlay admin.
The WooCommerce/Shopify plugin holds a key and uses it server-side to mint
short-lived widget sessions. The end customer never sees the key.

Keys are shown in plaintext exactly once at creation; only a SHA-256 hash is
stored (same approach as Stripe). Lookups hash the presented key and match on
`key_hash` (unique). The `prefix` is a short, non-secret identifier shown in the
admin so a merchant can recognise/rotate keys without revealing the secret.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class MerchantApiKey(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "merchant_api_keys"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False, default="API key")
    """Human label, e.g. 'My WooCommerce store'."""

    prefix: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    """Non-secret leading segment of the key (e.g. 'pl_live_a1b2c3d4'), shown in
    the admin to identify the key. Not unique on its own — the hash is."""

    key_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    """SHA-256 hex digest of the full plaintext key. The plaintext is never stored."""

    scopes: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)
    """List of scope strings, e.g. ['widget:session', 'widget:quote', 'orders:read'].
    Null = full widget scope (back-compat default)."""

    last_used_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    revoked_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    """Set when revoked. A revoked key fails resolution even if the hash matches."""

    def __repr__(self) -> str:
        return f"<MerchantApiKey {self.prefix}… user={self.user_id}>"
