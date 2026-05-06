"""Print-ready PDF compositor.

Takes the source template PDF and a map of `{shape_index -> asset_pdf_bytes}`,
and produces an output PDF where:

* Page dimensions match the source template **byte-exact** (no resampling,
  no resize).
* Each asset PDF is placed inside its slot's bounding box, scaled
  proportionally and centred (we never crop or stretch).
* The `POSITIONS` Optional Content Group is set to OFF in the output, so
  print RIPs (VersaWorks et al.) and PDF viewers honour the toggle and the
  slot rectangles never appear in the rendered output.

We deliberately do **not** delete the rectangles from the content stream -
keeping them inside the OCG means the file is round-trippable: a user can
re-open it in Illustrator, re-enable the layer, and see the registration.
"""

from __future__ import annotations

import io
import math
import re
from dataclasses import dataclass

import pymupdf  # type: ignore[import-untyped]
from PIL import Image

from backend.services import color_swap, cut_lines, image_filters

# Resolution used when we have to rasterise an asset to apply a colour
# filter. 300 DPI matches print expectations; quality 92 keeps the
# embedded JPEG visually indistinguishable from the original render.
FILTER_RASTER_DPI = 300
FILTER_RASTER_QUALITY = 92


@dataclass
class CompositedSheet:
    pdf_bytes: bytes
    page_width_pt: float
    page_height_pt: float
    slots_filled: int
    slots_total: int
    # Aggregate colour-swap report across all asset PDFs. Empty when
    # no swaps were configured.
    color_swap_report: dict | None = None


class CompositorError(RuntimeError):
    pass


# Slot-local transform applied to each placed asset.
@dataclass
class SlotTransform:
    rotation_deg: int = 0           # 0/90/180/270 (others snapped to nearest)
    fit_mode: str = "contain"       # "contain" | "cover" | "stretch" | "manual"
    # If fit_mode == "manual" these are interpreted in slot-local PT, with
    # origin = slot top-left, before rotation. Used by Phase 3 designer.
    x_pt: float = 0.0
    y_pt: float = 0.0
    w_pt: float | None = None
    h_pt: float | None = None
    # Optional colour filter id (matches `image_filters.FILTERS`). Triggers
    # the rasterised insert path so the look is baked into the print.
    filter_id: str = "none"


