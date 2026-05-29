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

from PIL import Image, ImageEnhance, ImageFilter, ImageOps

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


def _cartoon(im: Image.Image) -> Image.Image:
    """Cartoon / comic look: flatten colours + bold dark outlines.

    Uses OpenCV when available (bilateral colour flattening + adaptive-threshold
    edges). Falls back to a high-saturation/contrast PIL approximation."""
    try:
        import cv2  # type: ignore[import-untyped]
        import numpy as np

        rgb = np.array(im.convert("RGB"))
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)

        # Flatten colour regions while keeping edges crisp.
        color = bgr
        for _ in range(2):
            color = cv2.bilateralFilter(color, 9, 75, 75)
        # Posterise to a handful of tones per channel for the "cel" look.
        color = (color // 32) * 32 + 16

        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        gray = cv2.medianBlur(gray, 5)
        edges = cv2.adaptiveThreshold(
            gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 9, 9
        )
        edges_bgr = cv2.cvtColor(edges, cv2.COLOR_GRAY2BGR)
        out = cv2.bitwise_and(color, edges_bgr)
        out_rgb = cv2.cvtColor(np.clip(out, 0, 255).astype(np.uint8), cv2.COLOR_BGR2RGB)
        return Image.fromarray(out_rgb)
    except Exception:
        out = ImageEnhance.Color(im.convert("RGB")).enhance(1.6)
        return ImageEnhance.Contrast(out).enhance(1.5)


def _pencil(im: Image.Image) -> Image.Image:
    """Pencil / line-drawing sketch (grayscale dodge technique).

    Sketch = gray dodged by a blurred inverse of itself — the classic
    "colour dodge" pencil effect. PIL-only so it always works."""
    try:
        gray = ImageOps.grayscale(im)
        inv = ImageOps.invert(gray)
        blur = inv.filter(ImageFilter.GaussianBlur(radius=max(2, gray.size[0] // 120)))

        from PIL import ImageChops

        # Colour-dodge: result = base / (255 - blur)
        import numpy as np

        g = np.asarray(gray, dtype=np.float32)
        b = np.asarray(blur, dtype=np.float32)
        denom = 255.0 - b
        denom[denom <= 0] = 1.0
        dodge = np.clip(g * 255.0 / denom, 0, 255).astype("uint8")
        sketch = Image.fromarray(dodge, mode="L")
        # Slight contrast lift so the lines read clearly.
        sketch = ImageEnhance.Contrast(sketch).enhance(1.15)
        _ = ImageChops  # imported for parity / future blends
        return sketch.convert("RGB")
    except Exception:
        return ImageOps.grayscale(im).convert("RGB")


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
    "cartoon": _cartoon,
    "pencil": _pencil,
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
