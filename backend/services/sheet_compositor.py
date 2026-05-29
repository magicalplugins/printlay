"""Sheet compositor — auto-layout + PDF export for the Sheet Builder.

Packs stickers onto a media surface (roll or sheet), composes print-ready
PDF with CutContour paths, crop marks, and registration marks.
"""
from __future__ import annotations

import io
import math
from dataclasses import dataclass, field
from typing import Literal

import pymupdf  # type: ignore[import-untyped]

PT_PER_MM = 72.0 / 25.4


@dataclass
class Placement:
    asset_id: str
    x_mm: float
    y_mm: float
    rotation_deg: int = 0
    scale: float = 1.0


@dataclass
class LayoutResult:
    placements: list[Placement]
    total_height_mm: float
    cols: int
    rows: int
    zones: int = 1


@dataclass
class SheetConfig:
    media_width_mm: float
    media_height_mm: float = 0.0
    mode: Literal["roll", "sheet"] = "roll"
    gap_mm: float = 3.0
    edge_margin_mm: float = 5.0
    show_crop_marks: bool = True
    registration_type: str | None = None
    max_zone_length_mm: float | None = None
    mark_offset_mm: float = 5.0


def auto_layout(
    sticker_width_mm: float,
    sticker_height_mm: float,
    quantity: int,
    config: SheetConfig,
    asset_id: str = "",
    orientation: Literal["auto", "horizontal", "vertical"] = "auto",
) -> LayoutResult:
    """Pack `quantity` stickers onto the media, returning placement coords.

    For roll mode, height grows to fit. For sheet mode, height is fixed
    and placements are clipped to available space.

    If registration marks are configured with a max_zone_length_mm, stickers
    are grouped into zones with mark gaps between them.
    """
    margin = config.edge_margin_mm
    gap = config.gap_mm
    available_w = config.media_width_mm - 2 * margin

    sw, sh = sticker_width_mm, sticker_height_mm
    if orientation == "auto":
        cols_h = max(1, int((available_w + gap) / (sw + gap)))
        cols_v = max(1, int((available_w + gap) / (sh + gap)))
        if cols_v > cols_h:
            sw, sh = sh, sw
    elif orientation == "horizontal":
        if sw > sh:
            sw, sh = sh, sw
    elif orientation == "vertical":
        if sh > sw:
            sw, sh = sh, sw

    cols = max(1, int((available_w + gap) / (sw + gap)))

    mark_gap = 0.0
    if config.registration_type and config.max_zone_length_mm:
        mark_gap = config.mark_offset_mm * 2 + 5.0

    if config.mode == "roll":
        total_rows = math.ceil(quantity / cols)

        if config.max_zone_length_mm and config.registration_type:
            usable_zone_h = config.max_zone_length_mm - mark_gap
            rows_per_zone = max(1, int((usable_zone_h + gap) / (sh + gap)))
            zones = math.ceil(total_rows / rows_per_zone)
        else:
            rows_per_zone = total_rows
            zones = 1

        placements: list[Placement] = []
        sticker_idx = 0
        y_cursor = margin

        for zone in range(zones):
            if config.registration_type and config.max_zone_length_mm:
                y_cursor += mark_gap / 2

            rows_this_zone = min(rows_per_zone, total_rows - zone * rows_per_zone)
            for row in range(rows_this_zone):
                for col in range(cols):
                    if sticker_idx >= quantity:
                        break
                    x = margin + col * (sw + gap)
                    y = y_cursor + row * (sh + gap)
                    placements.append(Placement(
                        asset_id=asset_id,
                        x_mm=x,
                        y_mm=y,
                        rotation_deg=90 if (sw != sticker_width_mm) else 0,
                    ))
                    sticker_idx += 1
                if sticker_idx >= quantity:
                    break

            y_cursor += rows_this_zone * (sh + gap) - gap
            if config.registration_type and config.max_zone_length_mm:
                y_cursor += mark_gap / 2

            y_cursor += gap

        total_height = y_cursor - gap + margin
        return LayoutResult(
            placements=placements,
            total_height_mm=total_height,
            cols=cols,
            rows=total_rows,
            zones=zones,
        )

    else:
        available_h = config.media_height_mm - 2 * margin
        rows = max(1, int((available_h + gap) / (sh + gap)))
        max_qty = cols * rows

        placements = []
        for i in range(min(quantity, max_qty)):
            col = i % cols
            row = i // cols
            x = margin + col * (sw + gap)
            y = margin + row * (sh + gap)
            placements.append(Placement(
                asset_id=asset_id,
                x_mm=x,
                y_mm=y,
                rotation_deg=90 if (sw != sticker_width_mm) else 0,
            ))

        total_height = config.media_height_mm
        return LayoutResult(
            placements=placements,
            total_height_mm=total_height,
            cols=cols,
            rows=rows,
            zones=1,
        )