def composite(
    *,
    template_pdf: bytes,
    slot_shapes: list[dict],
    asset_pdfs: dict[int, bytes],
    slot_transforms: dict[int, SlotTransform] | None = None,
    positions_layer: str = "POSITIONS",
    color_swaps: list[dict] | None = None,
    cut_line_spec: cut_lines.CutLineSpec | None = None,
) -> CompositedSheet:
    """Build the print-ready PDF.

    Args:
        template_pdf: source template PDF bytes (single page expected for v1).
        slot_shapes: list of `{shape_index, page_index, bbox: [x,y,w,h], ...}`
            with origin top-left, in PDF points - same shape as
            `pdf_parser.parse(...).shapes`. Shapes may also carry
            `bleed_pt` and `safe_pt` (Phase 2).
        asset_pdfs: map of `shape_index -> single-page PDF bytes` for slots
            that should be filled. Slots not in this map are left empty.
        slot_transforms: optional per-slot `SlotTransform` describing rotation,
            fit mode, and (for `manual`) explicit placement.
        positions_layer: name of the OCG layer to switch off in the output.
        cut_line_spec: optional. When set, the output PDF gets a Separation
            colour space named `cut_line_spec.spot_name` and every slot's
            outline is stroked in that spot so a print/cut RIP routes the
            geometry to its cutter. The POSITIONS OCG is still turned off
            so the original construction rectangles remain hidden; the cut
            lines are drawn on top as a fresh, always-visible content
            stream that owns the cut path independently.
    """

    transforms = slot_transforms or {}
    swap_rules = list(color_swaps or [])
    swap_report = color_swap.ColorSwapReport()

    doc = pymupdf.open(stream=template_pdf, filetype="pdf")
    try:
        page = doc[0]
        page_w = float(page.rect.width)
        page_h = float(page.rect.height)

        slots_total = len(slot_shapes)
        slots_filled = 0

        shape_lookup = {int(s["shape_index"]): s for s in slot_shapes}

        # Tag every placed asset with an Optional Content Group named
        # "DESIGN" so when the print sheet is opened in Illustrator (or
        # Acrobat) the artwork appears under its own toggle-able layer,
        # right next to the existing POSITIONS layer. We add the OCG
        # once up-front and reuse the xref for every asset.
        try:
            design_ocg_xref = doc.add_ocg(
                "DESIGN", on=True, intent="View", usage="Artwork"
            )
        except Exception:
            # If OCG creation fails (very old pymupdf or hostile source),
            # ship the file untagged - artwork still prints fine, it just
            # won't be a named layer in Illustrator.
            design_ocg_xref = 0

        for shape_index, asset_bytes in asset_pdfs.items():
            # Apply colour swaps to a fresh copy of the asset BEFORE
            # placing it. Swap output is always DeviceRGB so Adobe
            # reads back the user's exact 0-255 triplet.
            if swap_rules:
                try:
                    asset_bytes, per_asset = color_swap.apply(
                        asset_bytes, swap_rules
                    )
                    swap_report.swaps_applied += per_asset.swaps_applied
                    for k, v in per_asset.swaps_by_color.items():
                        swap_report.swaps_by_color[k] = (
                            swap_report.swaps_by_color.get(k, 0) + v
                        )
                    swap_report.gradients_skipped += per_asset.gradients_skipped
                    swap_report.raster_skipped += per_asset.raster_skipped
                    swap_report.unmatched.update(per_asset.unmatched)
                except Exception:
                    # Never let a colour-swap failure block the print -
                    # fall back to the original asset bytes.
                    pass
            shape = shape_lookup.get(int(shape_index))
            if shape is None:
                continue
            x, y_top, w, h = shape["bbox"]
            if w <= 0 or h <= 0:
                continue
            bleed = float(shape.get("bleed_pt") or 0.0)

            # Effective fillable area = slot bbox grown by bleed on every side.
            # Bleed never grows the artboard - we just allow the placed asset
            # to extend that far past the slot edge during placement.
            ex = x - bleed
            ey = y_top - bleed
            ew = w + bleed * 2
            eh = h + bleed * 2

            t = transforms.get(int(shape_index)) or SlotTransform()
            # Free-form designer angle, kept verbatim so we can place at
            # arbitrary degrees (15deg, 22.5deg, etc.). The orthogonal
            # snap below is only used to pick the orientation-aware
            # default fit dimensions, NOT to throw away the angle itself.
            rot_free = _normalise_free_rotation(t.rotation_deg)
            rot = _nearest_orthogonal(rot_free)
            is_orthogonal = abs(rot - rot_free) < 0.01

            asset_doc = pymupdf.open(stream=asset_bytes, filetype="pdf")
            try:
                if asset_doc.page_count == 0:
                    continue
                asset_page = asset_doc[0]
                aw = float(asset_page.rect.width)
                ah = float(asset_page.rect.height)
                if aw <= 0 or ah <= 0:
                    continue

                # Two flavours of "fit" dimensions:
                #
                # `fit_aw / fit_ah`:  the asset's effective width/height
                #   for layout maths AFTER pymupdf's `show_pdf_page`
                #   rotates the content INTO the target rect (orthogonal
                #   fast path only — used for 90/270 to swap aspect).
                #
                # `nat_w / nat_h`:    the asset's native width/height
                #   regardless of rotation. Used by the arbitrary-angle
                #   path because that path rotates the asset *around the
                #   target rect's centre* AFTER scaling to the rect's
                #   dimensions - so the target rect must keep the
                #   asset's native aspect (sx == sy) or the rotation
                #   produces a visible skew, not a clean rotation. This
                #   was the playing-card squash bug at 22 deg / 110 deg.
                fit_aw, fit_ah = (ah, aw) if (is_orthogonal and rot in (90, 270)) else (aw, ah)
                nat_w, nat_h = aw, ah

                if t.fit_mode == "manual" and t.w_pt and t.h_pt:
                    # Manual coords are relative to the SLOT bbox top-left
                    # (not the bleed-extended one). This matches the designer
                    # UI - negative offsets are how users opt into bleed.
                    #
                    # `(x_pt, y_pt, w_pt, h_pt)` describes the asset's
                    # bounding box BEFORE the user's rotation (the SlotDesigner
                    # and SlotOverlay both render the box at that footprint
                    # and then apply CSS `rotate()` around its centre). For
                    # the orthogonal path with rot in (90, 270) we have to
                    # swap the rect to the on-page (post-rotation) orientation
                    # so `show_pdf_page` rotates the asset INTO a matching-
                    # aspect rect. For the arbitrary-angle path we keep the
                    # rect as the asset's pre-rotation footprint (no swap)
                    # because the custom matrix rotates around the rect's
                    # centre and any aspect mismatch becomes a skew.
                    cx_loc = t.x_pt + t.w_pt / 2.0
                    cy_loc = t.y_pt + t.h_pt / 2.0
                    if is_orthogonal and rot in (90, 270):
                        vis_w, vis_h = t.h_pt, t.w_pt
                    else:
                        vis_w, vis_h = t.w_pt, t.h_pt
                    target_rect = pymupdf.Rect(
                        x + cx_loc - vis_w / 2.0,
                        y_top + cy_loc - vis_h / 2.0,
                        x + cx_loc + vis_w / 2.0,
                        y_top + cy_loc + vis_h / 2.0,
                    )
                    keep_prop = False
                elif t.fit_mode == "stretch":
                    target_rect = pymupdf.Rect(ex, ey, ex + ew, ey + eh)
                    keep_prop = False
                elif t.fit_mode == "cover":
                    # Same orthogonal-vs-arbitrary split as manual mode.
                    # Cover-fit always matches one slot edge; for the
                    # arbitrary path we use the asset's native aspect and
                    # let the matrix rotate it around the slot centre.
                    if is_orthogonal:
                        fit = _fit_cover(ew, eh, fit_aw, fit_ah)
                    else:
                        fit = _fit_cover(ew, eh, nat_w, nat_h)
                    target_rect = pymupdf.Rect(
                        ex + fit.offset_x,
                        ey + fit.offset_y,
                        ex + fit.offset_x + fit.width,
                        ey + fit.offset_y + fit.height,
                    )
                    keep_prop = True
                else:  # "contain" (default)
                    # Place the asset at its native physical size, centred
                    # on the slot. This is what a print designer expects:
                    # an 86x60 mm playing card stays 86x60 mm, not scaled
                    # up to the 88.2x63 mm cut line. But if the asset is
                    # drastically larger than the slot (e.g. a raster photo
                    # at 300 DPI), contain-fit it so it doesn't overflow
                    # into adjacent slots.
                    cx = x + w / 2.0
                    cy = y_top + h / 2.0
                    # Use orientation-swapped dims only for the orthogonal
                    # fast path; the arbitrary-angle path uses the native
                    # asset rect (see `nat_w/nat_h` comment above).
                    rect_w = fit_aw if is_orthogonal else nat_w
                    rect_h = fit_ah if is_orthogonal else nat_h
                    # Cap: if asset exceeds the slot+bleed box by >50%,
                    # it's almost certainly a large raster not a matched
                    # PDF artwork. Shrink to fit inside the slot.
                    cap_w = ew * 1.5
                    cap_h = eh * 1.5
                    if rect_w > cap_w or rect_h > cap_h:
                        ar = rect_w / rect_h
                        rect_w = w
                        rect_h = w / ar
                        if rect_h > h:
                            rect_h = h
                            rect_w = h * ar
                    target_rect = pymupdf.Rect(
                        cx - rect_w / 2.0,
                        cy - rect_h / 2.0,
                        cx + rect_w / 2.0,
                        cy + rect_h / 2.0,
                    )
                    keep_prop = True

                # Choose the placement source: vector PDF (passthrough) or
                # rasterised JPEG (when a colour filter is selected).
                # `place_doc` is whatever pymupdf will treat as a single-
                # page asset PDF for show_pdf_page.
                if image_filters.is_passthrough(t.filter_id):
                    place_doc = asset_doc
                    place_owns_doc = False
                else:
                    jpeg_bytes = _render_filtered_jpeg(
                        asset_page,
                        t.filter_id,
                    )
                    # Wrap the JPEG into a 1-page PDF so the same
                    # show_pdf_page + matrix-surgery path can rotate it
                    # by an arbitrary angle. Going via insert_image here
                    # would force orthogonal-only rotation, which is
                    # exactly the limitation we're fixing.
                    place_doc = _wrap_image_as_pdf(jpeg_bytes, aw, ah)
                    place_owns_doc = True

                try:
                    if is_orthogonal:
                        # Fast path: pymupdf's native rotate kwarg handles
                        # 0/90/180/270. Crucially, pymupdf's `rotate=N`
                        # rotates COUNTER-clockwise on screen for positive
                        # N (verified empirically with a directional test
                        # asset: rotate=90 puts the asset's TOP edge on
                        # the LEFT of the page). The designer (and
                        # SlotOverlay canvas preview) use CSS
                        # `transform: rotate(Ndeg)` which is CLOCKWISE
                        # for positive N. Passing `(-rot) % 360` makes
                        # the print output match what the user designed
                        # and what they saw in the on-screen preview.
                        # The earlier "rotate=90 looked right" feedback
                        # only fooled us because the user's playing-card
                        # asset was nearly symmetric under 90 deg flips.
                        page.show_pdf_page(
                            target_rect,
                            place_doc,
                            pno=0,
                            rotate=(-rot) % 360,
                            keep_proportion=keep_prop,
                            oc=design_ocg_xref,
                        )
                    else:
                        # Arbitrary angle: register the asset with no
                        # rotation, then rewrite the wrapper Form
                        # XObject's /Matrix to apply our own
                        # rotate-around-centre matrix. Avoids
                        # rasterisation so vectors stay vectors.
                        _place_with_arbitrary_rotation(
                            page=page,
                            asset_doc=place_doc,
                            target_rect=target_rect,
                            angle_deg=rot_free,
                            oc_xref=design_ocg_xref,
                        )
                finally:
                    if place_owns_doc:
                        place_doc.close()
                slots_filled += 1
            finally:
                asset_doc.close()

        _disable_layer(doc, positions_layer)
        _strip_illustrator_private_data(doc)

        out = doc.tobytes(deflate=True, garbage=3)
    finally:
        doc.close()

    if cut_line_spec is not None:
        try:
            out = cut_lines.embed(
                pdf_bytes=out,
                slot_shapes=slot_shapes,
                spec=cut_line_spec,
            )
        except cut_lines.CutLineError as exc:
            # Cut-line embedding is value-add; if pikepdf chokes on the
            # composited file we still ship the artwork-only PDF so the
            # operator isn't blocked. Surface the failure so they can
            # re-try without the option ticked.
            raise CompositorError(f"Cut-line embedding failed: {exc}") from exc

    return CompositedSheet(
        pdf_bytes=out,
        page_width_pt=page_w,
        page_height_pt=page_h,
        slots_filled=slots_filled,
        slots_total=slots_total,
        color_swap_report=swap_report.to_dict() if swap_rules else None,
    )


