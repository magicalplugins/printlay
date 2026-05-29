"""Sticker usage tracking model.

Tracks monthly AI background removal usage per user for entitlement enforcement.
"""

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID

from backend.models.base import Base


class StickerUsage(Base):
    __tablename__ = "sticker_usage"

    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    month = Column(String(7), primary_key=True)  # YYYY-MM
    removals_used = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
