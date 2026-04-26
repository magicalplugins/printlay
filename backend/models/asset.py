import uuid
from typing import Optional

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class AssetCategory(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "asset_categories"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    is_official: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, index=True
    )
    """When True, this category is owned by an admin and exposed to other
    users via opt-in subscriptions (catalogue_subscriptions). The owning
    admin still appears in `user_id` so existing per-user filters work."""


class Asset(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "assets"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    category_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("asset_categories.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    job_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("jobs.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    """`pdf` | `svg` | `png` | `jpg`"""

    r2_key: Mapped[str] = mapped_column(String(512), nullable=False)
    """Always points at a normalised PDF (we convert on upload). Original is kept under `r2_key_original`."""
    r2_key_original: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    thumbnail_r2_key: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)

    width_pt: Mapped[float] = mapped_column(Float, nullable=False)
    height_pt: Mapped[float] = mapped_column(Float, nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_official: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    """Mirrors `category.is_official`. Denormalised here so we can filter
    assets without joining the category row on hot paths."""


class CatalogueSubscription(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """A subscriber's opt-in to an official AssetCategory. Read-only access:
    the assets remain owned by the admin, the subscriber just gets to see
    the category alongside their own. Removing the row hides it again."""

    __tablename__ = "catalogue_subscriptions"
    __table_args__ = (
        UniqueConstraint("user_id", "category_id", name="uq_catalogue_subscriptions_user_id"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    category_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("asset_categories.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
