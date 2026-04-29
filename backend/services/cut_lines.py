"""Embed RIP-recognised cut-line paths into a composited PDF.

The compositor's job is to lay artwork into slots and ship a print-ready
sheet. Print/cut RIPs (Roland VersaWorks, Mimaki RasterLink, Summa GoSign,
etc.) decide what to ROUTE TO THE CUTTER vs print to the heads by looking
for paths drawn in a PDF Separation colour with a name they recognise -
``CutContour`` for Roland, ``Through-cut`` for Mimaki, custom names for
shop-specific workflows.

This module post-processes the composited PDF (after pymupdf has placed
the artwork, and after the POSITIONS OCG has been turned off so the slot
rectangles don't print) and adds:

1. A ``/Separation`` colour space resource on every page, named to match
   the user's chosen spot colour.
2. A fresh content stream appended to each page that strokes the outline
   of every slot using that Separation. The stroke is drawn at the
   slot's ORIGINAL bbox - bleed never extends the cut line, only the
   asset placement.
3. An Optional Content Group (OCG) wrapping the cut-line content so the
   path opens as a separate, named, toggleable layer in Illustrator,
   Acrobat, and the print/cut RIP. The layer's name is the spot
   colour's name verbatim (``CutContour``, ``Gloss``, ``White``,
   ``PerfCut`` etc.) so when this becomes a multi-layer feature each
   spot gets its own clearly-labelled Illustrator layer.

Coordinate systems
------------------

The slot bboxes coming from `pdf_parser` and `pdf_generator` use PyMuPDF's
top-left origin (y grows down). PDF content streams use the file format's
native bottom-left origin (y grows up). Every coordinate written to the
content stream is therefore flipped:

    pdf_x = top_left_x
    pdf_y = page_height - top_left_y - shape_height

Cutter compatibility
--------------------

* Tint transform: linear (Type 2) function from 100 % white at tint 0
  to the user's preview RGB at tint 1. Means the spot prints exactly the
  picked colour on a printer that doesn't recognise the Separation; on a
  RIP that does, the geometry is sent to the cutter and never inked.
* Stroke width: defaults to 0.25 pt (~0.09 mm) which is a hairline -
  what every cutter expects. Configurable per call.
* Path geometry: rect / rounded-rect / ellipse / polygon all supported,
  matching the geometric kinds `pdf_generator` and `pdf_parser` produce.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass
from typing import Any

# Lazy pikepdf import so this module stays importable in environments
# where pikepdf isn't installed yet (mirrors the pattern used by
# `color_swap`).
_pikepdf: Any = None


def _pp():
    global _pikepdf
    if _pikepdf is None:
        import pikepdf as _module  # type: ignore[import-untyped]
        _pikepdf = _module
    return _pikepdf


# Cubic Bezier "magic number" approximation of a quarter-circle arc.
# Same constant used by `pdf_generator._draw_rounded_rect`; kept here
# so this module stays self-contained.
_KAPPA = 0.5522847498307933


@dataclass
class CutLineSpec:
    """Everything the embedder needs to add cut-line paths to a PDF."""

    spot_name: str
    """The Separation colour name. Must match the RIP's expected name
    (e.g. ``"CutContour"`` for Roland) or the geometry will be inked,
    not cut."""

    rgb: tuple[int, int, int]
    """Preview RGB used as the Separation's DeviceRGB alternate so the
    cut path is visible in non-RIP PDF viewers (Acrobat, browsers, etc.)
    and recognisable as a cut on screen. Pure magenta is the convention."""

    stroke_width_pt: float = 0.25
    """Hairline by default. Cutters follow the centre of the stroke
    regardless of width."""


class CutLineError(RuntimeError):
    pass


def embed(
    *,
    pdf_bytes: bytes,
    slot_shapes: list[dict],
    spec: CutLineSpec,
) -> bytes:
    """Return a copy of ``pdf_bytes`` with cut-line paths added.

    Args:
        pdf_bytes: composited PDF (single page expected for v1, but the
            implementation is page-aware so multi-page PDFs work too).
        slot_shapes: same shape list the compositor consumed - each
            entry has `bbox: [x, y_top, w, h]` (top-left origin, PDF pt),
            `kind: "rect" | "ellipse" | "polygon"`, optional
            `corner_radius_pt` and `path` (normalised polygon vertices).
        spec: which Separation to use, what tint to render in non-RIP
            viewers, and how thick to stroke.
    """
    if not slot_shapes:
        return pdf_bytes

    pikepdf = _pp()
    try:
        pdf = pikepdf.open(io.BytesIO(pdf_bytes))
    except Exception as exc:
        raise CutLineError(f"Failed to open composited PDF: {exc}") from exc

    try:
        # All slot indices come from the parser/generator with `page_index`
        # set, so multi-page templates (when we add them) Just Work. For
        # v1 every shape lives on page 0.
        shapes_by_page: dict[int, list[dict]] = {}
        for s in slot_shapes:
            try:
                page_idx = int(s.get("page_index") or 0)
            except (TypeError, ValueError):
                page_idx = 0
            shapes_by_page.setdefault(page_idx, []).append(s)

        # Register the OCG once at the document level. Pages reference
        # it by an indirect ref; Illustrator and Acrobat then show it
        # as a single named layer affecting every page that opts in.
        ocg_ref = _ensure_ocg(pdf, layer_name=spec.spot_name)

        for page_idx, page in enumerate(pdf.pages):
            shapes = shapes_by_page.get(page_idx)
            if not shapes:
                continue

            page_height = float(page.MediaBox[3] - page.MediaBox[1])

            sep_name = _add_separation_resource(pdf, page, spec)
            mc_name = _attach_ocg_to_page(page, ocg_ref, layer_name=spec.spot_name)
            content = _build_cut_content_stream(
                shapes=shapes,
                page_height=page_height,
                separation_resource_name=sep_name,
                stroke_width_pt=spec.stroke_width_pt,
                ocg_property_name=mc_name,
            )
            if content:
                page.contents_add(pikepdf.Stream(pdf, content), prepend=False)

        out = io.BytesIO()
        pdf.save(out)
        return out.getvalue()
    finally:
        pdf.close()


# ---------------------------------------------------------------------------
# Separation resource
# ---------------------------------------------------------------------------


def _add_separation_resource(pdf, page, spec: CutLineSpec) -> str:
    """Install a ``/Separation`` colour space on ``page`` whose name in
    the page's resource dict is the same as ``spec.spot_name`` (Roland
    VersaWorks looks the resource up by that name, not by the underlying
    Separation /N).

    Returns the resource-dict key the content stream should reference
    (e.g. ``"CutContour"``).
    """
    pikepdf = _pp()
    Name = pikepdf.Name
    Array = pikepdf.Array
    Dictionary = pikepdf.Dictionary

    # Tint transform: linear interpolation from white -> preview RGB.
    # Type 2 (exponential) with N=1 is just linear interpolation; this
    # matches what Illustrator emits when you save a swatch as a global
    # spot with a simple alternate.
    r, g, b = (max(0.0, min(1.0, c / 255.0)) for c in spec.rgb)
    tint = Dictionary(
        FunctionType=2,
        Domain=Array([0, 1]),
        Range=Array([0, 1, 0, 1, 0, 1]),
        C0=Array([1, 1, 1]),
        C1=Array([r, g, b]),
        N=1,
    )

    # Build the Separation array. Both /N (the Separation's name in PDF
    # space) and the resource key use spec.spot_name verbatim.
    sep_array = Array([
        Name("/Separation"),
        Name("/" + spec.spot_name),
        Name("/DeviceRGB"),
        tint,
    ])

    # Ensure /Resources/ColorSpace exists, then install our entry.
    resources = page.Resources if "/Resources" in page else None
    if resources is None:
        resources = Dictionary()
        page["/Resources"] = resources

    if "/ColorSpace" in resources:
        cs = resources.ColorSpace
    else:
        cs = Dictionary()
        resources["/ColorSpace"] = cs

    cs[Name("/" + spec.spot_name)] = sep_array
    return spec.spot_name


# ---------------------------------------------------------------------------
# Optional Content Groups (Illustrator / Acrobat layers)
# ---------------------------------------------------------------------------


def _ensure_ocg(pdf, *, layer_name: str):
    """Return an indirect reference to a document-level OCG named
    ``layer_name``, creating it (and the surrounding /OCProperties tree
    on the catalog) if needed.

    Re-running embed for the same layer name doesn't duplicate - we
    look up by /Name on the existing OCGs first. This matters when
    the future multi-layer feature calls embed() N times for N spots
    on the same PDF, or when we re-generate after a UI tweak.
    """
    pikepdf = _pp()
    Name = pikepdf.Name
    Array = pikepdf.Array
    Dictionary = pikepdf.Dictionary

    catalog = pdf.Root
    # /OCProperties / OCGs / D / Order / ON / OFF
    if "/OCProperties" not in catalog:
        catalog[Name("/OCProperties")] = Dictionary(
            OCGs=Array([]),
            D=Dictionary(
                Name=pikepdf.String("Default"),
                Order=Array([]),
                ON=Array([]),
                OFF=Array([]),
                Intent=Array([Name("/View"), Name("/Design")]),
                BaseState=Name("/ON"),
            ),
        )
    ocp = catalog.OCProperties
    if "/OCGs" not in ocp:
        ocp[Name("/OCGs")] = Array([])
    if "/D" not in ocp:
        ocp[Name("/D")] = Dictionary(
            Name=pikepdf.String("Default"),
            Order=Array([]),
            ON=Array([]),
            OFF=Array([]),
            Intent=Array([Name("/View"), Name("/Design")]),
            BaseState=Name("/ON"),
        )
    d = ocp.D
    for key, default in (
        ("/Order", Array([])),
        ("/ON", Array([])),
        ("/OFF", Array([])),
    ):
        if key not in d:
            d[Name(key)] = default

    # Look up existing OCG by name.
    for ocg in ocp.OCGs:
        try:
            if str(ocg.Name) == layer_name:
                return ocg
        except Exception:
            continue

    # Otherwise create a fresh OCG and register it on the doc.
    ocg = pdf.make_indirect(
        Dictionary(
            Type=Name("/OCG"),
            Name=pikepdf.String(layer_name),
            Intent=Array([Name("/View"), Name("/Design")]),
            # Usage tags help Acrobat group the layer correctly in its
            # Layers panel and signal that this is a print-affecting
            # layer (so users don't think it's a draft annotation).
            Usage=Dictionary(
                Print=Dictionary(
                    PrintState=Name("/ON"),
                    Subtype=Name("/Printed"),
                ),
                View=Dictionary(ViewState=Name("/ON")),
            ),
        )
    )
    ocp.OCGs.append(ocg)
    d.Order.append(ocg)
    d.ON.append(ocg)
    return ocg


def _attach_ocg_to_page(page, ocg_ref, *, layer_name: str) -> str:
    """Install ``ocg_ref`` as a property on the page's resource dict so
    a content stream can reference it via ``/<name> BDC``. Returns the
    name to use in the BDC operator.

    The page-resource property name is the spot colour's layer name
    prefixed to avoid colliding with any existing PDF entries (Acrobat
    doesn't care, but pymupdf and Illustrator both like distinct names
    in different scopes). Re-running on the same page reuses the
    existing entry instead of accumulating duplicates.
    """
    pikepdf = _pp()
    Name = pikepdf.Name
    Dictionary = pikepdf.Dictionary

    if "/Resources" not in page:
        page[Name("/Resources")] = Dictionary()
    resources = page.Resources
    if "/Properties" not in resources:
        resources[Name("/Properties")] = Dictionary()
    properties = resources.Properties

    prop_name = _safe_property_name(layer_name)

    # If the same layer is already attached, reuse the entry (idempotent).
    existing_key = "/" + prop_name
    if existing_key in properties:
        return prop_name

    properties[Name(existing_key)] = ocg_ref
    return prop_name


def _safe_property_name(layer_name: str) -> str:
    """Turn a user-supplied spot name into a PDF resource-dict key.

    PDF Name objects can technically be almost anything, but spaces
    and most punctuation force `#xx` hex escaping which some viewers
    handle poorly. Strip to ASCII alnum + underscore so the key is
    safe everywhere; the user-visible layer name (the OCG's /Name)
    keeps the original spelling regardless.
    """
    out = []
    for ch in layer_name:
        if ch.isalnum() or ch == "_":
            out.append(ch)
        else:
            out.append("_")
    cleaned = "".join(out).strip("_") or "Layer"
    return f"PL_{cleaned}"


# ---------------------------------------------------------------------------
# Content stream
# ---------------------------------------------------------------------------


def _build_cut_content_stream(
    *,
    shapes: list[dict],
    page_height: float,
    separation_resource_name: str,
    stroke_width_pt: float,
    ocg_property_name: str,
) -> bytes:
    """Generate the PDF operators that stroke every slot outline using
    the named Separation, wrapped in an OCG marked-content block so
    Illustrator / Acrobat / VersaWorks open it as a separate, named
    layer. Returns the raw stream bytes."""

    parts: list[str] = []
    parts.append("q")
    # /OC /<MCName> BDC opens a marked-content sequence whose visibility
    # is governed by the property dict at /Resources/Properties/<MCName>
    # - which we just set to point at the OCG. Every stroke between
    # this and the matching EMC belongs to that layer.
    parts.append(f"/OC /{ocg_property_name} BDC")
    # Cut paths sit cleanly on top of artwork. No fill, just a stroked
    # outline at the requested width.
    parts.append(f"/{separation_resource_name} CS")
    parts.append("1.0 SCN")
    parts.append(f"{stroke_width_pt:.4f} w")
    # Reasonable defaults for cutter paths: butt caps + miter joins are
    # what every Roland-supplied SVG export uses; matches the look in
    # Acrobat preview.
    parts.append("0 J")
    parts.append("0 j")
    parts.append("[] 0 d")

    for shape in shapes:
        try:
            ops = _shape_to_operators(shape, page_height)
        except Exception:
            # A malformed shape shouldn't kill the whole cut layer -
            # skip it and the rest still render. The user will see the
            # missing slot and re-export the template.
            continue
        if ops:
            parts.append(ops)
            parts.append("S")  # stroke this subpath / path

    parts.append("EMC")
    parts.append("Q")
    return ("\n".join(parts) + "\n").encode("ascii")


def _shape_to_operators(shape: dict, page_height: float) -> str:
    """Render a single slot's outline as PDF path operators in PDF
    user space (bottom-left origin)."""
    bbox = shape.get("bbox")
    if not bbox or len(bbox) < 4:
        return ""
    x_top, y_top, w, h = (float(v) for v in bbox[:4])
    if w <= 0 or h <= 0:
        return ""

    # Convert the bbox to PDF user space. (x, y) becomes the BOTTOM-LEFT
    # corner; the rect grows up and to the right from there.
    x = x_top
    y = page_height - y_top - h

    kind = str(shape.get("kind") or "rect").lower()

    if kind == "polygon":
        path = shape.get("path") or []
        return _polygon_ops(x, y, w, h, path)

    if kind == "ellipse" or kind == "circle":
        return _ellipse_ops(x, y, w, h)

    # rect / rounded rect
    radius = float(shape.get("corner_radius_pt") or 0.0)
    radius = max(0.0, min(radius, min(w, h) / 2.0))
    if radius > 0:
        return _rounded_rect_ops(x, y, w, h, radius)
    return _rect_ops(x, y, w, h)


def _rect_ops(x: float, y: float, w: float, h: float) -> str:
    return f"{_n(x)} {_n(y)} {_n(w)} {_n(h)} re"


def _rounded_rect_ops(x: float, y: float, w: float, h: float, r: float) -> str:
    """Trace a rounded rect counter-clockwise (PDF y-up) using 4 line
    segments and 4 cubic Bezier corner arcs."""
    x0, y0 = x, y
    x1, y1 = x + w, y + h
    k = _KAPPA * r

    parts = [
        # Start just past the bottom-left corner
        f"{_n(x0 + r)} {_n(y0)} m",
        # Bottom edge ->
        f"{_n(x1 - r)} {_n(y0)} l",
        # Bottom-right corner curve (counter-clockwise / sweep up)
        f"{_n(x1 - r + k)} {_n(y0)} {_n(x1)} {_n(y0 + r - k)} {_n(x1)} {_n(y0 + r)} c",
        # Right edge ^
        f"{_n(x1)} {_n(y1 - r)} l",
        # Top-right corner curve
        f"{_n(x1)} {_n(y1 - r + k)} {_n(x1 - r + k)} {_n(y1)} {_n(x1 - r)} {_n(y1)} c",
        # Top edge <-
        f"{_n(x0 + r)} {_n(y1)} l",
        # Top-left corner curve
        f"{_n(x0 + r - k)} {_n(y1)} {_n(x0)} {_n(y1 - r + k)} {_n(x0)} {_n(y1 - r)} c",
        # Left edge v
        f"{_n(x0)} {_n(y0 + r)} l",
        # Bottom-left corner curve back to start
        f"{_n(x0)} {_n(y0 + r - k)} {_n(x0 + r - k)} {_n(y0)} {_n(x0 + r)} {_n(y0)} c",
        "h",
    ]
    return "\n".join(parts)


def _ellipse_ops(x: float, y: float, w: float, h: float) -> str:
    """Trace an ellipse inscribed in (x, y, w, h) with 4 cubic Bezier
    arcs. Uses the standard kappa approximation for quarter circles
    scaled to the ellipse's semi-axes."""
    cx = x + w / 2.0
    cy = y + h / 2.0
    rx = w / 2.0
    ry = h / 2.0
    kx = _KAPPA * rx
    ky = _KAPPA * ry

    parts = [
        # Start at right-most point
        f"{_n(cx + rx)} {_n(cy)} m",
        # Quadrant 1: right -> top
        f"{_n(cx + rx)} {_n(cy + ky)} {_n(cx + kx)} {_n(cy + ry)} {_n(cx)} {_n(cy + ry)} c",
        # Quadrant 2: top -> left
        f"{_n(cx - kx)} {_n(cy + ry)} {_n(cx - rx)} {_n(cy + ky)} {_n(cx - rx)} {_n(cy)} c",
        # Quadrant 3: left -> bottom
        f"{_n(cx - rx)} {_n(cy - ky)} {_n(cx - kx)} {_n(cy - ry)} {_n(cx)} {_n(cy - ry)} c",
        # Quadrant 4: bottom -> right
        f"{_n(cx + kx)} {_n(cy - ry)} {_n(cx + rx)} {_n(cy - ky)} {_n(cx + rx)} {_n(cy)} c",
        "h",
    ]
    return "\n".join(parts)


def _polygon_ops(
    x: float, y: float, w: float, h: float, path: list[list[float] | tuple[float, float]]
) -> str:
    """Trace a polygon whose vertices are normalised to the bbox
    (`(u, v)` in [0, 1] from the bbox top-left). Path coords coming in
    from the parser are in TOP-LEFT space, so the v-axis flips: top of
    the bbox (v=0) maps to top of the rect in PDF space (y = y + h)."""
    if not path or len(path) < 3:
        return ""

    parts: list[str] = []
    for idx, vert in enumerate(path):
        try:
            u, v = float(vert[0]), float(vert[1])
        except (TypeError, ValueError, IndexError):
            return ""
        if not math.isfinite(u) or not math.isfinite(v):
            return ""
        px = x + u * w
        py = y + (1.0 - v) * h
        if idx == 0:
            parts.append(f"{_n(px)} {_n(py)} m")
        else:
            parts.append(f"{_n(px)} {_n(py)} l")
    parts.append("h")
    return "\n".join(parts)


def _n(value: float) -> str:
    """Render a float for a PDF content stream. Strips trailing zeros
    for shorter output and avoids scientific notation."""
    if not math.isfinite(value):
        value = 0.0
    formatted = f"{value:.4f}".rstrip("0").rstrip(".")
    return formatted if formatted not in ("-0", "") else "0"
