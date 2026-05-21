"""Generic encrypted key/value store for runtime-tunable settings —
specifically the kind of stuff an admin needs to rotate without a code
deploy: API keys, sender addresses, webhook secrets.

Values are encrypted at rest with Fernet (AES-128-CBC + HMAC-SHA-256)
using a master key held in the `APP_SECRETS_MASTER_KEY` Fly secret.
Even with a leaked DB dump, plaintext credentials stay protected as
long as the master key doesn't leak too.

Lookup precedence is enforced by callers (e.g. `services.messaging`):
    1. DB row (admin-configured via the UI)
    2. env var (Fly secret / bootstrap)
    3. fallback / "not configured"

This keeps the original env-var workflow working for fresh installs
while allowing live rotation once the admin has any access at all.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
import uuid

from backend.models.base import Base, TimestampMixin


class AppSetting(Base, TimestampMixin):
    __tablename__ = "app_settings"

    # The key IS the primary key — flat namespace of dotted strings.
    # Conventions: "<provider>.<field>", e.g. "smtp2go.api_key".
    key: Mapped[str] = mapped_column(String(64), primary_key=True)

    encrypted_value: Mapped[str] = mapped_column(Text, nullable=False)
    """Fernet token (urlsafe base64 string). Decrypt with the
    APP_SECRETS_MASTER_KEY; plaintext is never persisted."""

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    updated_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    """Audit trail — which admin wrote this value, so a future leak
    investigation can answer 'who set the SMTP key last Thursday?'."""

    def __repr__(self) -> str:
        return f"<AppSetting {self.key}>"