def _render_filtered_jpeg(asset_page, filter_id: str) -> bytes:
    """Render a vector PDF page to a high-DPI JPEG with a colour filter
    applied. Used when the user picks a non-passthrough filter in the
    designer - we can't simulate Pillow's colour ops on the vector
    content stream, so we rasterise once at print resolution."""
    zoom = FILTER_RASTER_DPI / 72.0
    pix = asset_page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    img = image_filters.apply(filter_id, img)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=FILTER_RASTER_QUALITY)
    return out.getvalue()


def _normalise_free_rotation(deg: int | float | None) -> float:
    """Wrap any rotation into [0, 360) without snapping. Used everywhere
    we want to honour the user's exact angle (e.g. 22.5deg)."""
    if deg is None:
        return 0.0
    return float(deg) % 360.0


def _nearest_orthogonal(deg: float) -> int:
    """Snap a rotation to the nearest of 0/90/180/270 - only used to
    pick orientation-aware fit dimensions and to drive the fast-path
    placement when the angle is already orthogonal."""
    d = int(round(deg)) % 360
    return min((0, 90, 180, 270), key=lambda x: abs(x - d))


def _wrap_image_as_pdf(
    image_bytes: bytes, page_w_pt: float, page_h_pt: float
) -> "pymupdf.Document":
    """Wrap a JPEG/PNG into a 1-page PDF the size of the original asset.

    Used by the arbitrary-rotation path so a filtered (rasterised) asset
    can flow through the same show_pdf_page + matrix-rewrite pipeline as
    a vector PDF asset. Without this we'd be forced to use
    `Page.insert_image`, which only supports 0/90/180/270 rotation.
    """
    doc = pymupdf.open()
    page = doc.new_page(width=page_w_pt, height=page_h_pt)
    page.insert_image(page.rect, stream=image_bytes, keep_proportion=False)
    return doc


