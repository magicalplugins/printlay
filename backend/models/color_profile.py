import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class ColorProfile(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """A user-owned, named set of exact RGB colour swaps.

    Stored shape of `swaps`:
        [
          {"source": [212, 25, 79], "target": [200, 16, 46], "label": "Card red"},
          ...
        ]

    Edits propagate live: jobs reference the profile by id and resolve
    `swaps` fresh at generate time. To customise per-machine the user
    duplicates the profile and tweaks the copy.
    """

    __tablename__ = "color_profiles"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    swaps: Mapped[list[dict]] = mapped_column(
        JSONB,
        nullable=False,
        default=list,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
