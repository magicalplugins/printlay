import uuid

from sqlalchemy import Boolean, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class User(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """Application-level user record.

    Mirrors a Supabase `auth.users` row by storing its UUID in `auth_id`. We
    don't put a cross-schema FK constraint on it because Supabase manages the
    `auth` schema and we want to remain portable; integrity is enforced via the
    unique index plus the trigger / first-login upsert flow.
    """

    __tablename__ = "users"

    auth_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        unique=True,
        nullable=False,
        index=True,
    )
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)
    tier: Mapped[str] = mapped_column(String(32), nullable=False, default="basic")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    def __repr__(self) -> str:
        return f"<User {self.email} tier={self.tier}>"
