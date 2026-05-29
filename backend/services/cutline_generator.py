"""Cutline generator for sticker die-cut paths.

Structure (inside → out):
  1. Subject artwork
  2. White border (cut_offset_mm from subject edge to the cut line)
  3. Cut line (exactly cut_offset_mm from subject edge, follows contour)
  4. Bleed (bleed_mm of white extending past the cut line)

Two modes:
  1. "contour" — traces the subject outline at a consistent offset
  2. "rectangle" — rounded-rectangle cut around the full image

The cut path must NEVER have sharp corners — vinyl/laser cutters need
smooth curves at every point.
"""

import io
import math
from dataclasses import dataclass
from typing import Literal

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from shapely.geometry import Polygon
from skimage.measure import find_contours

CutlineMode = Literal["contour", "rectangle", "face"]
CutlinePrecision = Literal["tight", "medium"]


class FaceNotFoundError(ValueError):
    """Raised when a face sticker is requested but no face is detected."""


@dataclass
class CutlineResult:
    """Result of cutline generation."""
    points_px: list[tuple[float, float]]
    points_pt: list[tuple[float, float]]
    width_px: int
    height_px: int
    width_pt: float
    height_pt: float
    border_image: bytes  # PNG with border composited (includes bleed area)


def generate_cutline(
    rgba_bytes: bytes,
    border_width_mm: float = 5.0,
    border_color: tuple[int, int, int] = (255, 255, 255),
    dpi: int = 300,
    mode: CutlineMode = "contour",
    precision: CutlinePrecision = "medium",
    corner_radius_mm: float = 3.0,
    bleed_mm: float = 3.0,
) -> CutlineResult:
    """Generate a smooth cutline from an image.

    Args:
        rgba_bytes: PNG image (RGBA for contour mode, any for rectangle mode)
        border_width_mm: Distance from subject edge to cut line in mm
        border_color: RGB tuple for border/bleed fill
        dpi: Resolution for mm-to-px conversion
        mode: "contour" traces the subject outline, "rectangle" uses rounded rect
        precision: "tight" = closer to subject, "medium" = more buffer
        corner_radius_mm: Corner radius for rectangle mode
        bleed_mm: How far the white extends past the cut line
    """
    img = Image.open(io.BytesIO(rgba_bytes)).convert("RGBA")

    effective_border_mm = border_width_mm
    if mode == "contour":
        face_extra_mm = _face_clearance_bonus_mm(img)
        if face_extra_mm > 0:
            effective_border_mm += face_extra_mm

    cut_offset_px = int(effective_border_mm * dpi / 25.4)
    bleed_px = int(bleed_mm * dpi / 25.4)

    if mode == "rectangle":
        return _generate_rectangle_cutline(
            img, cut_offset_px, bleed_px, border_color, dpi, corner_radius_mm
        )
    elif mode == "face":
        # Restrict the subject alpha to the head region (chin → hair) so the
        # cut line follows just the face/head silhouette, not the whole body.
        head_mask = _head_region_mask(img)
        if head_mask is None:
            raise FaceNotFoundError(
                "No face detected. Use a clear, front-facing photo for a face sticker."
            )
        return _generate_contour_cutline(
            img, cut_offset_px, bleed_px, border_color, dpi, precision,
            subject_mask_override=head_mask,
        )
    else:
        return _generate_contour_cutline(
            img, cut_offset_px, bleed_px, border_color, dpi, precision
        )


