"""Asset upload pipeline.

For every uploaded asset we normalise to PDF (so the compositor only ever has
to deal with one format) and emit a small JPEG thumbnail. The original bytes
are kept under `r2_key_original` for catalogue export and human-debugging.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Literal

import pymupdf  # type: ignore[import-untyped]
from PIL import Image

THUMBNAIL_MAX_PX = 256


@dataclass
class NormalisedAsset:
    kind: Literal["pdf", "svg", "png", "jpg"]
    pdf_bytes: bytes
    width_pt: float
    height_pt: float
    thumbnail_jpg: bytes | None
    original_kept: bool


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


def _svg_to_pdf(svg_bytes: bytes) -> tuple[bytes, float, float]:
    try:
        import cairosvg  # type: ignore[import-untyped]
    except ImportError as exc:
        raise RuntimeError(
            "SVG support requires `cairosvg`. Add it to requirements.txt and "
            "install libcairo2 in the Docker image."
        ) from exc
    pdf_bytes = cairosvg.svg2pdf(bytestring=svg_bytes)
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

    if kind == "pdf":
        pdf_bytes = file_bytes
        width, height = _pdf_dimensions(pdf_bytes)
        original_kept = False
    elif kind == "svg":
        pdf_bytes, width, height = _svg_to_pdf(file_bytes)
        original_kept = True
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
    )