def compose_pdf(
    config: SheetConfig,
    placements: list[Placement],
    asset_pdfs: dict[str, bytes],
    total_height_mm: float,
) -> bytes:
    """Compose a print-ready PDF with stickers placed at given positions.

    Each sticker asset PDF is placed using show_pdf_page, which preserves
    embedded CutContour spot colour paths automatically.
    """
    page_w_pt = config.media_width_mm * PT_PER_MM
    page_h_pt = total_height_mm * PT_PER_MM

    doc = pymupdf.open()
    try:
        page = doc.new_page(width=page_w_pt, height=page_h_pt)

        asset_docs: dict[str, pymupdf.Document] = {}
        for aid, pdf_bytes in asset_pdfs.items():
            asset_docs[aid] = pymupdf.open(stream=pdf_bytes, filetype="pdf")

        for p in placements:
            src_doc = asset_docs.get(p.asset_id)
            if not src_doc or src_doc.page_count == 0:
                continue

            src_page = src_doc[0]
            src_w = src_page.rect.width
            src_h = src_page.rect.height

            scaled_w = src_w * p.scale
            scaled_h = src_h * p.scale

            x_pt = p.x_mm * PT_PER_MM
            y_pt = p.y_mm * PT_PER_MM

            if p.rotation_deg == 90 or p.rotation_deg == 270:
                rect = pymupdf.Rect(
                    x_pt, y_pt,
                    x_pt + scaled_h, y_pt + scaled_w,
                )
            else:
                rect = pymupdf.Rect(
                    x_pt, y_pt,
                    x_pt + scaled_w, y_pt + scaled_h,
                )

            page.show_pdf_page(
                rect,
                src_doc,
                pno=0,
                rotate=p.rotation_deg,
            )

        for d in asset_docs.values():
            d.close()

        if config.show_crop_marks:
            _draw_crop_marks(page, config, total_height_mm)

        if config.registration_type:
            _draw_registration_marks(page, config, placements, total_height_mm)

        return doc.tobytes(deflate=True)
    finally:
        doc.close()


def _draw_crop_marks(
    page: pymupdf.Page,
    config: SheetConfig,
    total_height_mm: float,
) -> None:
    """Draw crop marks at sheet edges."""
    w_pt = config.media_width_mm * PT_PER_MM
    h_pt = total_height_mm * PT_PER_MM
    margin_pt = config.edge_margin_mm * PT_PER_MM
    mark_len = 3.0 * PT_PER_MM
    offset = 2.0 * PT_PER_MM

    color = (0, 0, 0)
    width = 0.25

    corners = [
        (margin_pt, margin_pt),
        (w_pt - margin_pt, margin_pt),
        (margin_pt, h_pt - margin_pt),
        (w_pt - margin_pt, h_pt - margin_pt),
    ]

    for cx, cy in corners:
        page.draw_line(
            pymupdf.Point(cx - mark_len - offset, cy),
            pymupdf.Point(cx - offset, cy),
            color=color, width=width,
        )
        page.draw_line(
            pymupdf.Point(cx + offset, cy),
            pymupdf.Point(cx + mark_len + offset, cy),
            color=color, width=width,
        )
        page.draw_line(
            pymupdf.Point(cx, cy - mark_len - offset),
            pymupdf.Point(cx, cy - offset),
            color=color, width=width,
        )
        page.draw_line(
            pymupdf.Point(cx, cy + offset),
            pymupdf.Point(cx, cy + mark_len + offset),
            color=color, width=width,
        )


def _draw_registration_marks(
    page: pymupdf.Page,
    config: SheetConfig,
    placements: list[Placement],
    total_height_mm: float,
) -> None:
    """Draw registration marks for the configured cutter type."""
    if config.registration_type == "velloblade":
        _draw_velloblade_marks(page, config, total_height_mm)
    elif config.registration_type == "summa_opos":
        _draw_summa_marks(page, config, total_height_mm)
    elif config.registration_type == "generic":
        _draw_generic_marks(page, config, total_height_mm)


