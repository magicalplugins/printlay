"""Sticker sheet model.

Represents a Sheet Builder layout — a collection of sticker placements on a
media surface (roll or sheet) with optional registration marks and crop marks.
"""
from __future__ import annotations

import uuid
from typing import Optional

from sqlalchemy import Boolean, Float, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class StickerSheet(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "sticker_sheets"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False, default="Untitled")

    media_width_mm: Mapped[float] = mapped_column(Float, nullable=False)
    """Printer roll/sheet width in mm."""

    media_height_mm: Mapped[float] = mapped_column(Float, nullable=False)
    """Total length (roll mode) or page height (sheet mode). For roll mode
    this is recalculated from the layout on each auto-layout call."""

    mode: Mapped[str] = mapped_column(
        String(10), nullable=False, default="roll", server_default="roll"
    )
    """'roll' (continuous, height grows) or 'sheet' (fixed page size)."""

    sub_sheet_size: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    """For sheet mode: 'a4' | 'a5' | 'a3' | 'custom' | null."""

    gap_mm: Mapped[float] = mapped_column(
        Float, nullable=False, default=3.0, server_default="3.0"
    )
    """Gap between stickers inside sub-sheets."""

    sub_sheet_gap_mm: Mapped[float] = mapped_column(
        Float, nullable=False, default=5.0, server_default="5.0"
    )
    """Gap between sub-sheets themselves."""

    sub_sheet_padding_mm: Mapped[float] = mapped_column(
        Float, nullable=False, default=5.0, server_default="5.0"
    )
    """Inner padding inside each sub-sheet before stickers start."""

    edge_margin_mm: Mapped[float] = mapped_column(
        Float, nullable=False, default=5.0, server_default="5.0"
    )
    """Margin from the roll edges to the first sub-sheet."""
    show_crop_marks: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )

    registration_type: Mapped[Optional[str]] = mapped_column(
        String(20), nullable=True
    )
    """'velloblade' | 'summa_opos' | 'generic' | null."""

    max_zone_length_mm: Mapped[Optional[float]] = mapped_column(
        Float, nullable=True
    )
    """Max distance between reg mark pairs. null = no zoning."""

    mark_offset_mm: Mapped[float] = mapped_column(
        Float, nullable=False, default=5.0, server_default="5.0"
    )

    placements: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)
    """Array of sticker placement objects:
    [{"asset_id": "uuid", "x_mm": 10.0, "y_mm": 15.0,
      "rotation_deg": 0, "scale": 1.0}, ...]
    """

    cutter_preset_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cutter_presets.id", ondelete="SET NULL"),
        nullable=True,
    )

    output_r2_key: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    """R2 key for the last generated PDF export."""

    sub_sheet_bg_r2_key: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    """R2 key for sub-sheet background image."""

    sub_sheet_bg_url: Mapped[Optional[str]] = mapped_column(String(1024), nullable=True)
    """Presigned URL for the sub-sheet background (cached for frontend)."""

    sub_sheet_fill_color: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    """CSS gradient or solid color for sub-sheet background, e.g.
    '#ff6600' or 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'."""

    sub_sheet_title: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    """Title text displayed at the top of each sub-sheet."""

    sub_sheet_title_font: Mapped[Optional[str]] = mapped_column(
        String(60), nullable=True, default="Inter"
    )
    """Font family for the sub-sheet title."""

    sub_sheet_title_size_mm: Mapped[Optional[float]] = mapped_column(
        Float, nullable=True, default=5.0
    )
    """Title font size in mm."""

    sub_sheet_title_color: Mapped[Optional[str]] = mapped_column(
        String(20), nullable=True, default="#000000"
    )
    """Title text colour (hex)."""

    sub_sheet_title_bold: Mapped[Optional[bool]] = mapped_column(
        Boolean, nullable=True, default=False
    )
    """Whether the title text is bold."""

    sticker_align_h: Mapped[Optional[str]] = mapped_column(
        String(10), nullable=True, default="center"
    )
    """Horizontal alignment of stickers within sub-sheet: 'left' | 'center' | 'right'."""

    sticker_align_v: Mapped[Optional[str]] = mapped_column(
        String(10), nullable=True, default="top"
    )
    """Vertical alignment of stickers within sub-sheet: 'top' | 'center' | 'bottom'."""

    sub_sheet_bleed_mm: Mapped[Optional[float]] = mapped_column(
        Float, nullable=True, default=0.0
    )
    """Bleed in mm — background extends beyond the sub-sheet edges by this amount."""

    sub_sheet_fill_color2: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    """Second colour for gradient (if set, a 2-colour gradient is used)."""

    sub_sheet_gradient_angle: Mapped[Optional[float]] = mapped_column(
        Float, nullable=True, default=135.0
    )
    """Gradient direction in degrees (e.g. 135 = top-left to bottom-right)."""

    spot_color_cutlines: Mapped[Optional[str]] = mapped_column(
        String(40), nullable=True, default="CutContour"
    )
    """Spot colour name or hex for sticker cut lines."""

    spot_color_subsheets: Mapped[Optional[str]] = mapped_column(
        String(40), nullable=True, default="#00FF00"
    )
    """Colour for sub-sheet outlines."""

    spot_color_marks: Mapped[Optional[str]] = mapped_column(
        String(40), nullable=True, default="#000000"
    )
    """Colour for registration marks and crop marks."""
