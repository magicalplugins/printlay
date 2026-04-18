"""Generate a template PDF from artboard + shape spec.

Produces a single-page PDF whose page size matches the artboard exactly,
with N rectangles or circles auto-fit and centred, all on an Optional Content
Group (layer) named POSITIONS so the compositor can hide them in the final
output without painting white over the page.

Layout rules
------------

* The **artboard size is sacred** - we never resize the page to fit content.
* The **shape size is sacred** - we never scale slots down to fit. If a row
  or column doesn't fit, it's dropped.
* ``edge_margin`` carves an inviolable safe area off all four sides. Slots
  are computed against the inset rectangle ``page - 2*edge_margin``.
* ``spacing_mode='fixed'``: cols/rows = ``floor((avail + gap) / (size + gap))``
  with the resulting grid centred (when ``center=True``) inside the safe area.
* ``spacing_mode='even'``: cols/rows = ``floor(avail / size)`` (zero-gap fit),
  then leftover space is distributed evenly between slots so the outermost
  ones sit flush against the safe-zone edges.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

import pymupdf  # type: ignore[import-untyped]


MM_PER_INCH = 25.4
PT_PER_INCH = 72.0


@dataclass
class GeneratedTemplate:
    pdf_bytes: bytes
    page_width: float
    page_height: float
    shapes: list[dict]
    """List of `{shape_index, page_index, bbox: [x,y,w,h], layer, is_position_slot}`,
    same shape as `pdf_parser` output, with origin top-left in PDF points."""


def units_to_pt(value: float, units: Literal["mm", "pt", "in"]) -> float:
    if units == "pt":
        return value
    if units == "in":
        return value * PT_PER_INCH
    return value * (PT_PER_INCH / MM_PER_INCH)  # mm


def _layout_axis(
    available: float,
    size: float,
    gap: float,
    mode: Literal["fixed", "even"],
    center: bool,
) -> tuple[int, list[float]]:
    """Compute slot count and starting offsets along one axis.

    Returns ``(count, starts)`` where ``starts`` is the position of each
    slot's leading edge relative to the start of the *available* area
    (i.e. **before** adding the edge margin offset).
    """
    if available <= 0 or size <= 0 or size > available:
        return 0, []

    if mode == "even":
        count = max(1, math.floor(available / size))
        if count == 1:
            offset = (available - size) / 2.0 if center else 0.0
            return 1, [offset]
        # Distribute leftover space evenly *between* slots so the first
        # one sits at 0 and the last one at (available - size).
        leftover = available - count * size
        spacing = leftover / (count - 1)
        return count, [i * (size + spacing) for i in range(count)]

    # fixed mode
    count = max(0, math.floor((available + gap) / (size + gap)))
    if count == 0:
        return 0, []
    grid = count * size + max(0, count - 1) * gap
    leading = (available - grid) / 2.0 if center else 0.0
    return count, [leading + i * (size + gap) for i in range(count)]


def generate(
    *,
    artboard_w: float,
    artboard_h: float,
    units: Literal["mm", "pt", "in"],
    shape_kind: Literal["rect", "circle"],
    shape_w: float,
    shape_h: float,
    gap_x: float = 0.0,
    gap_y: float = 0.0,
    center: bool = True,
    edge_margin: float = 0.0,
    spacing_mode: Literal["fixed", "even"] = "fixed",
    positions_layer_name: str = "POSITIONS",
) -> GeneratedTemplate:
    page_w = units_to_pt(artboard_w, units)
    page_h = units_to_pt(artboard_h, units)
    sw = units_to_pt(shape_w, units)
    sh = units_to_pt(shape_h, units)
    gx = units_to_pt(gap_x, units)
    gy = units_to_pt(gap_y, units)
    margin = units_to_pt(edge_margin, units)

    if sw <= 0 or sh <= 0:
        raise ValueError("Shape width/height must be positive.")
    if margin < 0:
        raise ValueError("Edge margin cannot be negative.")
    if 2 * margin >= page_w or 2 * margin >= page_h:
        raise ValueError(
            f"Edge margin ({edge_margin} {units}) leaves no room on the artboard."
        )

    avail_w = page_w - 2 * margin
    avail_h = page_h - 2 * margin

    if sw > avail_w or sh > avail_h:
        raise ValueError("Shape larger than the available area inside the edge margin.")

    cols, x_starts = _layout_axis(avail_w, sw, gx, spacing_mode, center)
    rows, y_starts = _layout_axis(avail_h, sh, gy, spacing_mode, center)

    if cols == 0 or rows == 0:
        raise ValueError("Shape doesn't fit inside the available area.")

    doc = pymupdf.open()
    try:
        page = doc.new_page(width=page_w, height=page_h)

        ocg_xref = doc.add_ocg(positions_layer_name, on=True)

        shapes: list[dict] = []
        idx = 0
        for r in range(rows):
            for c in range(cols):
                x_top = margin + x_starts[c]
                y_top = margin + y_starts[r]
                rect = pymupdf.Rect(x_top, y_top, x_top + sw, y_top + sh)

                if shape_kind == "circle":
                    cx = (rect.x0 + rect.x1) / 2.0
                    cy = (rect.y0 + rect.y1) / 2.0
                    radius = min(sw, sh) / 2.0
                    page.draw_circle(
                        (cx, cy), radius,
                        color=(0, 0, 0), fill=None, width=0.5, oc=ocg_xref,
                    )
                else:
                    page.draw_rect(
                        rect,
                        color=(0, 0, 0), fill=None, width=0.5, oc=ocg_xref,
                    )

                shapes.append(
                    {
                        "page_index": 0,
                        "shape_index": idx,
                        "bbox": [
                            round(x_top, 3),
                            round(y_top, 3),
                            round(sw, 3),
                            round(sh, 3),
                        ],
                        "layer": positions_layer_name,
                        "is_position_slot": True,
                    }
                )
                idx += 1

        pdf_bytes = doc.tobytes(deflate=True)
    finally:
        doc.close()

    return GeneratedTemplate(
        pdf_bytes=pdf_bytes,
        page_width=page_w,
        page_height=page_h,
        shapes=shapes,
    )
