import uuid

from sqlalchemy import Boolean, Float, ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Template(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "templates"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    """`uploaded` | `generated`"""

    units: Mapped[str] = mapped_column(String(8), nullable=False, default="mm")

    r2_key: Mapped[str] = mapped_column(String(512), nullable=False)
    page_width: Mapped[float] = mapped_column(Float, nullable=False)
    page_height: Mapped[float] = mapped_column(Float, nullable=False)

    positions_layer: Mapped[str] = mapped_column(
        String(64), nullable=False, default="POSITIONS"
    )
    has_ocg: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    shapes: Mapped[list[dict]] = mapped_column(JSONB, nullable=False)
    """List of `{shape_index, page_index, bbox: [x,y,w,h], layer, is_position_slot}`."""

    generation_params: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    def __repr__(self) -> str:
        return f"<Template {self.name} ({self.source}) shapes={len(self.shapes or [])}>"