def _head_region_mask(img: Image.Image) -> "np.ndarray | None":
    """Build a binary mask limiting the subject to the head region for a
    face sticker: an oval from the top of the hair down to just under the
    chin, excluding the neck/shoulders.

    Returns a uint8 (0/255) mask the same size as the image, or None if no
    face is detected.

    Strategy — keep the cut on par with the main background removal:
      * ABOVE the chin we keep the *full* subject alpha untouched, so the
        hair is exactly as crisp as the standard cutout (no ellipse slicing
        through it, which is what made earlier face stickers look ragged).
      * BELOW the chin we close the shape with a rounded chin/jaw cap so the
        bottom curves under the chin into a smooth oval rather than running
        down the neck onto the shoulders.
    The downstream contour pipeline then dilates + smooths this into a
    cut-friendly path just like every other sticker.
    """
    try:
        import cv2  # type: ignore[import-untyped]
    except ImportError:
        return None

    try:
        rgb = np.array(img.convert("RGB"))
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

        face_xml = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        face_cascade = cv2.CascadeClassifier(face_xml)
        if face_cascade.empty():
            return None

        h_img, w_img = gray.shape[:2]
        min_dim = min(h_img, w_img)
        min_face_px = max(50, min_dim // 8)
        faces = face_cascade.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(min_face_px, min_face_px),
        )
        if len(faces) == 0:
            return None

        # Largest detected face = primary subject.
        fx, fy, fw, fh = max(faces, key=lambda f: f[2] * f[3])

        alpha = np.array(img.split()[3])
        subject = (alpha > 20).astype(np.uint8) * 255

        cx = fx + fw / 2.0
        # The Haar box bottom sits roughly at the chin; cut just below it.
        chin_y = fy + fh * 1.02

        # 1) Keep the full, high-quality cutout for everything above the chin
        #    (hair + face, untouched → identical quality to the main system).
        head = subject.copy()
        cut_row = int(round(chin_y))
        if cut_row < 0:
            return None
        if cut_row < h_img:
            head[cut_row:, :] = 0

        # 2) Add a rounded chin/jaw cap below the cut line so the underside
        #    of the sticker curves smoothly under the chin (oval), limited to
        #    ~jaw width and to the actual silhouette so the neck/shoulders are
        #    never pulled in.
        cap = Image.new("L", (w_img, h_img), 0)
        cap_rx = fw * 0.55
        cap_top = fy + fh * 0.78
        cap_bottom = fy + fh * 1.20
        cap_cy = (cap_top + cap_bottom) / 2.0
        cap_ry = (cap_bottom - cap_top) / 2.0
        ImageDraw.Draw(cap).ellipse(
            [cx - cap_rx, cap_cy - cap_ry, cx + cap_rx, cap_cy + cap_ry],
            fill=255,
        )
        cap_arr = np.array(cap)
        head = np.maximum(head, np.minimum(subject, cap_arr))

        if int(head.sum()) == 0:
            return None
        return head.astype(np.uint8)
    except Exception:
        return None


def _face_clearance_bonus_mm(img: Image.Image) -> float:
    """Detect a frontal face (and likely glasses) in the bg-removed image
    and return millimetres of extra cut-line clearance to apply.

    Why: photos of people often have features that hug the silhouette
    edge — eyeglasses frames especially. With no extra padding the cut
    line traces tightly along the bottom of a glasses frame which both
    looks bad (no breathing room) and risks shaving the frame at the
    cutter. We add:

      * +2 mm whenever a face is detected (general portrait safety)
      * +4 mm total when an eye is also detected within the face ROI
        via the dedicated eye-with-glasses cascade — a robust proxy for
        "the user is wearing glasses" or has otherwise visible eye
        detail near the silhouette edge.

    Silent no-op if OpenCV isn't installed or no face is detected — the
    sticker just uses the user-selected border width as before.
    """
    try:
        import cv2  # type: ignore[import-untyped]
    except ImportError:
        return 0.0

    try:
        rgb = np.array(img.convert("RGB"))
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

        face_xml = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        face_cascade = cv2.CascadeClassifier(face_xml)
        if face_cascade.empty():
            return 0.0

        # Min size scales with the image so we don't get spurious detections
        # on tiny artwork while still finding faces on full-bleed portraits.
        min_dim = min(rgb.shape[0], rgb.shape[1])
        min_face_px = max(50, min_dim // 8)
        faces = face_cascade.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(min_face_px, min_face_px),
        )
        if len(faces) == 0:
            return 0.0

        # Default face bonus.
        bonus_mm = 2.0

        glasses_xml = (
            cv2.data.haarcascades + "haarcascade_eye_tree_eyeglasses.xml"
        )
        eye_cascade = cv2.CascadeClassifier(glasses_xml)
        if not eye_cascade.empty():
            for (fx, fy, fw, fh) in faces:
                # Eyes live in roughly the upper 60% of a face crop.
                upper = gray[fy : fy + int(fh * 0.6), fx : fx + fw]
                eyes = eye_cascade.detectMultiScale(
                    upper, scaleFactor=1.1, minNeighbors=4
                )
                if len(eyes) >= 1:
                    bonus_mm = 4.0
                    break
        return bonus_mm
    except Exception:
        # Never block sticker generation on a detection failure.
        return 0.0


