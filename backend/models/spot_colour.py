"""User-defined spot colour presets."""
from __future__ import annotations
import uuid
from sqlalchemy import ForeignKey, String, Float
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class SpotColour(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "spot_colours"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    """Spot colour name, e.g. 'CutContour', 'Score', 'Through-cut'"""

    display_color: Mapped[str] = mapped_column(String(20), nullable=False, default="#FF00FF")
    """Hex colour used for preview/canvas display"""

    sort_order: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
