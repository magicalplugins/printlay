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


class PublicConfig(BaseModel):
    """Values the SPA needs to bootstrap. Anon key is intentionally public."""

    supabase_url: str | None
    supabase_anon_key: str | None
    environment: str
