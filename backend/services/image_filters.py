"""Image filter presets applied at PDF composition time.

The frontend designer also previews filters via CSS (so the user gets
instant feedback), but the printed output goes through Pillow here so
the same look is baked into the final PDF.

When `filter_id == "none"` the compositor takes its normal vector-
preserving path (`show_pdf_page`). Any other filter forces a
rasterised path (render asset page to a high-DPI bitmap, run it
through Pillow, embed the result as an image) - rasterising is the
only way to get accurate colour-grading from a vector source.
"""

from __future__ import annotations

from typing import Callable

from PIL import Image, ImageEnhance, ImageOps

# 12 popular looks. Names line up with the frontend filter button IDs.
FilterId = str


def _bw(im: Image.Image) -> Image.Image:
    return ImageOps.grayscale(im).convert("RGB")


def _sepia(im: Image.Image) -> Image.Image:
    g = ImageOps.grayscale(im)
    sepia = ImageOps.colorize(g, black=(48, 28, 16), white=(255, 235, 205))
    return sepia.convert("RGB")


def _vintage(im: Image.Image) -> Image.Image:
    out = ImageEnhance.Color(im.convert("RGB")).enhance(0.7)
    out = ImageEnhance.Contrast(out).enhance(0.85)
    out = _tint(out, (255, 220, 170), 0.18)
    return out


def _faded(im: Image.Image) -> Image.Image:
    out = ImageEnhance.Color(im.convert("RGB")).enhance(0.6)
    out = ImageEnhance.Contrast(out).enhance(0.78)
    out = ImageEnhance.Brightness(out).enhance(1.08)
    return out


def _vivid(im: Image.Image) -> Image.Image:
    out = ImageEnhance.Color(im.convert("RGB")).enhance(1.5)
    out = ImageEnhance.Contrast(out).enhance(1.15)
    return out


def _noir(im: Image.Image) -> Image.Image:
    g = ImageOps.grayscale(im).convert("RGB")
    return ImageEnhance.Contrast(g).enhance(1.4)


def _cool(im: Image.Image) -> Image.Image:
    return _tint(im.convert("RGB"), (140, 180, 255), 0.18)


def _warm(im: Image.Image) -> Image.Image:
    return _tint(im.convert("RGB"), (255, 180, 120), 0.18)


def _clarendon(im: Image.Image) -> Image.Image:
    out = ImageEnhance.Contrast(im.convert("RGB")).enhance(1.2)
    out = ImageEnhance.Color(out).enhance(1.35)
    out = _tint(out, (140, 200, 230), 0.10)
    return out


def _aden(im: Image.Image) -> Image.Image:
    out = ImageEnhance.Color(im.convert("RGB")).enhance(0.85)
    out = ImageEnhance.Brightness(out).enhance(1.10)
    out = _tint(out, (240, 200, 220), 0.12)
    return out


def _invert(im: Image.Image) -> Image.Image:
    return ImageOps.invert(im.convert("RGB"))


def _moon(im: Image.Image) -> Image.Image:
    g = ImageOps.grayscale(im).convert("RGB")
    out = ImageEnhance.Brightness(g).enhance(1.10)
    return ImageEnhance.Contrast(out).enhance(1.15)


def _tint(im: Image.Image, colour: tuple[int, int, int], strength: float) -> Image.Image:
    """Soft additive colour tint. `strength` is 0..1."""
    if strength <= 0:
        return im
    overlay = Image.new("RGB", im.size, colour)
    return Image.blend(im, overlay, strength)


_FILTERS: dict[FilterId, Callable[[Image.Image], Image.Image]] = {
    "none": lambda im: im,
    "bw": _bw,
    "sepia": _sepia,
    "vintage": _vintage,
    "faded": _faded,
    "vivid": _vivid,
    "noir": _noir,
    "cool": _cool,
    "warm": _warm,
    "clarendon": _clarendon,
    "aden": _aden,
    "moon": _moon,
    "invert": _invert,
}


def is_passthrough(filter_id: str | None) -> bool:
    """True when the filter has no visible effect and the compositor can
    skip the raster round-trip entirely."""
    return not filter_id or filter_id == "none" or filter_id not in _FILTERS


def apply(filter_id: str, im: Image.Image) -> Image.Image:
    fn = _FILTERS.get(filter_id) or _FILTERS["none"]
    return fn(im)


def known_filters() -> list[FilterId]:
    return list(_FILTERS.keys())
