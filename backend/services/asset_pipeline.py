"""Asset upload pipeline.

For every uploaded asset we normalise to PDF (so the compositor only ever has
to deal with one format) and emit a small JPEG thumbnail. The original bytes
are kept under `r2_key_original` for catalogue export and human-debugging.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from typing import Literal

import pymupdf  # type: ignore[import-untyped]
from PIL import Image

THUMBNAIL_MAX_PX = 1024
"""Higher than the strict-thumbnail 256px we used originally so the asset
preview stays sharp when rendered large in the slot designer / filler.
Trade-off: ~4x bytes per thumbnail, but JPEG @ q80 keeps these well under
80 KB even for a full sheet-sized PDF."""

_SVG_OPEN_RE = re.compile(rb"<svg\b([^>]*)>", re.DOTALL)
_VIEWBOX_RE = re.compile(
    rb'viewBox\s*=\s*"\s*([\d.+-eE]+)\s+([\d.+-eE]+)\s+([\d.+-eE]+)\s+([\d.+-eE]+)\s*"'
)
_HAS_WIDTH_RE = re.compile(rb"\bwidth\s*=")
_HAS_HEIGHT_RE = re.compile(rb"\bheight\s*=")
_ILLUSTRATOR_HINT_RE = re.compile(rb"Adobe[\s_]+Illustrator", re.IGNORECASE)


def _ensure_physical_size(svg_bytes: bytes) -> bytes:
    """Adobe Illustrator exports SVGs whose viewBox is in PostScript points
    (72 DPI) but with no explicit width/height attributes. Browsers and
    cairosvg both fall back to the SVG spec's 96 DPI interpretation
    (1 user unit = 1 CSS pixel), shrinking the artwork to ~75 %% of the
    intended physical size.

    If we detect an Illustrator export missing explicit width/height, we
    inject `width="<vb_w>pt" height="<vb_h>pt"` from the viewBox so the
    rendered output matches the original artboard exactly (e.g. a
    58.3 x 78.5 mm playing card stays 58.3 x 78.5 mm)."""
    open_tag = _SVG_OPEN_RE.search(svg_bytes)
    if not open_tag:
        return svg_bytes
    attrs = open_tag.group(1)
    if _HAS_WIDTH_RE.search(attrs) and _HAS_HEIGHT_RE.search(attrs):
        return svg_bytes
    vb = _VIEWBOX_RE.search(attrs)
    if not vb:
        return svg_bytes
    if not _ILLUSTRATOR_HINT_RE.search(svg_bytes[:2048]):
        return svg_bytes
    try:
        vb_w = float(vb.group(3))
        vb_h = float(vb.group(4))
    except ValueError:
        return svg_bytes
    if vb_w <= 0 or vb_h <= 0:
        return svg_bytes
    new_attrs = attrs + f' width="{vb_w}pt" height="{vb_h}pt"'.encode()
    start, end = open_tag.span()
    return svg_bytes[:start] + b"<svg" + new_attrs + b">" + svg_bytes[end:]


# Adobe Illustrator (and some other editors) emit SVGs with a DOCTYPE
# block containing internal entity declarations (`<!ENTITY ns_extend ...>`
# etc). cairosvg defers to `defusedxml`, which - for security - refuses
# to parse XML with internal entity definitions and raises
# `EntitiesForbidden` (a ValueError subclass). Those entities are only
# Adobe round-trip metadata and aren't used during rendering, so we
# strip the DOCTYPE before parsing.
_DOCTYPE_RE = re.compile(
    rb"<!DOCTYPE[^>\[]*\[.*?\][^>]*>|<!DOCTYPE[^>]*>",
    re.DOTALL,
)
# Same SVGs reference those entities later (e.g. xmlns:i="&ns_ai;"). Once
# we've removed the entity declarations, every `&name;` reference becomes
# an XML error too. Replace any remaining `&...;` reference *that isn't a
# standard entity* with an empty string. Standard ones we keep.
_STANDARD_ENTITIES = {b"amp", b"lt", b"gt", b"quot", b"apos"}
_NUMERIC_ENTITY_RE = re.compile(rb"&#[0-9]+;|&#x[0-9a-fA-F]+;")
_NAMED_ENTITY_RE = re.compile(rb"&([a-zA-Z_][\w.-]*);")


@dataclass
class NormalisedAsset:
    kind: Literal["pdf", "svg", "png", "jpg"]
    pdf_bytes: bytes
    width_pt: float
    height_pt: float
    thumbnail_jpg: bytes | None
    original_kept: bool
    original_bytes: bytes | None = None
    """Bytes to store as the browser-served `original`. None means use the
    caller's raw upload bytes. We override this for SVG so the served
    original has explicit physical width/height (otherwise browsers fall
    back to a 300x150 default and the asset displays at the wrong size in
    the designer)."""


def _detect_kind(filename: str, content_type: str | None) -> Literal["pdf", "svg", "png", "jpg"]:
    name = filename.lower()
    if name.endswith(".pdf") or content_type == "application/pdf":
        return "pdf"
    if name.endswith(".svg") or (content_type or "").startswith("image/svg"):
        return "svg"
    if name.endswith(".png") or content_type == "image/png":
        return "png"
    if name.endswith(".jpg") or name.endswith(".jpeg") or (content_type or "").startswith("image/jp"):
        return "jpg"
    raise ValueError(f"Unsupported asset type: {filename} ({content_type})")


def _raster_to_pdf(img: Image.Image) -> tuple[bytes, float, float]:
    try:
        from PIL import ImageOps
        img = ImageOps.exif_transpose(img) or img
    except Exception:
        pass
    if img.mode in ("RGBA", "P"):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        if img.mode == "RGBA":
            bg.paste(img, mask=img.split()[-1])
        else:
            bg.paste(img.convert("RGBA"), mask=img.convert("RGBA").split()[-1])
        img = bg
    elif img.mode != "RGB":
        img = img.convert("RGB")

    dpi = 300.0
    px_w, px_h = img.size
    pt_w = (px_w / dpi) * 72.0
    pt_h = (px_h / dpi) * 72.0

    doc = pymupdf.open()
    try:
        page = doc.new_page(width=pt_w, height=pt_h)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=92)
        page.insert_image(
            pymupdf.Rect(0, 0, pt_w, pt_h),
            stream=buf.getvalue(),
            keep_proportion=False,
        )
        return doc.tobytes(deflate=True), pt_w, pt_h
    finally:
        doc.close()


def _sanitise_svg(svg_bytes: bytes) -> bytes:
    """Strip Adobe-style DOCTYPE/entity blocks so defusedxml will parse it.

    Adobe Illustrator wraps entity references in xmlns/attribute values
    like `xmlns:i="&ns_ai;"`. We replace each non-standard entity
    reference with a unique URN placeholder so the resulting XML is
    well-formed (an empty namespace value would be a "must not undeclare
    prefix" error). The substituted namespaces aren't used during
    rendering."""
    cleaned = _DOCTYPE_RE.sub(b"", svg_bytes)

    def _keep_or_replace(match: re.Match[bytes]) -> bytes:
        name = match.group(1)
        if name in _STANDARD_ENTITIES:
            return match.group(0)
        return b"urn:adobe-stripped:" + name

    cleaned = _NAMED_ENTITY_RE.sub(_keep_or_replace, cleaned)
    return cleaned


def _svg_to_pdf(svg_bytes: bytes) -> tuple[bytes, float, float]:
    try:
        import cairosvg  # type: ignore[import-untyped]
    except ImportError as exc:
        raise RuntimeError(
            "SVG support requires `cairosvg`. Add it to requirements.txt and "
            "install libcairo2 in the Docker image."
        ) from exc

    prepared = _ensure_physical_size(svg_bytes)

    try:
        pdf_bytes = cairosvg.svg2pdf(bytestring=prepared)
    except Exception:
        # Most common failure is an Adobe Illustrator export with internal
        # entity declarations - try again on a sanitised copy. If that
        # still fails, propagate the original error so the caller surfaces
        # the real reason.
        try:
            pdf_bytes = cairosvg.svg2pdf(bytestring=_sanitise_svg(prepared))
        except Exception as exc2:
            raise ValueError(f"Could not parse SVG: {exc2}") from exc2

    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        page = doc[0]
        return pdf_bytes, float(page.rect.width), float(page.rect.height)
    finally:
        doc.close()


def _pdf_dimensions(pdf_bytes: bytes) -> tuple[float, float]:
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        page = doc[0]
        return float(page.rect.width), float(page.rect.height)
    finally:
        doc.close()


def _thumbnail_from_pdf(pdf_bytes: bytes) -> bytes:
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        page = doc[0]
        scale = THUMBNAIL_MAX_PX / max(page.rect.width, page.rect.height)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
        png = pix.tobytes("png")
    finally:
        doc.close()
    img = Image.open(io.BytesIO(png)).convert("RGB")
    img.thumbnail((THUMBNAIL_MAX_PX, THUMBNAIL_MAX_PX))
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=80)
    return out.getvalue()


def normalise(
    file_bytes: bytes,
    filename: str,
    content_type: str | None = None,
) -> NormalisedAsset:
    kind = _detect_kind(filename, content_type)

    original_bytes: bytes | None = None
    if kind == "pdf":
        pdf_bytes = file_bytes
        width, height = _pdf_dimensions(pdf_bytes)
        original_kept = False
    elif kind == "svg":
        pdf_bytes, width, height = _svg_to_pdf(file_bytes)
        original_kept = True
        original_bytes = _ensure_physical_size(file_bytes)
    else:
        img = Image.open(io.BytesIO(file_bytes))
        pdf_bytes, width, height = _raster_to_pdf(img)
        original_kept = True

    thumb = _thumbnail_from_pdf(pdf_bytes)
    return NormalisedAsset(
        kind=kind,
        pdf_bytes=pdf_bytes,
        width_pt=width,
        height_pt=height,
        thumbnail_jpg=thumb,
        original_kept=original_kept,
        original_bytes=original_bytes,
    )