def _generate_rectangle_cutline(
    img: Image.Image,
    cut_offset_px: int,
    bleed_px: int,
    border_color: tuple[int, int, int],
    dpi: int,
    corner_radius_mm: float,
) -> CutlineResult:
    """Generate a rounded-rectangle cutline around the entire image.

    Image → cut_offset_px gap → cut line → bleed_px gap → edge of canvas.
    """
    w, h = img.size
    corner_px = int(corner_radius_mm * dpi / 25.4)

    total_pad = cut_offset_px + bleed_px
    new_w = w + 2 * total_pad
    new_h = h + 2 * total_pad

    border_img = Image.new("RGBA", (new_w, new_h), (*border_color, 255))
    border_img.paste(img, (total_pad, total_pad), mask=img.split()[3])

    cut_x1 = bleed_px
    cut_y1 = bleed_px
    cut_x2 = new_w - bleed_px
    cut_y2 = new_h - bleed_px
    cut_corner_px = corner_px + cut_offset_px
    points_px = _rounded_rect_points(
        cut_x1, cut_y1, cut_x2, cut_y2, cut_corner_px,
    )

    px_to_pt = 72.0 / dpi
    points_pt = [(x * px_to_pt, y * px_to_pt) for x, y in points_px]

    buf = io.BytesIO()
    border_img.save(buf, format="PNG")

    return CutlineResult(
        points_px=points_px,
        points_pt=points_pt,
        width_px=new_w,
        height_px=new_h,
        width_pt=new_w * px_to_pt,
        height_pt=new_h * px_to_pt,
        border_image=buf.getvalue(),
    )


