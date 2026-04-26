import uuid

from sqlalchemy import ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Job(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """A programmed slot order over a Template, plus per-slot asset assignments.

    `slot_order`: list of `shape_index` integers in the order slots should be
    filled. Length <= number of shapes on the template.

    `assignments`: map `shape_index (str) -> { asset_id, asset_kind }`. Stored
    as a dict so partial fills work; lookup is O(1) at composite time.
    """

    __tablename__ = "jobs"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    template_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("templates.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    slot_order: Mapped[list[int]] = mapped_column(JSONB, nullable=False, default=list)
    assignments: Mapped[dict[str, dict]] = mapped_column(JSONB, nullable=False, default=dict)

    # Optional live link to a ColorProfile. Resolved fresh at generate
    # time so editing the profile flows through to every linked job.
    color_profile_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("color_profiles.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # Per-job draft swaps (same shape as ColorProfile.swaps). Used while
    # the user is iterating on a job before promoting to a saved profile.
    color_swaps_draft: Mapped[list[dict] | None] = mapped_column(
        JSONB, nullable=True
    )
