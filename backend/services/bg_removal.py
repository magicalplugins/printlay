"""Background removal service.

Provides two strategies:
1. Algorithmic solid-colour removal (free, instant, no API call)
2. AI-powered removal via Replicate BiRefNet (state-of-the-art, ~3s, ~$0.003/image)
"""

import io
import os
from typing import Literal

import httpx
from PIL import Image, ImageOps

RemovalMethod = Literal["solid_color", "ai_basic"]


def normalise_orientation(image_bytes: bytes) -> bytes:
    """Bake EXIF rotation into the pixel data and return fresh bytes.

    iPhone photos (especially via the in-browser "Take Photo" capture)
    are JPEGs whose pixels are stored landscape with an EXIF orientation
    tag instructing viewers to rotate. The Replicate background removal
    model returns PNGs — which have no EXIF — so an unrotated landscape
    sticker comes back when the user expected a portrait one. The cut
    line is then computed against the wrong-orientation pixels and the
    preview displays sideways.

    By applying `exif_transpose` once up front, every downstream step
    (detection, bg removal, cutline, preview, PDF) operates on pixel
    data that already matches the user's visual orientation.

    Returns the input unchanged if it isn't a decodable image or has no
    rotation tag — never throws."""
    try:
        img = Image.open(io.BytesIO(image_bytes))
        # Lock the format before transpose creates a new Image with no
        # `format` attribute.
        original_format = (img.format or "JPEG").upper()
        rotated = ImageOps.exif_transpose(img)
        if rotated is None or rotated is img:
            return image_bytes
        # Strip EXIF entirely on re-encode so no future reader applies
        # the rotation a second time.
        out = io.BytesIO()
        # PNGs preserve alpha; JPEG/others lose it but the source was
        # already opaque (cameras don't emit alpha JPEGs).
        save_format = "PNG" if original_format == "PNG" else "JPEG"
        save_kwargs: dict = {}
        if save_format == "JPEG":
            if rotated.mode in ("RGBA", "P"):
                rotated = rotated.convert("RGB")
            save_kwargs["quality"] = 92
            save_kwargs["optimize"] = True
        rotated.save(out, format=save_format, **save_kwargs)
        return out.getvalue()
    except Exception:
        return image_bytes


def _has_alpha(img: Image.Image) -> bool:
    return img.mode == "RGBA" and img.getextrema()[3][0] < 250


def detect_background(image_bytes: bytes) -> str:
    """Detect background type: 'transparent', 'solid', or 'complex'."""
    img = Image.open(io.BytesIO(image_bytes))

    if _has_alpha(img):
        return "transparent"

    img_rgb = img.convert("RGB")
    pixels = img_rgb.load()
    w, h = img_rgb.size

    edge_pixels = []
    for x in range(w):
        edge_pixels.append(pixels[x, 0])
        edge_pixels.append(pixels[x, h - 1])
    for y in range(h):
        edge_pixels.append(pixels[0, y])
        edge_pixels.append(pixels[w - 1, y])

    if not edge_pixels:
        return "complex"

    r_avg = sum(p[0] for p in edge_pixels) // len(edge_pixels)
    g_avg = sum(p[1] for p in edge_pixels) // len(edge_pixels)
    b_avg = sum(p[2] for p in edge_pixels) // len(edge_pixels)

    threshold = 30
    uniform_count = sum(
        1 for p in edge_pixels
        if abs(p[0] - r_avg) < threshold
        and abs(p[1] - g_avg) < threshold
        and abs(p[2] - b_avg) < threshold
    )

    if uniform_count / len(edge_pixels) > 0.85:
        return "solid"

    return "complex"


def remove_solid_color(image_bytes: bytes, tolerance: int = 40) -> bytes:
    """Remove a solid-colour background using flood fill from corners.

    Returns PNG bytes with transparent background.
    """
    img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    w, h = img.size
    pixels = img.load()

    corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    bg_colors = [pixels[c[0], c[1]][:3] for c in corners]

    from collections import Counter
    color_counts = Counter(bg_colors)
    bg_color = color_counts.most_common(1)[0][0]

    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if (
                abs(r - bg_color[0]) < tolerance
                and abs(g - bg_color[1]) < tolerance
                and abs(b - bg_color[2]) < tolerance
            ):
                pixels[x, y] = (r, g, b, 0)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def remove_ai(image_bytes: bytes) -> bytes:
    """Remove background using BiRefNet via Replicate API.

    Returns PNG bytes with transparent background.
    Requires REPLICATE_API_TOKEN env var.
    """
    import replicate

    token = os.getenv("REPLICATE_API_TOKEN")
    if not token:
        raise RuntimeError(
            "REPLICATE_API_TOKEN not set. "
            "Get one at https://replicate.com/account/api-tokens"
        )

    input_file = io.BytesIO(image_bytes)
    input_file.name = "input.png"

    output = replicate.run(
        "bria/remove-background",
        input={"image": input_file},
    )

    if isinstance(output, str):
        resp = httpx.get(output, timeout=60)
        resp.raise_for_status()
        return resp.content

    if hasattr(output, "read"):
        return output.read()

    raise RuntimeError(f"Unexpected Replicate output type: {type(output)}")


def remove_background(
    image_bytes: bytes,
    method: RemovalMethod = "ai_basic",
) -> bytes:
    """Remove background using the specified method.

    Returns PNG bytes with transparent background.
    """
    if method == "solid_color":
        return remove_solid_color(image_bytes)
    elif method == "ai_basic":
        return remove_ai(image_bytes)
    else:
        raise ValueError(f"Unknown removal method: {method}")
