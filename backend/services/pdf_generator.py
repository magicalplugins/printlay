"""Generate a template PDF from artboard + shape spec.

Produces a single-page PDF whose page size matches the artboard exactly,
with N rectangles or circles auto-fit and centred, all on an Optional Content
Group (layer) named POSITIONS so the compositor can hide them in the final
output without painting white over the page.
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


def generate(
    *,
    artboard_w: float,
    artboard_h: float,
    units: Literal["mm", "pt", "in"],
    shape_kind: Literal["rect", "circle"],
    shape_w: float,
    shape_h: float,
    gap_x: float,
    gap_y: float,
    center: bool = True,
    positions_layer_name: str = "POSITIONS",
) -> GeneratedTemplate:
    page_w = units_to_pt(artboard_w, units)
    page_h = units_to_pt(artboard_h, units)
    sw = units_to_pt(shape_w, units)
    sh = units_to_pt(shape_h, units)
    gx = units_to_pt(gap_x, units)
    gy = units_to_pt(gap_y, units)

    if sw <= 0 or sh <= 0:
        raise ValueError("Shape width/height must be positive.")
    if sw > page_w or sh > page_h:
        raise ValueError("Shape larger than artboard.")

    cols = max(1, math.floor((page_w + gx) / (sw + gx)))
    rows = max(1, math.floor((page_h + gy) / (sh + gy)))

    grid_w = cols * sw + max(0, cols - 1) * gx
    grid_h = rows * sh + max(0, rows - 1) * gy

    if center:
        offset_x = (page_w - grid_w) / 2.0
        offset_y_top = (page_h - grid_h) / 2.0
    else:
        offset_x = 0.0
        offset_y_top = 0.0

    doc = pymupdf.open()
    try:
        page = doc.new_page(width=page_w, height=page_h)

        ocg_xref = doc.add_ocg(positions_layer_name, on=True)

        shapes: list[dict] = []
        idx = 0
        for r in range(rows):
            for c in range(cols):
                x_top = offset_x + c * (sw + gx)
                y_top = offset_y_top + r * (sh + gy)
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
