"""AI image stylization for stickers (bring-your-own OpenAI key).

Turns a subject photo into a high-quality illustrated style (cartoon,
pencil sketch, etc.) using OpenAI's image model. The user supplies their
own API key (stored encrypted per-user), so generation runs on their
OpenAI account and credits — we never bill it centrally.

Mirrors the thin-service pattern of `bg_removal.py`: one entry point,
read credential at call time, raise RuntimeError on failure so the
router can map it to a clean HTTP error.
"""

from __future__ import annotations

import base64
import io

import httpx
from PIL import Image

OPENAI_IMAGE_EDITS_URL = "https://api.openai.com/v1/images/edits"

# Available AI styles. Each maps to a prompt tuned for sticker output:
# keep the subject/likeness, redraw in the target style, transparent
# background so our normal contour cut line can trace the silhouette.
STYLE_PROMPTS: dict[str, str] = {
    "cartoon": (
        "Redraw this person as a clean, modern cartoon illustration: bold smooth "
        "outlines, flat cel-shaded colours, simplified friendly features, bright "
        "and cheerful. Keep the same pose, framing, hairstyle and likeness. "
        "Vector-sticker look. Fully transparent background."
    ),
    "pencil": (
        "Redraw this person as a detailed black-and-white pencil portrait sketch: "
        "fine graphite shading, clean confident line work, soft hatching, hand-drawn "
        "artist style on white paper. Keep the same pose, framing and likeness. "
        "Fully transparent background outside the drawing."
    ),
    "anime": (
        "Redraw this person in a polished anime / manga illustration style: clean "
        "line art, expressive eyes, soft cel shading, vibrant colours. Keep the same "
        "pose, framing and likeness. Sticker look. Fully transparent background."
    ),
    "popart": (
        "Redraw this person as a bold pop-art / comic-book illustration: heavy black "
        "outlines, halftone shading, punchy saturated colours. Keep the same pose, "
        "framing and likeness. Sticker look. Fully transparent background."
    ),
    "watercolor": (
        "Redraw this person as a soft watercolour painting: gentle washes, loose "
        "brush edges, light pastel palette. Keep the same pose, framing and likeness. "
        "Fully transparent background outside the painting."
    ),
}

STYLE_LABELS: dict[str, str] = {
    "cartoon": "Cartoon",
    "pencil": "Pencil",
    "anime": "Anime",
    "popart": "Pop art",
    "watercolor": "Watercolour",
}


def available_styles() -> list[dict[str, str]]:
    return [{"id": k, "label": STYLE_LABELS.get(k, k.title())} for k in STYLE_PROMPTS]


def _pick_size(width: int, height: int) -> str:
    """Choose the closest supported gpt-image-1 size to the source aspect."""
    if height <= 0:
        return "1024x1024"
    ratio = width / height
    if ratio >= 1.2:
        return "1536x1024"
    if ratio <= 0.83:
        return "1024x1536"
    return "1024x1024"


def stylize_image(image_bytes: bytes, style: str, api_key: str) -> bytes:
    """Stylize `image_bytes` (PNG/RGBA) into `style` via OpenAI. Returns the
    generated PNG bytes (RGBA, transparent background).

    Raises RuntimeError with a user-readable message on any failure.
    """
    prompt = STYLE_PROMPTS.get(style)
    if not prompt:
        raise RuntimeError(f"Unknown AI style: {style}")
    if not api_key:
        raise RuntimeError("No OpenAI API key configured.")

    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    except Exception as exc:  # pragma: no cover - defensive
        raise RuntimeError(f"Could not read the source image: {exc}") from exc

    # OpenAI edits expect the image on a flat (white) canvas works best for
    # likeness; we send it as PNG and request a transparent-bg redraw.
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)

    size = _pick_size(img.width, img.height)

    files = {"image": ("input.png", buf.getvalue(), "image/png")}
    data = {
        "model": "gpt-image-1",
        "prompt": prompt,
        "size": size,
        "background": "transparent",
        # "medium" balances quality vs latency — "high" can take 1-2 min and
        # would blow past the ~100s Cloudflare proxy timeout (524).
        "quality": "medium",
        "n": "1",
    }
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        resp = httpx.post(
            OPENAI_IMAGE_EDITS_URL,
            headers=headers,
            files=files,
            data=data,
            timeout=240.0,
        )
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Could not reach OpenAI: {exc}") from exc

    if resp.status_code == 401:
        raise RuntimeError("OpenAI rejected your API key (401). Check it in Settings.")
    if resp.status_code == 429:
        raise RuntimeError(
            "OpenAI rate limit / quota reached on your account. Try again shortly "
            "or check your OpenAI billing."
        )
    if resp.status_code >= 400:
        detail = ""
        try:
            detail = resp.json().get("error", {}).get("message", "")
        except Exception:
            detail = resp.text[:300]
        raise RuntimeError(f"OpenAI image generation failed ({resp.status_code}): {detail}")

    try:
        payload = resp.json()
        b64 = payload["data"][0]["b64_json"]
        out = base64.b64decode(b64)
    except (KeyError, IndexError, ValueError) as exc:
        raise RuntimeError(f"Unexpected OpenAI response: {exc}") from exc

    return out
