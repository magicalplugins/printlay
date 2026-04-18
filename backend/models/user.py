import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class User(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """Application-level user record.

    Mirrors a Supabase `auth.users` row by storing its UUID in `auth_id`. We
    don't put a cross-schema FK constraint on it because Supabase manages the
    `auth` schema and we want to remain portable; integrity is enforced via the
    unique index plus the trigger / first-login upsert flow.

    The `tier` column is the *effective* plan we serve through the entitlements
    layer. It's derived from a successfully validated LMFWC license key:
        PL-STR-...    -> "starter"
        PL-PRO-...    -> "professional"
        PL-EXPERT-... -> "expert"
        (no key)      -> "internal_beta"  (default until billing launches)

    The license columns mirror the LMFWC validate response so we can render the
    settings page + run grace-period checks without re-hitting the licence
    server on every request.
    """

    __tablename__ = "users"

    auth_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        unique=True,
        nullable=False,
        index=True,
    )
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    tier: Mapped[str] = mapped_column(String(32), nullable=False, default="internal_beta")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    license_key: Mapped[str | None] = mapped_column(String(128), nullable=True, unique=True)
    license_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    """One of: 'active', 'expired', 'invalid', 'inactive'. None until first activation."""
    license_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    license_activations_used: Mapped[int | None] = mapped_column(Integer, nullable=True)
    license_activations_max: Mapped[int | None] = mapped_column(Integer, nullable=True)
    license_validated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    """Last time we successfully validated against LMFWC. Drives the 72h grace
    window when the licence server is unreachable."""

    def __repr__(self) -> str:
        return f"<User {self.email} tier={self.tier}>"