def _draw_velloblade_marks(
    page: pymupdf.Page,
    config: SheetConfig,
    total_height_mm: float,
) -> None:
    """Velloblade: filled circle + L-bracket at zone corners."""
    w_pt = config.media_width_mm * PT_PER_MM
    h_pt = total_height_mm * PT_PER_MM
    offset = config.mark_offset_mm * PT_PER_MM
    circle_r = 0.75 * PT_PER_MM
    bracket_len = 3.0 * PT_PER_MM

    if config.max_zone_length_mm:
        zone_h_pt = config.max_zone_length_mm * PT_PER_MM
        num_zones = max(1, math.ceil(h_pt / zone_h_pt))
    else:
        zone_h_pt = h_pt
        num_zones = 1

    for z in range(num_zones):
        zone_top = z * zone_h_pt
        zone_bottom = min((z + 1) * zone_h_pt, h_pt)

        corners = [
            (offset, zone_top + offset),
            (w_pt - offset, zone_top + offset),
            (offset, zone_bottom - offset),
            (w_pt - offset, zone_bottom - offset),
        ]

        for cx, cy in corners:
            page.draw_circle(
                pymupdf.Point(cx, cy),
                circle_r,
                color=(0, 0, 0),
                fill=(0, 0, 0),
                width=0.25,
            )
            is_left = cx < w_pt / 2
            is_top = cy < (zone_top + zone_bottom) / 2
            bx = bracket_len if is_left else -bracket_len
            by = bracket_len if is_top else -bracket_len
            page.draw_line(
                pymupdf.Point(cx + bx, cy),
                pymupdf.Point(cx, cy),
                color=(0, 0, 0), width=0.5,
            )
            page.draw_line(
                pymupdf.Point(cx, cy + by),
                pymupdf.Point(cx, cy),
                color=(0, 0, 0), width=0.5,
            )


def _draw_summa_marks(
    page: pymupdf.Page,
    config: SheetConfig,
    total_height_mm: float,
) -> None:
    """Summa OPOS: crosshair targets along both edges at zone boundaries."""
    w_pt = config.media_width_mm * PT_PER_MM
    h_pt = total_height_mm * PT_PER_MM
    offset = config.mark_offset_mm * PT_PER_MM
    arm_len = 1.5 * PT_PER_MM

    if config.max_zone_length_mm:
        zone_h_pt = config.max_zone_length_mm * PT_PER_MM
        num_marks = max(2, math.ceil(h_pt / zone_h_pt) + 1)
    else:
        num_marks = 2

    for i in range(num_marks):
        y = min(i * (config.max_zone_length_mm or total_height_mm) * PT_PER_MM, h_pt)
        if i == 0:
            y = offset
        elif i == num_marks - 1:
            y = h_pt - offset
        else:
            y = i * (config.max_zone_length_mm or total_height_mm) * PT_PER_MM

        for x in (offset, w_pt - offset):
            page.draw_line(
                pymupdf.Point(x - arm_len, y),
                pymupdf.Point(x + arm_len, y),
                color=(0, 0, 0), width=0.3,
            )
            page.draw_line(
                pymupdf.Point(x, y - arm_len),
                pymupdf.Point(x, y + arm_len),
                color=(0, 0, 0), width=0.3,
            )


def _draw_generic_marks(
    page: pymupdf.Page,
    config: SheetConfig,
    total_height_mm: float,
) -> None:
    """Generic ISO-style registration crosshairs at four corners."""
    w_pt = config.media_width_mm * PT_PER_MM
    h_pt = total_height_mm * PT_PER_MM
    offset = config.mark_offset_mm * PT_PER_MM
    arm_len = 2.0 * PT_PER_MM

    corners = [
        (offset, offset),
        (w_pt - offset, offset),
        (offset, h_pt - offset),
        (w_pt - offset, h_pt - offset),
    ]

    for cx, cy in corners:
        page.draw_line(
            pymupdf.Point(cx - arm_len, cy),
            pymupdf.Point(cx + arm_len, cy),
            color=(0, 0, 0), width=0.3,
        )
        page.draw_line(
            pymupdf.Point(cx, cy - arm_len),
            pymupdf.Point(cx, cy + arm_len),
            color=(0, 0, 0), width=0.3,
        )
        page.draw_circle(
            pymupdf.Point(cx, cy),
            arm_len * 0.6,
            color=(0, 0, 0),
            width=0.2,
        )
