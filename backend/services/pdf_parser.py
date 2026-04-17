"""Template PDF parser.

Two responsibilities:

1. Read the page dimensions (in PDF points - 1 pt = 1/72 inch).
2. Extract slot shapes and their bounding boxes.

We prefer slots tagged on a Layer named POSITIONS (Optional Content Group).
If no such layer exists, we fall back to scanning all drawings on the page,
but the route handler treats `has_ocg=False` as a state to surface to the
user (they should re-export the AI with a POSITIONS layer for clean output).

PDF coordinate space: origin bottom-left, y grows up. We convert to a
top-left origin in the returned bbox (x, y, w, h) so the frontend SVG/PDF.js
overlay can use it directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pymupdf  # type: ignore[import-untyped]


@dataclass
class ParsedShape:
    page_index: int
    shape_index: int
    bbox: tuple[float, float, float, float]
    """`(x, y, w, h)` with origin top-left, in PDF points."""
    layer: str | None
    is_position_slot: bool


@dataclass
class ParsedTemplate:
    page_width: float
    page_height: float
    has_positions_ocg: bool
    positions_layer: str | None
    shapes: list[ParsedShape]


POSITION_LAYER_CANDIDATES = ("POSITIONS", "POSITION", "SLOTS", "SLOT")


def parse(pdf_bytes: bytes, *, layer_hint: str | None = None) -> ParsedTemplate:
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        page = doc[0]
        page_w = float(page.rect.width)
        page_h = float(page.rect.height)

        layer_names = _list_layers(doc)
        positions_layer = _find_positions_layer(layer_names, layer_hint)

        drawings: list[dict[str, Any]] = page.get_drawings()
        shapes: list[ParsedShape] = []
        for i, item in enumerate(drawings):
            rect = item.get("rect")
            if rect is None:
                continue
            x0 = float(rect.x0)
            y0_bottom = float(rect.y0)
            x1 = float(rect.x1)
            y1_bottom = float(rect.y1)

            w = abs(x1 - x0)
            h = abs(y1_bottom - y0_bottom)
            if w < 1.0 or h < 1.0:
                continue

            x = min(x0, x1)
            y_top = page_h - max(y0_bottom, y1_bottom)

            layer = _layer_for_drawing(item, layer_names)
            on_position_layer = (
                layer is not None and positions_layer is not None and layer == positions_layer
            )
            shapes.append(
                ParsedShape(
                    page_index=0,
                    shape_index=i,
                    bbox=(round(x, 3), round(y_top, 3), round(w, 3), round(h, 3)),
                    layer=layer,
                    is_position_slot=on_position_layer,
                )
            )

        if positions_layer:
            position_only = [s for s in shapes if s.is_position_slot]
            if position_only:
                shapes = position_only

        return ParsedTemplate(
            page_width=page_w,
            page_height=page_h,
            has_positions_ocg=positions_layer is not None,
            positions_layer=positions_layer,
            shapes=shapes,
        )
    finally:
        doc.close()


def _list_layers(doc) -> list[str]:
    try:
        ui = doc.layer_ui_configs() or []
    except Exception:
        return []
    names: list[str] = []
    for entry in ui:
        name = entry.get("text") or entry.get("name")
        if name:
            names.append(str(name))
    return names


def _find_positions_layer(names: list[str], hint: str | None) -> str | None:
    if hint:
        for name in names:
            if name.lower() == hint.lower():
                return name
    for candidate in POSITION_LAYER_CANDIDATES:
        for name in names:
            if name.lower() == candidate.lower():
                return name
    return None


def _layer_for_drawing(drawing: dict[str, Any], layer_names: list[str]) -> str | None:
    layer = drawing.get("layer")
    if isinstance(layer, str):
        return layer
    layer_idx = drawing.get("oc")
    if isinstance(layer_idx, int) and 0 <= layer_idx < len(layer_names):
        return layer_names[layer_idx]
    return None
