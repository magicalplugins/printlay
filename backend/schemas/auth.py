import re
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    auth_id: uuid.UUID
    email: EmailStr
    tier: str
    is_active: bool
    created_at: datetime
    trial_ends_at: datetime | None = None
    stripe_subscription_status: str | None = None
    stripe_price_id: str | None = None
    founder_member: bool = False
    phone: str | None = None
    company_name: str | None = None
    needs_profile: bool = False
    """True when the user hasn't completed the post-signup profile gate
    (currently: phone is required). The SPA redirects to /profile-setup."""
    is_admin: bool = False
    # ---- Preferences ----
    # See User model for full notes. The frontend reads these on every
    # /me bootstrap so the Dashboard banner + Outputs row line can
    # compute the time-saved estimate without an extra round-trip.
    time_saved_show_enabled: bool = True
    time_saved_setup_minutes: int = 10
    time_saved_per_slot_seconds: int = 40


# International phone format - very lenient. We're not validating carrier
# routing here, just sanity-checking the input shape so SMS won't 400 later.
_PHONE_RE = re.compile(r"^\+?[0-9 ()\-]{6,24}$")


class ProfileUpdate(BaseModel):
    """Fields collected by the post-signup profile-completion gate. Phone
    is required (used for SMS outreach via Twilio); company is optional."""

    phone: str = Field(min_length=6, max_length=32)
    company_name: str | None = Field(default=None, max_length=200)

    @field_validator("phone")
    @classmethod
    def _phone_shape(cls, v: str) -> str:
        v = v.strip()
        if not _PHONE_RE.match(v):
            raise ValueError(
                "Enter a phone number with country code, e.g. +44 7123 456789"
            )
        return v

    @field_validator("company_name")
    @classmethod
    def _company_strip(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v or None


class PreferencesUpdate(BaseModel):
    """Per-user preference toggles. Currently just the "Time saved vs
    manual imposition" surface; designed to grow as more global prefs
    arrive (default bleed, units, theme, etc.).

    All fields are optional so the SPA can `PATCH`-style partial-update
    a single setting without having to round-trip the others. The
    bounds keep the formula honest - we don't want a user accidentally
    setting per-slot to 99999 and then bragging on social media that
    PrintLay "saved them 3 years this week" off one job.
    """

    time_saved_show_enabled: bool | None = None
    time_saved_setup_minutes: int | None = Field(
        default=None,
        ge=0,
        le=600,
        description="Minutes for one-off sheet setup (artboard, bleed, cut marks).",
    )
    time_saved_per_slot_seconds: int | None = Field(
        default=None,
        ge=0,
        le=600,
        description="Seconds per slot for placing/scaling/aligning artwork by hand.",
    )


class PublicConfig(BaseModel):
    """Values the SPA needs to bootstrap. Anon key is intentionally public."""

    supabase_url: str | None
    supabase_anon_key: str | None
    environment: str
