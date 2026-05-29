"""Draw cutter registration marks onto a generated job PDF.

Mirrors the mark shapes used by the Sheet Builder (`sheet_compositor`)
so a job output and a sheet output read identically on the same cutter:

* velloblade  – solid 6 mm circles at the 4 page corners + top centre
* summa_opos  – crosshair targets down both edges
* generic     – ISO-style corner crosshairs with a ring

Marks are drawn on every page of the output at a fixed inset from the
page edges, in black (what optical mark readers expect). Optional
vertical zoning repeats the marks every `max_zone_length_mm` so long
pages stay registered.
"""
from __future__ import annotations

import io
import math

import pymupdf  # type: ignore[import-untyped]

PT_PER_MM = 72.0 / 25.4

_VALID_TYPES = {"velloblade", "summa_opos", "generic"}


def add_registration_marks(
    pdf_bytes: bytes,
    registration_type: str | None,
    *,
    mark_offset_mm: float = 5.0,
    max_zone_length_mm: float | None = None,
    mark_rgb: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bytes:
    """Return new PDF bytes with registration marks drawn on every page.

    No-op (returns the input unchanged) when `registration_type` is empty
    or unrecognised."""
    if registration_type not in _VALID_TYPES:
        return pdf_bytes

    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        for page in doc:
            w_pt = page.rect.width
            h_pt = page.rect.height
            if registration_type == "velloblade":
                _velloblade(page, w_pt, h_pt, mark_offset_mm, max_zone_length_mm, mark_rgb)
            elif registration_type == "summa_opos":
                _summa(page, w_pt, h_pt, mark_offset_mm, max_zone_length_mm, mark_rgb)
            else:
                _generic(page, w_pt, h_pt, mark_offset_mm, mark_rgb)
        out = io.BytesIO()
        doc.save(out)
        return out.getvalue()
    finally:
        doc.close()


def _zones(h_pt: float, max_zone_length_mm: float | None) -> int:
    if max_zone_length_mm:
        return max(1, math.ceil(h_pt / (max_zone_length_mm * PT_PER_MM)))
    return 1


def _velloblade(page, w_pt, h_pt, offset_mm, max_zone_mm, rgb) -> None:
    offset = offset_mm * PT_PER_MM
    circle_r = (6.0 / 2.0) * PT_PER_MM
    num_zones = _zones(h_pt, max_zone_mm)
    zone_h = h_pt / num_zones
    for z in range(num_zones):
        top = z * zone_h
        bottom = min((z + 1) * zone_h, h_pt)
        centres = [
            (offset, top + offset),
            (w_pt - offset, top + offset),
            (offset, bottom - offset),
            (w_pt - offset, bottom - offset),
            (w_pt / 2.0, top + offset),
        ]
        for cx, cy in centres:
            page.draw_circle(
                pymupdf.Point(cx, cy), circle_r,
                color=rgb, fill=rgb, width=0.25,
            )


def _summa(page, w_pt, h_pt, offset_mm, max_zone_mm, rgb) -> None:
    offset = offset_mm * PT_PER_MM
    arm = 1.5 * PT_PER_MM
    num_zones = _zones(h_pt, max_zone_mm)
    # One row of marks at each zone boundary (top, between zones, bottom).
    ys: list[float] = []
    for i in range(num_zones + 1):
        if i == 0:
            ys.append(offset)
        elif i == num_zones:
            ys.append(h_pt - offset)
        else:
            ys.append(i * (h_pt / num_zones))
    for y in ys:
        for x in (offset, w_pt - offset):
            page.draw_line(pymupdf.Point(x - arm, y), pymupdf.Point(x + arm, y), color=rgb, width=0.3)
            page.draw_line(pymupdf.Point(x, y - arm), pymupdf.Point(x, y + arm), color=rgb, width=0.3)


def _generic(page, w_pt, h_pt, offset_mm, rgb) -> None:
    offset = offset_mm * PT_PER_MM
    arm = 2.0 * PT_PER_MM
    corners = [
        (offset, offset),
        (w_pt - offset, offset),
        (offset, h_pt - offset),
        (w_pt - offset, h_pt - offset),
    ]
    for cx, cy in corners:
        page.draw_line(pymupdf.Point(cx - arm, cy), pymupdf.Point(cx + arm, cy), color=rgb, width=0.3)
        page.draw_line(pymupdf.Point(cx, cy - arm), pymupdf.Point(cx, cy + arm), color=rgb, width=0.3)
        page.draw_circle(pymupdf.Point(cx, cy), arm * 0.6, color=rgb, width=0.2)