def _generate_contour_cutline(
    img: Image.Image,
    cut_offset_px: int,
    bleed_px: int,
    border_color: tuple[int, int, int],
    dpi: int,
    precision: CutlinePrecision,
    subject_mask_override: "np.ndarray | None" = None,
) -> CutlineResult:
    """Generate a contour-following cutline at a consistent distance from subject.

    Steps:
      1. Extract alpha mask of subject
      2. Pad the canvas by (cut_offset_px + bleed_px) on all sides so there's
         always room for the full white border + bleed
      3. Dilate subject mask by cut_offset_px → this is where the cut line sits
      4. Trace the contour of the dilated mask → produces the cut path
      5. Fill white up to (cut_offset_px + bleed_px) for the visual border+bleed

    `subject_mask_override` restricts the cut to a sub-region of the subject
    (e.g. just the head for a face sticker) while the full artwork is still
    composited inside the border.
    """
    w, h = img.size

    if subject_mask_override is not None:
        mask = subject_mask_override.astype(np.uint8)
    else:
        alpha = np.array(img.split()[3])
        mask = (alpha > 20).astype(np.uint8) * 255

    # cut_offset_px may be negative when the user "tightens" the cut line
    # inside the subject edge; only positive offsets need extra canvas room.
    pad_for_cut = max(0, cut_offset_px)
    total_pad = pad_for_cut + bleed_px
    padded_h = h + 2 * total_pad
    padded_w = w + 2 * total_pad
    mask_padded = np.zeros((padded_h, padded_w), dtype=np.uint8)
    mask_padded[total_pad:total_pad + h, total_pad:total_pad + w] = mask

    pre_blur = max(2, abs(cut_offset_px) // 6)
    mask_pil = Image.fromarray(mask_padded, mode="L")
    mask_pil = mask_pil.filter(ImageFilter.GaussianBlur(radius=pre_blur))
    mask_clean = (np.array(mask_pil) > 100).astype(np.uint8) * 255

    hair_smooth_mm = 2.5 if precision == "medium" else 1.5
    hair_smooth_px = max(3, int(hair_smooth_mm * dpi / 25.4))
    mask_clean = _morphological_open(mask_clean, hair_smooth_px)

    if cut_offset_px >= 0:
        cut_mask = _dilate_mask(mask_clean, cut_offset_px)
    else:
        cut_mask = _erode_mask(mask_clean, -cut_offset_px)

    smooth_blur = max(3, abs(cut_offset_px) // 6)
    cut_mask_pil = Image.fromarray(cut_mask, mode="L")
    cut_mask_pil = cut_mask_pil.filter(ImageFilter.GaussianBlur(radius=smooth_blur))
    cut_mask = (np.array(cut_mask_pil) > 128).astype(np.uint8) * 255

    bleed_mask = _dilate_mask(cut_mask, bleed_px)
    bleed_mask_pil = Image.fromarray(bleed_mask, mode="L")
    bleed_mask_pil = bleed_mask_pil.filter(ImageFilter.GaussianBlur(radius=max(3, bleed_px // 2)))
    bleed_mask = (np.array(bleed_mask_pil) > 128).astype(np.uint8) * 255

    border_img = Image.new("RGBA", (padded_w, padded_h), (0, 0, 0, 0))
    border_layer = Image.new("RGBA", (padded_w, padded_h), (*border_color, 255))
    bm_pil = Image.fromarray(bleed_mask, mode="L")
    border_img.paste(border_layer, mask=bm_pil)
    # For a face sticker the visible artwork is clipped to the head region so
    # the body doesn't spill outside the cut. Otherwise use the full alpha.
    if subject_mask_override is not None:
        paste_mask = Image.fromarray(subject_mask_override.astype(np.uint8), mode="L")
    else:
        paste_mask = img.split()[3]
    border_img.paste(img, (total_pad, total_pad), mask=paste_mask)

    contours = find_contours(cut_mask.astype(float), 0.5)
    if not contours:
        points_px = [
            (float(bleed_px), float(bleed_px)),
            (float(padded_w - bleed_px), float(bleed_px)),
            (float(padded_w - bleed_px), float(padded_h - bleed_px)),
            (float(bleed_px), float(padded_h - bleed_px)),
        ]
    else:
        longest = max(contours, key=len)
        points_px = [(float(c[1]), float(c[0])) for c in longest]

    simplify_tol = 3.0 if precision == "medium" else 1.8
    if len(points_px) > 4:
        poly = Polygon(points_px)
        if not poly.is_valid:
            poly = poly.buffer(0)
        simplified = poly.simplify(simplify_tol, preserve_topology=True)
        coords = list(simplified.exterior.coords)
        if coords and coords[-1] == coords[0]:
            coords = coords[:-1]
        points_px = [(float(x), float(y)) for x, y in coords]

    points_px = _smooth_oscillating_regions(
        points_px,
        iterations=12 if precision == "medium" else 8,
        window=6,
        wiggle_threshold=0.35,
        strength=0.55,
    )

    points_px = _collapse_near_collinear_runs(
        points_px,
        max_segment_angle_deg=3.0,
        min_run_length_px=max(20.0, 2.0 * dpi / 25.4),
    )

    points_px = _enforce_min_corner_radius(points_px, dpi=dpi, min_radius_mm=1.0)

    smooth_iters = 4 if precision == "medium" else 3
    points_px = _chaikin_smooth(points_px, iterations=smooth_iters)

    _crop_to_content = True
    if _crop_to_content:
        min_x = min(p[0] for p in points_px)
        min_y = min(p[1] for p in points_px)
        max_x = max(p[0] for p in points_px)
        max_y = max(p[1] for p in points_px)

        crop_x1 = max(0, int(min_x) - bleed_px)
        crop_y1 = max(0, int(min_y) - bleed_px)
        crop_x2 = min(padded_w, int(max_x) + bleed_px + 1)
        crop_y2 = min(padded_h, int(max_y) + bleed_px + 1)

        points_px = [(x - crop_x1, y - crop_y1) for x, y in points_px]
        border_img = border_img.crop((crop_x1, crop_y1, crop_x2, crop_y2))
        out_w = crop_x2 - crop_x1
        out_h = crop_y2 - crop_y1
    else:
        out_w = padded_w
        out_h = padded_h

    px_to_pt = 72.0 / dpi
    points_pt = [(x * px_to_pt, y * px_to_pt) for x, y in points_px]

    buf = io.BytesIO()
    border_img.save(buf, format="PNG")

    return CutlineResult(
        points_px=points_px,
        points_pt=points_pt,
        width_px=out_w,
        height_px=out_h,
        width_pt=out_w * px_to_pt,
        height_pt=out_h * px_to_pt,
        border_image=buf.getvalue(),
    )


def _rounded_rect_points(
    x1: float, y1: float, x2: float, y2: float,
    radius: float, segments_per_corner: int = 12,
) -> list[tuple[float, float]]:
    """Generate points for a rounded rectangle."""
    r = min(radius, (x2 - x1) / 2, (y2 - y1) / 2)
    points: list[tuple[float, float]] = []

    for i in range(segments_per_corner):
        angle = math.pi + (math.pi / 2) * (i / (segments_per_corner - 1))
        points.append((x1 + r + r * math.cos(angle), y1 + r + r * math.sin(angle)))

    for i in range(segments_per_corner):
        angle = 1.5 * math.pi + (math.pi / 2) * (i / (segments_per_corner - 1))
        points.append((x2 - r + r * math.cos(angle), y1 + r + r * math.sin(angle)))

    for i in range(segments_per_corner):
        angle = 0 + (math.pi / 2) * (i / (segments_per_corner - 1))
        points.append((x2 - r + r * math.cos(angle), y2 - r + r * math.sin(angle)))

    for i in range(segments_per_corner):
        angle = math.pi / 2 + (math.pi / 2) * (i / (segments_per_corner - 1))
        points.append((x1 + r + r * math.cos(angle), y2 - r + r * math.sin(angle)))

    return points


def _chaikin_smooth(
    points: list[tuple[float, float]],
    iterations: int = 3,
) -> list[tuple[float, float]]:
    """Chaikin's corner-cutting algorithm for smooth closed polygons."""
    if len(points) < 3:
        return points

    for _ in range(iterations):
        new_points: list[tuple[float, float]] = []
        n = len(points)
        for i in range(n):
            p0 = points[i]
            p1 = points[(i + 1) % n]
            q = (0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1])
            r = (0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1])
            new_points.append(q)
            new_points.append(r)
        points = new_points

    return points


def _smooth_oscillating_regions(
    points: list[tuple[float, float]],
    iterations: int = 10,
    window: int = 5,
    wiggle_threshold: float = 0.35,
    strength: float = 0.5,
) -> list[tuple[float, float]]:
    """Selectively smooth only the high-frequency oscillating regions of
    the contour (e.g. hair tufts), leaving smooth curves and sharp corners
    untouched.

    Detection: count sign-changes of the cross-product at each point within
    a sliding window. A smooth curve has consistent rotation direction (no
    sign changes). A single sharp corner has one sign change at most. Hair
    oscillates with many sign changes in a small region — that's what we
    target.

    For each iteration, points above the wiggle threshold are blended
    toward their local neighbourhood average; points below it are left
    alone. The strength scales with how oscillating the region is so the
    very jaggiest spots smooth fastest.
    """
    n = len(points)
    if n < window * 2 + 1:
        return points

    pts = list(points)

    for _ in range(iterations):
        cross_signs: list[int] = []
        for i in range(n):
            p_prev = pts[(i - 1) % n]
            p_curr = pts[i]
            p_next = pts[(i + 1) % n]
            v1x = p_curr[0] - p_prev[0]
            v1y = p_curr[1] - p_prev[1]
            v2x = p_next[0] - p_curr[0]
            v2y = p_next[1] - p_curr[1]
            cross = v1x * v2y - v1y * v2x
            cross_signs.append(1 if cross > 0 else (-1 if cross < 0 else 0))

        wiggle: list[float] = [0.0] * n
        win_total = window * 2
        for i in range(n):
            changes = 0
            for j in range(-window, window):
                a = cross_signs[(i + j) % n]
                b = cross_signs[(i + j + 1) % n]
                if a != 0 and b != 0 and a != b:
                    changes += 1
            wiggle[i] = changes / win_total

        new_pts: list[tuple[float, float]] = []
        for i in range(n):
            w = wiggle[i]
            if w < wiggle_threshold:
                new_pts.append(pts[i])
                continue
            scale = (w - wiggle_threshold) / (1.0 - wiggle_threshold)
            scale = max(0.0, min(1.0, scale))
            blend = strength * scale

            p_prev = pts[(i - 1) % n]
            p = pts[i]
            p_next = pts[(i + 1) % n]
            avg_x = (p_prev[0] + p[0] + p_next[0]) / 3.0
            avg_y = (p_prev[1] + p[1] + p_next[1]) / 3.0
            new_pts.append((
                p[0] * (1.0 - blend) + avg_x * blend,
                p[1] * (1.0 - blend) + avg_y * blend,
            ))
        pts = new_pts

    return pts


def _collapse_near_collinear_runs(
    points: list[tuple[float, float]],
    max_segment_angle_deg: float = 3.0,
    min_run_length_px: float = 25.0,
) -> list[tuple[float, float]]:
    """Detect long runs where every consecutive segment turns by less than
    `max_segment_angle_deg` and collapse them to just the endpoints.

    Chaikin smoothing preserves a 2-point straight chord perfectly but
    introduces gentle waves when given a chain of near-collinear points.
    Removing the intermediate points means straight image edges produce
    perfectly straight cuts.

    The per-segment angle check distinguishes:
      - True straight edges with pixel-level jaggies (segments differ by 0–2°)
      - Curves where each segment turns by a consistent few degrees
    so smooth curves are never accidentally straightened.
    """
    n = len(points)
    if n < 5:
        return points

    max_cos = math.cos(math.radians(max_segment_angle_deg))
    keep = [True] * n

    i = 0
    while i < n - 2:
        prev_dx = points[i + 1][0] - points[i][0]
        prev_dy = points[i + 1][1] - points[i][1]
        prev_len = math.hypot(prev_dx, prev_dy)
        best_j = i + 1

        for j in range(i + 1, min(n - 1, i + 80)):
            cur_dx = points[j + 1][0] - points[j][0]
            cur_dy = points[j + 1][1] - points[j][1]
            cur_len = math.hypot(cur_dx, cur_dy)
            if cur_len < 1e-6 or prev_len < 1e-6:
                break
            cos_angle = (prev_dx * cur_dx + prev_dy * cur_dy) / (prev_len * cur_len)
            if cos_angle < max_cos:
                break
            best_j = j + 1
            prev_dx, prev_dy = cur_dx, cur_dy
            prev_len = cur_len

        if best_j - i >= 3:
            run_len = math.hypot(
                points[best_j][0] - points[i][0],
                points[best_j][1] - points[i][1],
            )
            if run_len >= min_run_length_px:
                for k in range(i + 1, best_j):
                    keep[k] = False
                i = best_j
                continue
        i += 1

    return [p for p, kept in zip(points, keep) if kept]


def _enforce_min_corner_radius(
    points: list[tuple[float, float]],
    dpi: int,
    min_radius_mm: float = 1.0,
) -> list[tuple[float, float]]:
    """Enforce a minimum radius at every corner so the cutter never has to
    pivot the knife in place.

    Uses morphological opening then closing on the polygon:
      - Opening (shrink → expand) rounds convex corners to ≥ r
      - Closing (expand → shrink) rounds concave corners to ≥ r

    This is the standard CAM-software smoothing for kiss-cut paths. 1mm is
    the conservative minimum for vinyl plotters / laser cutters; tighter
    works on some hardware but won't on all of them.
    """
    if len(points) < 4:
        return points

    r = max(2.0, min_radius_mm * dpi / 25.4)

    try:
        poly = Polygon(points)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty:
            return points

        opened = poly.buffer(-r, resolution=12, join_style=1).buffer(
            r, resolution=12, join_style=1
        )
        if opened.is_empty or not hasattr(opened, "exterior"):
            opened = poly

        closed = opened.buffer(r, resolution=12, join_style=1).buffer(
            -r, resolution=12, join_style=1
        )
        if closed.is_empty or not hasattr(closed, "exterior"):
            closed = opened

        if hasattr(closed, "geoms"):
            closed = max(closed.geoms, key=lambda g: g.area)

        coords = list(closed.exterior.coords)
        if coords and coords[-1] == coords[0]:
            coords = coords[:-1]
        if len(coords) < 4:
            return points
        return [(float(x), float(y)) for x, y in coords]
    except Exception:
        return points


def _dilate_mask(mask: np.ndarray, radius: int) -> np.ndarray:
    """Dilate a binary mask using PIL's MaxFilter iteratively."""
    if radius <= 0:
        return mask
    pil_mask = Image.fromarray(mask, mode="L")
    remaining = radius
    while remaining > 0:
        step = min(remaining, 25)
        kernel = step * 2 + 1
        pil_mask = pil_mask.filter(ImageFilter.MaxFilter(kernel))
        remaining -= step
    return np.array(pil_mask)


def _erode_mask(mask: np.ndarray, radius: int) -> np.ndarray:
    """Erode a binary mask using PIL's MinFilter iteratively."""
    if radius <= 0:
        return mask
    pil_mask = Image.fromarray(mask, mode="L")
    remaining = radius
    while remaining > 0:
        step = min(remaining, 25)
        kernel = step * 2 + 1
        pil_mask = pil_mask.filter(ImageFilter.MinFilter(kernel))
        remaining -= step
    return np.array(pil_mask)


def _morphological_open(mask: np.ndarray, radius: int) -> np.ndarray:
    """Open = erode then dilate. Removes features smaller than the kernel
    while leaving larger shapes untouched. Used to strip hair wisps and
    tiny mask noise without affecting the body silhouette."""
    if radius <= 0:
        return mask
    eroded = _erode_mask(mask, radius)
    return _dilate_mask(eroded, radius)
