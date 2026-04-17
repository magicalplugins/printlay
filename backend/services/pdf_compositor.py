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

from dataclasses import dataclass

import pymupdf  # type: ignore[import-untyped]


@dataclass
class CompositedSheet:
    pdf_bytes: bytes
    page_width_pt: float
    page_height_pt: float
    slots_filled: int
    slots_total: int


class CompositorError(RuntimeError):
    pass


def composite(
    *,
    template_pdf: bytes,
    slot_shapes: list[dict],
    asset_pdfs: dict[int, bytes],
    positions_layer: str = "POSITIONS",
) -> CompositedSheet:
    """Build the print-ready PDF.

    Args:
        template_pdf: source template PDF bytes (single page expected for v1).
        slot_shapes: list of `{shape_index, page_index, bbox: [x,y,w,h], ...}`
            with origin top-left, in PDF points - same shape as
            `pdf_parser.parse(...).shapes`.
        asset_pdfs: map of `shape_index -> single-page PDF bytes` for slots
            that should be filled. Slots not in this map are left empty.
        positions_layer: name of the OCG layer to switch off in the output.
    """

    doc = pymupdf.open(stream=template_pdf, filetype="pdf")
    try:
        page = doc[0]
        page_w = float(page.rect.width)
        page_h = float(page.rect.height)

        slots_total = len(slot_shapes)
        slots_filled = 0

        shape_lookup = {int(s["shape_index"]): s for s in slot_shapes}

        for shape_index, asset_bytes in asset_pdfs.items():
            shape = shape_lookup.get(int(shape_index))
            if shape is None:
                continue
            x, y_top, w, h = shape["bbox"]
            if w <= 0 or h <= 0:
                continue

            asset_doc = pymupdf.open(stream=asset_bytes, filetype="pdf")
            try:
                if asset_doc.page_count == 0:
                    continue
                asset_page = asset_doc[0]
                aw = float(asset_page.rect.width)
                ah = float(asset_page.rect.height)
                if aw <= 0 or ah <= 0:
                    continue

                fit = _fit_centered(w, h, aw, ah)
                target_rect = pymupdf.Rect(
                    x + fit.offset_x,
                    y_top + fit.offset_y,
                    x + fit.offset_x + fit.width,
                    y_top + fit.offset_y + fit.height,
                )
                page.show_pdf_page(
                    target_rect,
                    asset_doc,
                    pno=0,
                    keep_proportion=True,
                )
                slots_filled += 1
            finally:
                asset_doc.close()

        _disable_layer(doc, positions_layer)

        out = doc.tobytes(deflate=True, garbage=3)
    finally:
        doc.close()

    return CompositedSheet(
        pdf_bytes=out,
        page_width_pt=page_w,
        page_height_pt=page_h,
        slots_filled=slots_filled,
        slots_total=slots_total,
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
