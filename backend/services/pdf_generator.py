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
* ``spacing_mode='even'``: cols/rows = ``floor((avail + gap) / (size + gap))``
  too, but here ``gap`` is the **minimum** spacing - leftover space is then
  distributed evenly between slots so the outermost ones sit flush against
  the safe-zone edges. Set ``gap_x = gap_y = 0`` for the densest packing;
  set them higher to guarantee no two slots ever sit closer than that.
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
        # `gap` is treated as a *minimum* here. The formula below is the same
        # one used in fixed mode; it gives the largest count whose enforced
        # `gap` spacing still fits inside `available`. Leftover space (which
        # is >= 0 by construction) is then distributed evenly *between*
        # slots, so the resulting spacing is always >= gap.
        count = max(1, math.floor((available + gap) / (size + gap)))
        if count == 1:
            offset = (available - size) / 2.0 if center else 0.0
            return 1, [offset]
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
    corner_radius: float = 0.0,
    positions_layer_name: str = "POSITIONS",
) -> GeneratedTemplate:
    page_w = units_to_pt(artboard_w, units)
    page_h = units_to_pt(artboard_h, units)
    sw = units_to_pt(shape_w, units)
    sh = units_to_pt(shape_h, units)
    gx = units_to_pt(gap_x, units)
    gy = units_to_pt(gap_y, units)
    margin = units_to_pt(edge_margin, units)
    corner_radius_pt = max(0.0, units_to_pt(corner_radius, units))
    # Corner radius can never exceed half the smaller side.
    corner_radius_pt = min(corner_radius_pt, min(sw, sh) / 2.0)

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
                elif corner_radius_pt > 0:
                    _draw_rounded_rect(
                        page, rect, corner_radius_pt,
                        color=(0, 0, 0), width=0.5, oc=ocg_xref,
                    )
                else:
                    page.draw_rect(
                        rect,
                        color=(0, 0, 0), fill=None, width=0.5, oc=ocg_xref,
                    )

                shape_dict: dict = {
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
                    "kind": "ellipse" if shape_kind == "circle" else "rect",
                }
                if shape_kind == "rect" and corner_radius_pt > 0:
                    shape_dict["corner_radius_pt"] = round(corner_radius_pt, 3)
                shapes.append(shape_dict)
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


# Cubic Bezier "magic number" approximation of a quarter-circle arc.
_KAPPA = 0.5522847498307933


def _draw_rounded_rect(
    page: "pymupdf.Page",
    rect: "pymupdf.Rect",
    radius_pt: float,
    *,
    color: tuple[float, float, float] = (0, 0, 0),
    width: float = 0.5,
    oc: int = 0,
) -> None:
    """Draw a rectangle with rounded corners at `radius_pt` (in PDF points).

    PyMuPDF's `Shape.draw_rect` only draws sharp corners, so we trace the
    perimeter manually using `draw_line` for the four edges and `draw_curve`
    for each of the four corner arcs (cubic Bezier with the standard kappa
    approximation). The result is a single closed path filled/stroked once
    by the OCG so the parser still sees one drawing per slot.
    """
    r = max(0.0, min(radius_pt, min(rect.width, rect.height) / 2.0))
    if r <= 0:
        page.draw_rect(rect, color=color, fill=None, width=width, oc=oc)
        return

    x0, y0, x1, y1 = rect.x0, rect.y0, rect.x1, rect.y1
    k = _KAPPA * r
    Pt = pymupdf.Point

    shape = page.new_shape()
    # Start at top-left, just past the corner radius, and trace clockwise.
    shape.draw_line(Pt(x0 + r, y0), Pt(x1 - r, y0))
    shape.draw_bezier(Pt(x1 - r, y0), Pt(x1 - r + k, y0), Pt(x1, y0 + r - k), Pt(x1, y0 + r))
    shape.draw_line(Pt(x1, y0 + r), Pt(x1, y1 - r))
    shape.draw_bezier(Pt(x1, y1 - r), Pt(x1, y1 - r + k), Pt(x1 - r + k, y1), Pt(x1 - r, y1))
    shape.draw_line(Pt(x1 - r, y1), Pt(x0 + r, y1))
    shape.draw_bezier(Pt(x0 + r, y1), Pt(x0 + r - k, y1), Pt(x0, y1 - r + k), Pt(x0, y1 - r))
    shape.draw_line(Pt(x0, y1 - r), Pt(x0, y0 + r))
    shape.draw_bezier(Pt(x0, y0 + r), Pt(x0, y0 + r - k), Pt(x0 + r - k, y0), Pt(x0 + r, y0))
    shape.finish(color=color, fill=None, width=width, closePath=True, oc=oc)
    shape.commit()
