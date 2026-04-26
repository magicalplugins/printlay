"""Template PDF parser.

Two responsibilities:

1. Read the page dimensions (in PDF points - 1 pt = 1/72 inch).
2. Extract slot shapes and their bounding boxes.

We prefer slots tagged on a Layer named POSITIONS (Optional Content Group).
If no such layer exists, we fall back to scanning all drawings on the page,
but the route handler treats `has_ocg=False` as a state to surface to the
user (they should re-export the AI with a POSITIONS layer for clean output).

Coordinate system note
----------------------
The PDF *file format* uses a bottom-left origin (y grows up), but PyMuPDF
normalises everything in its API to a **top-left origin** (y grows down,
matching screen pixels). `page.rect`, `drawing["rect"]`, and every Point
inside `drawing["items"]` are already in top-left coords. The frontend
SVG/PDF.js overlay also uses top-left coords, so we pass the bbox
through verbatim without any y-flip. (The original parser flipped y,
which silently broke imported PDFs - for symmetric grids the layout
LOOKED right but slot indices were rotated 180°, and for asymmetric
ones the slot bboxes landed on the wrong rectangles.)
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
    kind: str = "rect"
    """Geometric kind of the slot. One of `"rect"`, `"ellipse"` or
    `"polygon"`. Rectangles (sharp or rounded) mix straight line
    segments with optional corner curves; pure ellipses / circles are
    made entirely of cubic Bezier segments; polygons are closed paths
    of 3+ straight segments that aren't an axis-aligned rectangle
    (hexagons, octagons, stars, etc.). Used by the designer + preview
    overlay to draw the correct cut line."""
    corner_radius_pt: float = 0.0
    """For rounded rectangles, the corner radius in PDF points (0 for a
    plain rectangle, ellipse, or polygon). Derived from the bezier-corner
    geometry of the source path so the editable area in the designer
    matches the imported cut line, including its rounding."""
    path: list[tuple[float, float]] | None = None
    """For `kind == "polygon"`, the ordered vertex list **normalised to
    the bbox**, i.e. each `(u, v)` is in `[0, 1]` where `(0, 0)` is
    the bbox top-left and `(1, 1)` is the bbox bottom-right. Stored
    normalised so it scales / repositions for free with the bbox and
    survives any future client-side transforms without re-extraction.
    `None` for rect / ellipse slots."""


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
            geom = _geometric_bbox(item)
            if geom is None:
                continue
            # `_geometric_bbox` returns coords in PyMuPDF-native top-left
            # space already - x0/y0 = top-left corner, x1/y1 = bottom-
            # right corner of the path's geometric extent. No y-flip
            # required.
            x0, y0_top, x1, y1_top = geom
            x = min(x0, x1)
            y_top = min(y0_top, y1_top)
            w = abs(x1 - x0)
            h = abs(y1_top - y0_top)
            if w < 1.0 or h < 1.0:
                continue

            # Skip drawings that are essentially the whole page - those
            # are almost always artboard borders / clipping frames /
            # background fills rather than real slot positions, and
            # picking them up makes the slot list noisy and the
            # auto-ordering wrong.
            if w >= page_w * 0.95 and h >= page_h * 0.95:
                continue

            layer = _layer_for_drawing(item, layer_names)
            on_position_layer = (
                layer is not None and positions_layer is not None and layer == positions_layer
            )
            # Try polygon first - if the drawing is a closed straight-
            # line polygon that *isn't* an axis-aligned rectangle, we
            # capture its actual vertex path and skip the rect/ellipse
            # heuristic. Hexagons / octagons / stars / die-cut shapes
            # all flow through this branch; everything else falls back
            # to the existing detector so rect + rounded-rect + ellipse
            # behaviour is byte-identical for previously-imported PDFs.
            poly_path = _extract_polygon_path(item, x, y_top, x + w, y_top + h)
            if poly_path is not None:
                kind = "polygon"
                radius = 0.0
            else:
                kind = _detect_kind(item)
                radius = (
                    _detect_corner_radius(item, x, y_top, x + w, y_top + h)
                    if kind == "rect"
                    else 0.0
                )
            shapes.append(
                ParsedShape(
                    page_index=0,
                    shape_index=i,
                    bbox=(round(x, 3), round(y_top, 3), round(w, 3), round(h, 3)),
                    layer=layer,
                    is_position_slot=on_position_layer,
                    kind=kind,
                    corner_radius_pt=round(radius, 3),
                    path=(
                        [(round(u, 5), round(v, 5)) for (u, v) in poly_path]
                        if poly_path is not None
                        else None
                    ),
                )
            )

        if positions_layer:
            position_only = [s for s in shapes if s.is_position_slot]
            if position_only:
                shapes = position_only

        # Some PDFs (notably Illustrator round-trips) emit the same
        # rectangle twice as overlapping paths - once as the visible
        # stroke, once as a hidden fill or duplicate. Visually the user
        # sees one slot; the parser would see two stacked at the same
        # position, both clickable and both numbered. Collapse exact
        # duplicates (same x,y,w,h within 0.5pt = ~0.18mm) to a single
        # entry, keeping the first occurrence so shape ordering stays
        # stable.
        dedup: list[ParsedShape] = []
        seen: list[tuple[float, float, float, float]] = []
        for s in shapes:
            sig = s.bbox
            is_dupe = any(
                abs(sig[0] - p[0]) < 0.5
                and abs(sig[1] - p[1]) < 0.5
                and abs(sig[2] - p[2]) < 0.5
                and abs(sig[3] - p[3]) < 0.5
                for p in seen
            )
            if is_dupe:
                continue
            seen.append(sig)
            dedup.append(s)
        shapes = dedup

        # Renumber shape_index to be a clean 0..N sequence after the
        # filtering above. Without this, anything downstream that uses
        # shape_index as a dense array index breaks (and the indices
        # become misleading "drawing indices" rather than slot indices).
        for new_idx, s in enumerate(shapes):
            s.shape_index = new_idx

        return ParsedTemplate(
            page_width=page_w,
            page_height=page_h,
            has_positions_ocg=positions_layer is not None,
            positions_layer=positions_layer,
            shapes=shapes,
        )
    finally:
        doc.close()


def _geometric_bbox(
    drawing: dict[str, Any],
) -> tuple[float, float, float, float] | None:
    """Return `(x0, y0, x1, y1)` for the drawing's *geometric* extent
    (no stroke padding) in raw PDF coords (origin bottom-left, y grows
    up). Falls back to the drawing's `rect` minus half the stroke
    width when items aren't available.
    """
    items = drawing.get("items") or []
    xs: list[float] = []
    ys: list[float] = []
    for it in items:
        if not it:
            continue
        op = it[0] if isinstance(it, (list, tuple)) else None
        if op == "re" and len(it) >= 2:
            r = it[1]
            xs.extend([float(r.x0), float(r.x1)])
            ys.extend([float(r.y0), float(r.y1)])
        elif op == "l" and len(it) >= 3:
            for p in (it[1], it[2]):
                xs.append(float(p.x))
                ys.append(float(p.y))
        elif op == "c" and len(it) >= 5:
            for p in (it[1], it[2], it[3], it[4]):
                xs.append(float(p.x))
                ys.append(float(p.y))
        elif op == "qu" and len(it) >= 2:
            q = it[1]
            for p in (q.ul, q.ur, q.ll, q.lr):
                xs.append(float(p.x))
                ys.append(float(p.y))

    if xs and ys:
        return (min(xs), min(ys), max(xs), max(ys))

    # Fallback: drawing["rect"] is stroke-inclusive (extends half the
    # stroke width past the geometric edge on every side). Subtract
    # that fudge so the bbox we return matches the cut line.
    rect = drawing.get("rect")
    if rect is None:
        return None
    stroke_pad = float(drawing.get("width") or 0.0) / 2.0
    x0 = float(rect.x0) + stroke_pad
    y0 = float(rect.y0) + stroke_pad
    x1 = float(rect.x1) - stroke_pad
    y1 = float(rect.y1) - stroke_pad
    # If the stroke padding swallows the whole rect we'd rather return
    # the original than a zero/negative bbox.
    if x1 <= x0 or y1 <= y0:
        x0, y0, x1, y1 = (
            float(rect.x0),
            float(rect.y0),
            float(rect.x1),
            float(rect.y1),
        )
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


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


def _detect_kind(drawing: dict[str, Any]) -> str:
    """Classify a parsed drawing as `"rect"` or `"ellipse"`.

    PyMuPDF returns each path as a list of items in `drawing["items"]`,
    where each item is a tuple keyed by its first element:

        ("re", Rect, ...)              - rectangle op
        ("l",  Point, Point)           - straight line segment
        ("c",  Point, Point, Point, P) - cubic Bezier segment
        ("qu", ...)                    - quadrilateral

    Heuristic:
      * Has an `re` op or no curves at all  -> rect
      * Has curves AND straight lines       -> rect (rounded rect)
      * Has curves but NO straight lines    -> ellipse
    """
    items = drawing.get("items") or []
    if not items:
        return "rect"
    has_re = False
    has_line = False
    has_curve = False
    for it in items:
        if not it:
            continue
        op = it[0] if isinstance(it, (list, tuple)) else None
        if op == "re":
            has_re = True
        elif op == "l":
            has_line = True
        elif op == "c":
            has_curve = True
    if has_re or not has_curve:
        return "rect"
    if has_line:
        return "rect"
    return "ellipse"


def _detect_corner_radius(
    drawing: dict[str, Any], x0: float, y0: float, x1: float, y1: float
) -> float:
    """For a rounded-rect path, return the corner radius in PDF points.

    A rounded rect's path mixes straight edges with one cubic Bezier per
    corner. Each corner curve's start sits on one edge of the bbox at
    distance `r` from the actual corner, and its end sits on the
    perpendicular edge at the same distance `r`. We scan every cubic
    segment, look for ones whose endpoints lie on two perpendicular
    bbox edges, and average the implied radii. Returns 0 if nothing
    matches (pure rectangle or non-corner curves).
    """
    items = drawing.get("items") or []
    if not items:
        return 0.0
    # Tolerance for "on this edge" - some Illustrator exports are off
    # by hundredths of a point.
    eps = 1.0
    radii: list[float] = []
    for it in items:
        if not it or len(it) < 5:
            continue
        op = it[0] if isinstance(it, (list, tuple)) else None
        if op != "c":
            continue
        p_start = it[1]
        p_end = it[4]
        sx, sy = float(p_start.x), float(p_start.y)
        ex, ey = float(p_end.x), float(p_end.y)

        on_left_s = abs(sx - x0) <= eps
        on_right_s = abs(sx - x1) <= eps
        on_top_s = abs(sy - y0) <= eps
        on_bottom_s = abs(sy - y1) <= eps
        on_left_e = abs(ex - x0) <= eps
        on_right_e = abs(ex - x1) <= eps
        on_top_e = abs(ey - y0) <= eps
        on_bottom_e = abs(ey - y1) <= eps

        # Top-left corner: start on top edge, end on left edge (or vice versa).
        if (on_top_s and on_left_e) or (on_left_s and on_top_e):
            r1 = abs(sx - x0) if on_top_s else abs(ex - x0)
            r2 = abs(ey - y0) if on_left_e else abs(sy - y0)
            radii.extend([r1, r2])
        # Top-right corner.
        elif (on_top_s and on_right_e) or (on_right_s and on_top_e):
            r1 = abs(x1 - sx) if on_top_s else abs(x1 - ex)
            r2 = abs(ey - y0) if on_right_e else abs(sy - y0)
            radii.extend([r1, r2])
        # Bottom-left corner.
        elif (on_bottom_s and on_left_e) or (on_left_s and on_bottom_e):
            r1 = abs(sx - x0) if on_bottom_s else abs(ex - x0)
            r2 = abs(y1 - ey) if on_left_e else abs(y1 - sy)
            radii.extend([r1, r2])
        # Bottom-right corner.
        elif (on_bottom_s and on_right_e) or (on_right_s and on_bottom_e):
            r1 = abs(x1 - sx) if on_bottom_s else abs(x1 - ex)
            r2 = abs(y1 - ey) if on_right_e else abs(y1 - sy)
            radii.extend([r1, r2])

    if not radii:
        return 0.0
    # Drop near-zero values that come from non-corner segments slipping
    # through the edge tests (e.g. a degenerate bezier sat right on an
    # edge), then average what's left.
    real = [r for r in radii if r > 0.5]
    if not real:
        return 0.0
    return sum(real) / len(real)


def _extract_polygon_path(
    drawing: dict[str, Any], x0: float, y0: float, x1: float, y1: float
) -> list[tuple[float, float]] | None:
    """Recover the ordered vertex list for a closed straight-line polygon.

    Returns vertices normalised to the bbox (`(u, v)` in `[0, 1]`) when
    the drawing qualifies as a polygon, else `None`. Qualifying paths:

      * Contain *only* line segments (`l` ops). Any `re`, `c` or `qu`
        op disqualifies (rect, curve, quadrilateral).
      * Have ≥3 connected segments forming a single chain (each segment
        starts where the previous one ended, modulo a small tolerance).
      * Are *not* a 4-vertex axis-aligned rectangle - those keep their
        existing `kind: "rect"` treatment so rect-specific code paths
        (corner radius, edge handles, etc.) don't regress.
    """
    items = drawing.get("items") or []
    if not items:
        return None
    for it in items:
        if not it:
            continue
        op = it[0] if isinstance(it, (list, tuple)) else None
        if op in ("re", "c", "qu"):
            return None

    segments: list[tuple[float, float, float, float]] = []
    for it in items:
        if not it:
            continue
        op = it[0] if isinstance(it, (list, tuple)) else None
        if op == "l" and len(it) >= 3:
            segments.append(
                (
                    float(it[1].x),
                    float(it[1].y),
                    float(it[2].x),
                    float(it[2].y),
                )
            )
    if len(segments) < 3:
        return None

    eps = 0.5  # ~0.18mm - exporters routinely round here
    pts: list[tuple[float, float]] = [
        (segments[0][0], segments[0][1]),
        (segments[0][2], segments[0][3]),
    ]
    for sx, sy, ex, ey in segments[1:]:
        last = pts[-1]
        if abs(sx - last[0]) <= eps and abs(sy - last[1]) <= eps:
            pts.append((ex, ey))
        elif abs(ex - last[0]) <= eps and abs(ey - last[1]) <= eps:
            pts.append((sx, sy))
        else:
            # Path isn't a single connected chain - bail. (Could be
            # multiple disjoint shapes in one drawing; safer to leave
            # those as a rectangle bbox than to invent a polygon.)
            return None

    if (
        len(pts) >= 4
        and abs(pts[-1][0] - pts[0][0]) <= eps
        and abs(pts[-1][1] - pts[0][1]) <= eps
    ):
        pts = pts[:-1]
    if len(pts) < 3:
        return None

    if len(pts) == 4:
        all_axis_aligned = True
        for i in range(4):
            ax, ay = pts[i]
            bx, by = pts[(i + 1) % 4]
            if not (abs(bx - ax) <= eps or abs(by - ay) <= eps):
                all_axis_aligned = False
                break
        if all_axis_aligned:
            return None

    w = max(1e-6, x1 - x0)
    h = max(1e-6, y1 - y0)
    return [((px - x0) / w, (py - y0) / h) for px, py in pts]


def _layer_for_drawing(drawing: dict[str, Any], layer_names: list[str]) -> str | None:
    layer = drawing.get("layer")
    if isinstance(layer, str):
        return layer
    layer_idx = drawing.get("oc")
    if isinstance(layer_idx, int) and 0 <= layer_idx < len(layer_names):
        return layer_names[layer_idx]
    return None