def _place_with_arbitrary_rotation(
    *,
    page: "pymupdf.Page",
    asset_doc: "pymupdf.Document",
    target_rect: "pymupdf.Rect",
    angle_deg: float,
    oc_xref: int = 0,
) -> None:
    """Place `asset_doc[0]` so that, *unrotated*, it would fill
    `target_rect` (top-left coords on `page`); then rotate that
    placement by `angle_deg` clockwise around the rect's centre.

    The trick: `Page.show_pdf_page(rotate=...)` only accepts 0/90/180/270.
    But pymupdf wraps every show_pdf_page call in a Form XObject whose
    `/Matrix` carries the entire placement transform (scale + rotate +
    translate). If we register the asset with rotate=0 and then rewrite
    that matrix to OUR rotate-around-centre matrix, every PDF consumer
    (Acrobat, Illustrator, Chrome, the print RIP) honours arbitrary
    angles natively, vector quality intact, no rasterisation.
    """
    asset_page = asset_doc[0]
    aw = float(asset_page.rect.width)
    ah = float(asset_page.rect.height)

    doc = page.parent
    page_h = float(page.rect.height)

    # Snapshot the page's XObject xrefs BEFORE the call so we can
    # identify the wrapper form pymupdf is about to add. Comparing
    # before/after sets is more robust than scanning by name (pymupdf
    # auto-numbers /fzFrm0, /fzFrm1, etc., and the resource dict can
    # be either inline or an indirect object).
    before = _page_xobject_xrefs(doc, page.xref)

    page.show_pdf_page(
        target_rect,
        asset_doc,
        pno=0,
        rotate=0,
        keep_proportion=False,
        oc=oc_xref,
    )

    after = _page_xobject_xrefs(doc, page.xref)
    new_xrefs = [x for x in after if x not in before]
    if not new_xrefs:
        return
    # The wrapper form's /Matrix is what pymupdf computed to fit the
    # asset into target_rect with no rotation. We replace it wholesale.
    wrapper_xref = new_xrefs[-1]

    # Compose the matrix:  T(cx, cy_native) · R(theta) · S(sx, sy) · T(-aw/2, -ah/2)
    # where (cx, cy_native) is the target rect's centre in PDF
    # user-space (bottom-left origin) and theta is the rotation in
    # standard math convention (positive = counter-clockwise around the
    # +x axis, in PDF y-up user space).
    #
    # The designer (and SlotOverlay canvas preview) drive `angle_deg`
    # through CSS `transform: rotate(${angle_deg}deg)`, which is
    # CLOCKWISE on screen for positive values. In PDF user space, where
    # y points UP (math convention), a clockwise on-screen rotation
    # corresponds to a NEGATIVE math angle. We therefore negate the
    # incoming CSS angle so the print output matches the on-screen
    # designer/preview exactly. Without this negation the printed
    # asset is mirrored about the horizontal: a slight CW tilt in the
    # designer comes out as a slight CCW tilt in the generated PDF.
    cx_top = (target_rect.x0 + target_rect.x1) / 2.0
    cy_top = (target_rect.y0 + target_rect.y1) / 2.0
    cx = cx_top
    cy_native = page_h - cy_top

    sx = float(target_rect.width) / aw
    sy = float(target_rect.height) / ah
    theta = math.radians(-angle_deg)
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)

    a = cos_t * sx
    b = sin_t * sx
    c = -sin_t * sy
    d = cos_t * sy
    e = cx - a * (aw / 2.0) - c * (ah / 2.0)
    f = cy_native - b * (aw / 2.0) - d * (ah / 2.0)

    src = doc.xref_object(wrapper_xref, compressed=False)
    if not src:
        return
    new_matrix = f"[ {a:.6f} {b:.6f} {c:.6f} {d:.6f} {e:.6f} {f:.6f} ]"
    new_src, n = re.subn(
        r"/Matrix\s*\[[^\]]*\]",
        f"/Matrix {new_matrix}",
        src,
        count=1,
    )
    if n == 0:
        # No /Matrix entry means pymupdf treated it as identity; we
        # have to inject one. The wrapper dict is `<< ... >>` so we
        # add the entry just before the closing `>>`.
        new_src = src.replace(">>", f"  /Matrix {new_matrix}\n>>", 1)
    doc.update_object(wrapper_xref, new_src)


