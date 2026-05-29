"""Portrait beautify filters for the sticker builder.

Provides the popular "beautify" controls (smooth skin, brighten eyes, even
skin tone) plus a single entry point that combines them with the existing
named colour presets in `image_filters.py` (the same looks used in jobs).

All operations are best-effort: if OpenCV is unavailable or a step fails we
return the image unchanged so sticker generation never breaks.
"""

from __future__ import annotations

import io

import numpy as np
from PIL import Image


def _detect_faces(gray: "np.ndarray"):
    """Return a list of (x, y, w, h) face boxes, or [] if none/unavailable."""
    try:
        import cv2  # type: ignore[import-untyped]
    except ImportError:
        return []
    try:
        xml = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        cascade = cv2.CascadeClassifier(xml)
        if cascade.empty():
            return []
        min_dim = min(gray.shape[:2])
        min_face = max(50, min_dim // 8)
        faces = cascade.detectMultiScale(
            gray, scaleFactor=1.1, minNeighbors=5, minSize=(min_face, min_face)
        )
        return list(faces)
    except Exception:
        return []


def _skin_mask(bgr: "np.ndarray") -> "np.ndarray":
    """Feathered 0..255 mask of skin-coloured pixels (YCrCb range)."""
    import cv2  # type: ignore[import-untyped]

    ycrcb = cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb)
    lower = np.array([0, 133, 77], dtype=np.uint8)
    upper = np.array([255, 173, 127], dtype=np.uint8)
    mask = cv2.inRange(ycrcb, lower, upper)
    mask = cv2.medianBlur(mask, 5)
    mask = cv2.GaussianBlur(mask, (0, 0), 4)
    return mask


def _smooth_skin(bgr: "np.ndarray", strength: float) -> "np.ndarray":
    """Edge-preserving skin smoothing blended over a skin mask."""
    import cv2  # type: ignore[import-untyped]

    if strength <= 0:
        return bgr
    # Diameter scales a little with image size so the effect is visible on
    # higher-res working images, and a second lighter pass deepens the smooth.
    sigma = 60 + 90 * strength
    diam = 9 if min(bgr.shape[:2]) < 900 else 13
    smoothed = cv2.bilateralFilter(bgr, diam, sigma, sigma)
    if strength > 0.5:
        smoothed = cv2.bilateralFilter(smoothed, diam, sigma, sigma)
    mask = _skin_mask(bgr).astype(np.float32) / 255.0 * min(0.95, 0.95 * strength)
    mask3 = cv2.merge([mask, mask, mask])
    out = bgr.astype(np.float32) * (1.0 - mask3) + smoothed.astype(np.float32) * mask3
    return np.clip(out, 0, 255).astype(np.uint8)


def _even_skin_tone(bgr: "np.ndarray", strength: float) -> "np.ndarray":
    """Reduce blotchiness by blurring colour (LAB a/b) on skin, keeping
    luminance detail so the photo stays sharp."""
    import cv2  # type: ignore[import-untyped]

    if strength <= 0:
        return bgr
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    L, a, b = cv2.split(lab)
    a_b = cv2.GaussianBlur(a, (0, 0), 7)
    b_b = cv2.GaussianBlur(b, (0, 0), 7)
    mask = _skin_mask(bgr).astype(np.float32) / 255.0 * (0.7 * strength)
    a2 = a * (1.0 - mask) + a_b * mask
    b2 = b * (1.0 - mask) + b_b * mask
    merged = cv2.merge([L, a2, b2])
    return cv2.cvtColor(np.clip(merged, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)


def _enhance_eyes(
    bgr: "np.ndarray", gray: "np.ndarray", faces, strength: float
) -> "np.ndarray":
    """Sharpen + gently brighten detected eyes inside each face box."""
    import cv2  # type: ignore[import-untyped]

    if strength <= 0 or not len(faces):
        return bgr
    try:
        eye_xml = cv2.data.haarcascades + "haarcascade_eye.xml"
        eye_cascade = cv2.CascadeClassifier(eye_xml)
        if eye_cascade.empty():
            return bgr
    except Exception:
        return bgr

    out = bgr.copy()
    amount = 1.1 * strength
    for (fx, fy, fw, fh) in faces:
        # Eyes live in the upper ~60% of the face box.
        ry0, ry1 = fy, fy + int(fh * 0.6)
        roi_gray = gray[ry0:ry1, fx:fx + fw]
        try:
            eyes = eye_cascade.detectMultiScale(roi_gray, 1.1, 4)
        except Exception:
            eyes = []
        for (ex, ey, ew, eh) in eyes:
            x0 = fx + ex
            y0 = ry0 + ey
            x1 = min(out.shape[1], x0 + ew)
            y1 = min(out.shape[0], y0 + eh)
            if x1 <= x0 or y1 <= y0:
                continue
            roi = out[y0:y1, x0:x1].astype(np.float32)
            blur = cv2.GaussianBlur(roi, (0, 0), 3)
            sharp = cv2.addWeighted(roi, 1.0 + amount, blur, -amount, 0)
            sharp = sharp * (1.0 + 0.14 * strength)
            out[y0:y1, x0:x1] = np.clip(sharp, 0, 255).astype(np.uint8)
    return out


def apply_beautify(
    im_rgb: Image.Image,
    smooth: float = 0.0,
    eyes: float = 0.0,
    tone: float = 0.0,
) -> Image.Image:
    """Apply the beautify controls (each 0..1) to an RGB image.

    Silent no-op when OpenCV isn't available or all strengths are zero.
    """
    if smooth <= 0 and eyes <= 0 and tone <= 0:
        return im_rgb
    try:
        import cv2  # type: ignore[import-untyped]
    except ImportError:
        return im_rgb

    try:
        rgb = np.array(im_rgb.convert("RGB"))
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        faces = _detect_faces(gray)

        if smooth > 0:
            bgr = _smooth_skin(bgr, smooth)
        if tone > 0:
            bgr = _even_skin_tone(bgr, tone)
        if eyes > 0:
            bgr = _enhance_eyes(bgr, gray, faces, eyes)

        out_rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        return Image.fromarray(out_rgb)
    except Exception:
        return im_rgb


def apply_sticker_look(
    rgba_bytes: bytes,
    filter_id: str = "none",
    smooth: float = 0.0,
    eyes: float = 0.0,
    tone: float = 0.0,
) -> bytes:
    """Apply beautify + a named colour preset to an RGBA cutout, preserving
    the alpha channel. Returns PNG bytes (unchanged input if nothing to do).
    """
    has_filter = bool(filter_id) and filter_id != "none"
    if not has_filter and smooth <= 0 and eyes <= 0 and tone <= 0:
        return rgba_bytes

    img = Image.open(io.BytesIO(rgba_bytes)).convert("RGBA")
    r, g, b, alpha = img.split()
    rgb = Image.merge("RGB", (r, g, b))

    rgb = apply_beautify(rgb, smooth=smooth, eyes=eyes, tone=tone)

    if has_filter:
        from backend.services import image_filters

        rgb = image_filters.apply(filter_id, rgb).convert("RGB")

    r2, g2, b2 = rgb.split()
    out = Image.merge("RGBA", (r2, g2, b2, alpha))
    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()
