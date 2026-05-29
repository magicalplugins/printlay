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
    sub_sheet_gap_mm: float = 5.0
    sub_sheet_padding_mm: float = 5.0
    show_crop_marks: bool = True
    registration_type: str | None = None
    max_zone_length_mm: float | None = None
    mark_offset_mm: float = 5.0
    sub_sheet_size: str | None = None
    sticker_align_h: str = "center"
    sticker_align_v: str = "top"
    sub_sheet_bleed_mm: float = 0.0
    sub_sheet_title: str | None = None
    sub_sheet_title_size_mm: float = 5.0


SUB_SHEET_SIZES: dict[str, tuple[float, float]] = {
    "a5": (148.0, 210.0),
    "a4": (210.0, 297.0),
    "a3": (297.0, 420.0),
}


def auto_layout(
    sticker_width_mm: float,
    sticker_height_mm: float,
    quantity: int,
    config: SheetConfig,
    asset_id: str = "",
    orientation: Literal["auto", "horizontal", "vertical"] = "auto",
) -> LayoutResult:
    """Pack `quantity` stickers onto the media, returning placement coords.

    If sub_sheet_size is set, stickers are packed into sub-sheet groups
    (A4/A5/A3) which tile across the roll width and down the length.
    Each sub-sheet gets crop marks for guillotining.

    For roll mode without sub-sheets, height grows to fit.
    """
    gap = config.gap_mm
    margin = config.edge_margin_mm

    sw, sh = sticker_width_mm, sticker_height_mm

    # Sub-sheet grouping mode
    if config.sub_sheet_size and config.sub_sheet_size in SUB_SHEET_SIZES:
        sub_w, sub_h = SUB_SHEET_SIZES[config.sub_sheet_size]
        padding = config.sub_sheet_padding_mm
        sub_gap = config.sub_sheet_gap_mm
        edge = config.edge_margin_mm
        sticker_gap = config.gap_mm

        # Orient sticker for best fit within the sub-sheet
        usable_w = sub_w - 2 * padding
        usable_h = sub_h - 2 * padding

        # Reserve space for title at the top (title height + 3mm gap minimum)
        title_offset = 0.0
        if config.sub_sheet_title:
            title_offset = max(config.sub_sheet_title_size_mm + 3.0, 3.0)
            usable_h -= title_offset

        if orientation == "auto":
            cols_h = max(1, int((usable_w + sticker_gap) / (sw + sticker_gap)))
            rows_h = max(1, int((usable_h + sticker_gap) / (sh + sticker_gap)))
            cols_v = max(1, int((usable_w + sticker_gap) / (sh + sticker_gap)))
            rows_v = max(1, int((usable_h + sticker_gap) / (sw + sticker_gap)))
            if cols_v * rows_v > cols_h * rows_h:
                sw, sh = sh, sw
        elif orientation == "horizontal":
            if sw > sh:
                sw, sh = sh, sw
        elif orientation == "vertical":
            if sh > sw:
                sw, sh = sh, sw

        stickers_per_col = max(1, int((usable_w + sticker_gap) / (sw + sticker_gap)))
        stickers_per_row = max(1, int((usable_h + sticker_gap) / (sh + sticker_gap)))
        per_sub = stickers_per_col * stickers_per_row

        sub_sheets_needed = math.ceil(quantity / per_sub)

        available_for_subs = config.media_width_mm - 2 * edge
        sub_cols = max(1, int((available_for_subs + sub_gap) / (sub_w + sub_gap)))
        sub_rows = math.ceil(sub_sheets_needed / sub_cols)

        # Calculate sticker block dimensions for alignment
        block_w = stickers_per_col * sw + (stickers_per_col - 1) * sticker_gap
        block_h = stickers_per_row * sh + (stickers_per_row - 1) * sticker_gap

        placements: list[Placement] = []
        sticker_idx = 0

        for sub_row in range(sub_rows):
            for sub_col in range(sub_cols):
                if sticker_idx >= quantity:
                    break
                sub_x = edge + sub_col * (sub_w + sub_gap)
                sub_y = edge + sub_row * (sub_h + sub_gap)

                # Remaining stickers for this sub-sheet
                remaining = min(per_sub, quantity - sticker_idx)
                actual_rows = math.ceil(remaining / stickers_per_col)
                actual_block_h = actual_rows * sh + (actual_rows - 1) * sticker_gap

                # Horizontal alignment offset
                align_h = config.sticker_align_h
                if align_h == "center":
                    offset_x = padding + (usable_w - block_w) / 2
                elif align_h == "right":
                    offset_x = padding + (usable_w - block_w)
                else:
                    offset_x = padding

                # Vertical alignment offset (shifted down by title_offset)
                align_v = config.sticker_align_v
                if align_v == "center":
                    offset_y = padding + title_offset + (usable_h - actual_block_h) / 2
                elif align_v == "bottom":
                    offset_y = padding + title_offset + (usable_h - actual_block_h)
                else:
                    offset_y = padding + title_offset

                for r in range(stickers_per_row):
                    for c in range(stickers_per_col):
                        if sticker_idx >= quantity:
                            break
                        x = sub_x + offset_x + c * (sw + sticker_gap)
                        y = sub_y + offset_y + r * (sh + sticker_gap)
                        placements.append(Placement(
                            asset_id=asset_id,
                            x_mm=round(x, 2),
                            y_mm=round(y, 2),
                            rotation_deg=90 if (sw != sticker_width_mm) else 0,
                        ))
                        sticker_idx += 1
                    if sticker_idx >= quantity:
                        break
            if sticker_idx >= quantity:
                break

        total_height = edge + sub_rows * (sub_h + sub_gap) - sub_gap + edge
        return LayoutResult(
            placements=placements,
            total_height_mm=total_height,
            cols=stickers_per_col,
            rows=stickers_per_row,
            zones=sub_sheets_needed,
        )

    # Direct layout on roll (no sub-sheets)
    available_w = config.media_width_mm - 2 * margin

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

        placements = []
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
    """Draw crop marks around sub-sheet groups (A4/A5/A3) within the roll.
    
    Crop marks appear at the corners of each sub-sheet rectangle, allowing
    the printed roll to be guillotined into individual smaller sheets.
    If no sub_sheet_size is set, no crop marks are drawn.
    """
    size = SUB_SHEET_SIZES.get(config.sub_sheet_size or "")
    if not size:
        return

    sub_w_mm, sub_h_mm = size
    sub_gap = config.sub_sheet_gap_mm
    edge = config.edge_margin_mm
    sheet_w_mm = config.media_width_mm
    sheet_h_mm = total_height_mm

    available_for_subs = sheet_w_mm - 2 * edge
    cols = max(1, int((available_for_subs + sub_gap) / (sub_w_mm + sub_gap)))
    available_for_rows = sheet_h_mm - 2 * edge
    rows = max(1, int((available_for_rows + sub_gap) / (sub_h_mm + sub_gap)))

    mark_len = 3.0 * PT_PER_MM
    offset = 1.5 * PT_PER_MM
    color = (0, 0, 0)
    width = 0.3

    for row in range(rows):
        for col in range(cols):
            sx_pt = (edge + col * (sub_w_mm + sub_gap)) * PT_PER_MM
            sy_pt = (edge + row * (sub_h_mm + sub_gap)) * PT_PER_MM
            sw_pt = sub_w_mm * PT_PER_MM
            sh_pt = sub_h_mm * PT_PER_MM

            corners = [
                (sx_pt, sy_pt),
                (sx_pt + sw_pt, sy_pt),
                (sx_pt, sy_pt + sh_pt),
                (sx_pt + sw_pt, sy_pt + sh_pt),
            ]

            for cx, cy in corners:
                h_dir = -1 if cx == sx_pt else 1
                page.draw_line(
                    pymupdf.Point(cx + h_dir * offset, cy),
                    pymupdf.Point(cx + h_dir * (offset + mark_len), cy),
                    color=color, width=width,
                )
                v_dir = -1 if cy == sy_pt else 1
                page.draw_line(
                    pymupdf.Point(cx, cy + v_dir * offset),
                    pymupdf.Point(cx, cy + v_dir * (offset + mark_len)),
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