def _page_xobject_xrefs(doc: "pymupdf.Document", page_xref: int) -> set[int]:
    """Return the set of XObject xrefs referenced by `page`'s resources.

    Walks `Page -> Resources -> XObject` regardless of whether each level
    is an inline `<< ... >>` dict or an indirect `N 0 R` reference (both
    are valid PDF and pymupdf uses either at different times).
    """
    out: set[int] = set()
    page_obj = doc.xref_object(page_xref, compressed=False)
    if not page_obj:
        return out
    res_dict = _resolve_dict_entry(doc, page_obj, "/Resources")
    if not res_dict:
        return out
    xobj_dict = _resolve_dict_entry(doc, res_dict, "/XObject")
    if not xobj_dict:
        return out
    for ref in re.findall(r"(\d+)\s+0\s+R", xobj_dict):
        out.add(int(ref))
    return out


def _resolve_dict_entry(doc: "pymupdf.Document", obj_src: str, key: str) -> str | None:
    """Return the body of dict `key` whether it's inline `<< ... >>` or an
    indirect `N 0 R` reference. Returns the dict's text content, not the
    enclosing braces."""
    # Inline: `/Key << ... >>`
    m = re.search(rf"{re.escape(key)}\s*<<", obj_src)
    if m:
        # Brace-balance scan from the `<<`
        start = m.end() - 2
        depth = 0
        i = start
        while i < len(obj_src):
            if obj_src[i:i + 2] == "<<":
                depth += 1
                i += 2
            elif obj_src[i:i + 2] == ">>":
                depth -= 1
                if depth == 0:
                    return obj_src[start + 2:i]
                i += 2
            else:
                i += 1
        return None
    # Indirect: `/Key N 0 R`
    m = re.search(rf"{re.escape(key)}\s+(\d+)\s+0\s+R", obj_src)
    if m:
        ref_xref = int(m.group(1))
        sub = doc.xref_object(ref_xref, compressed=False)
        return sub or None
    return None


