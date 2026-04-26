import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class User(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """Application-level user record.

    Mirrors a Supabase `auth.users` row by storing its UUID in `auth_id`. We
    don't put a cross-schema FK constraint on it because Supabase manages the
    `auth` schema and we want to remain portable; integrity is enforced via the
    unique index plus the trigger / first-login upsert flow.

    Billing is Stripe-only. The effective plan is resolved by
    `services.entitlements.for_user` which reads the stripe_* columns and
    trial_ends_at — never call Stripe in the hot path.

    Resolution order:
        1. stripe_subscription_status == 'active'  → tier from stripe_price_id
        2. tier == 'enterprise'                    → admin-set for invoiced deals
        3. trial_ends_at > now()                   → Pro trial
        4. otherwise                               → locked
    """

    __tablename__ = "users"

    auth_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        unique=True,
        nullable=False,
        index=True,
    )
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    tier: Mapped[str] = mapped_column(String(32), nullable=False, default="locked")
    """Direct tier override — only used for 'enterprise' (admin-set for invoiced
    customers). All other tiers are derived from stripe_* columns + trial_ends_at."""
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # ---- Trial ----
    trial_ends_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    """Set to now() + 14 days on signup. Cleared once a Stripe subscription
    becomes active. The entitlements resolver checks this lazily on every
    request so no cron is needed."""

    # ---- Stripe subscription ----
    stripe_customer_id: Mapped[str | None] = mapped_column(
        String(64), nullable=True, unique=True
    )
    stripe_subscription_id: Mapped[str | None] = mapped_column(
        String(64), nullable=True, unique=True
    )
    stripe_subscription_status: Mapped[str | None] = mapped_column(
        String(32), nullable=True
    )
    """Mirrors Stripe's subscription status: active, past_due, canceled, etc."""
    stripe_price_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    """The Stripe price ID the user is currently on. Mapped to a Plan tier in
    entitlements._plan_from_stripe_price."""
    stripe_current_period_end: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    """Next renewal date. Used in the admin subscriptions view to show churn risk."""
    founder_member: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    """True when the user subscribed with the FOUNDERS50 coupon (set by webhook)."""

    # ---- Profile (collected via post-signup completion gate) ----
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    """E.164-style phone (e.g. +447123456789). Required for SMS via Twilio.
    The frontend forces collection on first login via the profile gate."""
    company_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    """Optional - sole traders / hobbyists won't have one."""

    def has_completed_profile(self) -> bool:
        """True when the user has supplied the post-signup profile fields. We
        only require phone (company is optional). Used by /api/auth/me to set
        `needs_profile` so the SPA can route them to the setup screen."""
        return bool(self.phone and self.phone.strip())

    def __repr__(self) -> str:
        return f"<User {self.email} tier={self.tier}>"
