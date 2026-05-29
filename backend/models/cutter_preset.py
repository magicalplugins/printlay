"""Cutter preset model.

Stores saved printer/cutter configurations so operators don't reconfigure
media width, registration type, and zone distances every time they open
the Sheet Builder.
"""
from __future__ import annotations

import uuid
from typing import Optional

from sqlalchemy import Boolean, Float, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class CutterPreset(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "cutter_presets"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    """Human-readable name, e.g. 'Roland VG2-640', 'Summa S160'."""

    media_width_mm: Mapped[float] = mapped_column(Float, nullable=False)
    """Roll/sheet width in mm (e.g. 700, 1370)."""

    registration_type: Mapped[Optional[str]] = mapped_column(
        String(20), nullable=True
    )
    """'velloblade' | 'summa_opos' | 'generic' | null (no marks)."""

    max_zone_length_mm: Mapped[Optional[float]] = mapped_column(
        Float, nullable=True
    )
    """Max distance between registration mark pairs. null = no zoning."""

    mark_offset_mm: Mapped[float] = mapped_column(
        Float, nullable=False, default=5.0, server_default="5.0"
    )
    """Distance from cut area to registration marks."""

    default_gap_mm: Mapped[float] = mapped_column(
        Float, nullable=False, default=3.0, server_default="3.0"
    )
    default_edge_margin_mm: Mapped[float] = mapped_column(
        Float, nullable=False, default=5.0, server_default="5.0"
    )
    show_crop_marks: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