def _fit_cover(box_w: float, box_h: float, content_w: float, content_h: float) -> "_Fit":
    scale = max(box_w / content_w, box_h / content_h)
    fit_w = content_w * scale
    fit_h = content_h * scale
    return _Fit(
        offset_x=(box_w - fit_w) / 2.0,
        offset_y=(box_h - fit_h) / 2.0,
        width=fit_w,
        height=fit_h,
    )


@dataclass
class _Fit:
    offset_x: float
    offset_y: float
    width: float
    height: float


def _fit_centered(box_w: float, box_h: float, content_w: float, content_h: float) -> _Fit:
    scale = min(box_w / content_w, box_h / content_h)
    fit_w = content_w * scale
    fit_h = content_h * scale
    return _Fit(
        offset_x=(box_w - fit_w) / 2.0,
        offset_y=(box_h - fit_h) / 2.0,
        width=fit_w,
        height=fit_h,
    )


_PIECEINFO_RE = re.compile(rb"/PieceInfo\s*<<.*?>>\s*", re.DOTALL)
_AIPRIVATE_RE = re.compile(rb"/AIPrivateData\d*\s+\d+\s+\d+\s+R\s*", re.DOTALL)


def _strip_illustrator_private_data(doc: "pymupdf.Document") -> None:
    """Strip Adobe Illustrator's `/PieceInfo` cache from every page so
    Illustrator opens the *actual* PDF content instead of restoring its
    own private snapshot of the original artboard.

    The bug: when Illustrator writes a PDF, it stores a private cache
    (PieceInfo / AIPrivateData) that lets it round-trip the file losslessly.
    If the file is then modified by a non-Illustrator tool (us, adding
    XObject Forms for the placed assets), Illustrator on re-open *trusts
    the cache* and silently ignores anything we added - the user sees the
    empty template instead of the composited print sheet, even though
    every other PDF viewer (Acrobat, Preview, Chrome, the print RIP)
    renders the file correctly.

    Implementation: rewrite each page object's serialised source with the
    `/PieceInfo` (and any stray `/AIPrivate...` entries) removed via xref
    `update_object`. We also drop `/LastModified` because Illustrator's
    cache is keyed off it. PyMuPDF's `xref_object`/`update_object` is the
    only stable cross-version way to mutate dictionary entries we don't
    have a typed accessor for.
    """
    try:
        page_count = doc.page_count
    except Exception:
        return
    for i in range(page_count):
        try:
            page_xref = doc[i].xref
            src = doc.xref_object(page_xref, compressed=False)
            if not src:
                continue
            new_src = _PIECEINFO_RE.sub(b"", src.encode("latin-1"))
            new_src = _AIPRIVATE_RE.sub(b"", new_src)
            new_src = new_src.replace(
                b"/LastModified", b"/X-LastModified-Stripped"
            )
            if new_src == src.encode("latin-1"):
                continue
            doc.update_object(page_xref, new_src.decode("latin-1"))
        except Exception:
            # Stripping is a best-effort hygiene step. If it ever fails on
            # an exotic PDF we'd rather ship the file - the artwork still
            # prints correctly everywhere except Illustrator.
            continue


def _disable_layer(doc: "pymupdf.Document", layer_name: str) -> None:
    """Persist `layer_name` as OFF in the document's default OC configuration.

    Downstream consumers (Illustrator, Acrobat, VersaWorks RIP, browsers) honour
    the default config when no UI override is set, so this is what hides the
    POSITIONS rectangles in the print output.
    """
    try:
        ocgs = doc.get_ocgs() or {}
    except Exception:
        return

    target_xrefs: list[int] = [
        xref
        for xref, info in ocgs.items()
        if str(info.get("name", "")).lower() == layer_name.lower()
    ]
    if not target_xrefs:
        return

    try:
        doc.set_layer(-1, off=target_xrefs)
    except Exception as exc:
        raise CompositorError(
            f"Failed to disable POSITIONS layer in output PDF: {exc}. "
            "Slot rectangles would be visible in the printed sheet."
        ) from exc
