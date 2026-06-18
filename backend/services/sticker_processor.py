"""Sticker processor — orchestrates the full sticker creation pipeline.

Upload → detect background → remove → generate cutline → preview → save.
"""

import io
from dataclasses import dataclass

import pymupdf  # type: ignore[import-untyped]
from PIL import Image

from backend.services.bg_removal import (
    RemovalMethod,
    detect_background,
    remove_background,
)
from backend.services.cutline_generator import (
    CutlineMode,
    CutlinePrecision,
    CutlineResult,
    generate_cutline,
)


# Cap the resolution we do CPU-heavy work at. Background removal (the AI call)
# runs on the full upload, but bilateral skin smoothing, contour tracing,
# morphology and preview rendering scale with pixel count — a 12 MP iPhone photo
# is ~10x slower than a 1.5 MP working image with no visible loss on a sticker
# (a few cm printed). We downscale and scale the DPI by the same factor so the
# physical sticker size (mm/pt) is byte-for-byte identical to full-res.
WORK_MAX_PX = 1400


def _cap_working_image(
    rgba_bytes: bytes, base_dpi: float = 300.0, max_px: int = WORK_MAX_PX
) -> tuple[bytes, float]:
    """Downscale an image so its longest edge is <= max_px, returning the
    (possibly unchanged) PNG bytes and the DPI that preserves physical size."""
    img = Image.open(io.BytesIO(rgba_bytes))
    long_edge = max(img.size)
    if long_edge <= max_px:
        return rgba_bytes, base_dpi
    scale = max_px / float(long_edge)
    new_size = (max(1, round(img.size[0] * scale)), max(1, round(img.size[1] * scale)))
    img = img.convert("RGBA").resize(new_size, Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), base_dpi * scale


@dataclass
class StickerProcessResult:
    """Result of processing an image into a sticker."""
    preview_png: bytes
    border_png: bytes
    cutline: CutlineResult
    width_mm: float
    height_mm: float
    bg_type: str
    removal_method: str | None
    cutout_png: bytes | None = None
    """Background-removed RGBA (pre-cutline). Cached so the cut line can be
    regenerated (precision/mode/face) without re-running AI removal."""
    work_dpi: float = 300.0
    """Effective DPI the cached cutout was processed at (after the working
    resolution cap). Must be reused on regenerate so the sticker keeps the
    same physical size."""


@dataclass
class StickerSaveResult:
    """Result of saving a processed sticker as a PDF asset."""
    pdf_bytes: bytes
    thumbnail_bytes: bytes
    width_pt: float
    height_pt: float


def process_sticker(
    image_bytes: bytes,
    removal_method: RemovalMethod | None = None,
    border_width_mm: float = 5.0,
    border_color: tuple[int, int, int] = (255, 255, 255),
    dpi: int = 300,
    cutline_mode: CutlineMode = "contour",
    cutline_precision: CutlinePrecision = "medium",
    bleed_mm: float = 3.0,
    filter_id: str = "none",
    beautify_smooth: float = 0.0,
    beautify_eyes: float = 0.0,
    beautify_tone: float = 0.0,
    corner_radius_frac: float | None = None,
) -> StickerProcessResult:
    """Process an uploaded image into a sticker with cutline.

    Auto-detects whether background removal is needed. If the image
    already has transparency, skips removal and goes straight to cutline.
    """
    if cutline_mode == "rectangle":
        rgba_bytes = image_bytes
        used_method = None
        bg_type = "kept"
    else:
        bg_type = detect_background(image_bytes)

        if bg_type == "transparent":
            rgba_bytes = image_bytes
            used_method = None
        elif removal_method:
            rgba_bytes = remove_background(image_bytes, method=removal_method)
            used_method = removal_method
        elif bg_type == "solid":
            rgba_bytes = remove_background(image_bytes, method="solid_color")
            used_method = "solid_color"
        else:
            rgba_bytes = remove_background(image_bytes, method="ai_basic")
            used_method = "ai_basic"

    # Cap the working resolution (scaling DPI to keep physical size identical)
    # so every downstream CPU-heavy step is fast. The capped image is cached
    # UNFILTERED so the cut-line + look can be regenerated cheaply later.
    cutout_bytes, work_dpi = _cap_working_image(rgba_bytes, base_dpi=dpi)

    from backend.services.beautify import apply_sticker_look

    look_bytes = apply_sticker_look(
        cutout_bytes,
        filter_id=filter_id,
        smooth=beautify_smooth,
        eyes=beautify_eyes,
        tone=beautify_tone,
    )

    cutline = generate_cutline(
        look_bytes,
        border_width_mm=border_width_mm,
        border_color=border_color,
        dpi=work_dpi,
        mode=cutline_mode,
        precision=cutline_precision,
        corner_radius_frac=corner_radius_frac,
        bleed_mm=bleed_mm,
    )

    preview_png = _render_preview(cutline)

    width_mm = cutline.width_pt * 25.4 / 72.0
    height_mm = cutline.height_pt * 25.4 / 72.0

    return StickerProcessResult(
        preview_png=preview_png,
        border_png=cutline.border_image,
        cutline=cutline,
        width_mm=width_mm,
        height_mm=height_mm,
        bg_type=bg_type,
        removal_method=used_method,
        cutout_png=cutout_bytes,
        work_dpi=work_dpi,
    )


def regenerate_cutline(
    cutout_bytes: bytes,
    border_width_mm: float = 5.0,
    border_color: tuple[int, int, int] = (255, 255, 255),
    dpi: float = 300.0,
    cutline_mode: CutlineMode = "contour",
    cutline_precision: CutlinePrecision = "medium",
    bleed_mm: float = 3.0,
    filter_id: str = "none",
    beautify_smooth: float = 0.0,
    beautify_eyes: float = 0.0,
    beautify_tone: float = 0.0,
    corner_radius_frac: float | None = None,
) -> StickerProcessResult:
    """Re-run the look (filter/beautify) + cut-line step on an already
    background-removed image.

    Used by the preview screen to change precision/mode/tighten/photo filters
    without re-running (and re-charging for) background removal.

    `dpi` MUST be the same work_dpi the cached cutout was first processed at
    (the cutout is already resolution-capped) so the sticker keeps its size.
    """
    from backend.services.beautify import apply_sticker_look

    look_bytes = apply_sticker_look(
        cutout_bytes,
        filter_id=filter_id,
        smooth=beautify_smooth,
        eyes=beautify_eyes,
        tone=beautify_tone,
    )

    cutline = generate_cutline(
        look_bytes,
        border_width_mm=border_width_mm,
        border_color=border_color,
        dpi=dpi,
        mode=cutline_mode,
        precision=cutline_precision,
        corner_radius_frac=corner_radius_frac,
        bleed_mm=bleed_mm,
    )
    preview_png = _render_preview(cutline)
    width_mm = cutline.width_pt * 25.4 / 72.0
    height_mm = cutline.height_pt * 25.4 / 72.0
    return StickerProcessResult(
        preview_png=preview_png,
        border_png=cutline.border_image,
        cutline=cutline,
        width_mm=width_mm,
        height_mm=height_mm,
        bg_type="transparent",
        removal_method=None,
        cutout_png=cutout_bytes,
        work_dpi=dpi,
    )


def save_sticker_pdf(
    result: StickerProcessResult,
    include_cut_contour: bool = True,
) -> StickerSaveResult:
    """Generate a print-ready PDF from a processed sticker.

    The PDF contains the artwork (with border) and an optional CutContour
    spot-colour path for automated cutting via VersaWorks/any RIP.

    The CutContour path is:
    - One continuous closed vector path (no knife lift)
    - Uses a PDF Separation colorspace named exactly "CutContour"
    - Stroke only, no fill, hairline width
    - Cubic Bézier curves for smooth cutting
    """
    cutline = result.cutline
    w_pt = cutline.width_pt
    h_pt = cutline.height_pt

    doc = pymupdf.open()
    page = doc.new_page(width=w_pt, height=h_pt)

    img = Image.open(io.BytesIO(cutline.border_image))
    img_pdf_bytes = _image_to_pdf_bytes(img, w_pt, h_pt)
    img_doc = pymupdf.open(stream=img_pdf_bytes, filetype="pdf")
    page.show_pdf_page(page.rect, img_doc, 0)
    img_doc.close()

    base_pdf_bytes = doc.tobytes(deflate=True)
    doc.close()

    if include_cut_contour and cutline.points_pt:
        final_pdf_bytes = _add_versaworks_cutcontour(
            base_pdf_bytes, cutline.points_pt, w_pt, h_pt
        )
    else:
        final_pdf_bytes = base_pdf_bytes

    thumbnail = _generate_thumbnail(cutline.border_image)

    return StickerSaveResult(
        pdf_bytes=final_pdf_bytes,
        thumbnail_bytes=thumbnail,
        width_pt=w_pt,
        height_pt=h_pt,
    )


def _render_preview(cutline: CutlineResult) -> bytes:
    """Render a preview PNG with the cut path drawn as a dashed blue line.

    Samples the SAME Catmull-Rom → cubic Bezier curves that the PDF export
    uses, so what the user sees in the preview is exactly what the cutter
    will follow. The dashed style is industry convention for cut paths
    (Illustrator CutContour preview, Cricut Design Space, etc.).
    """
    img = Image.open(io.BytesIO(cutline.border_image)).convert("RGBA")

    from PIL import ImageDraw
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    if cutline.points_px and len(cutline.points_px) > 2:
        # Draw the cut path as straight segments between points — matches the
        # exported CutContour (which also uses straight segments) exactly.
        poly = list(cutline.points_px)
        poly.append(poly[0])
        dash_on_px = max(8.0, img.size[0] * 0.012)
        dash_off_px = max(6.0, img.size[0] * 0.009)
        _draw_dashed_polyline(
            draw,
            poly,
            fill=(38, 132, 255, 255),
            width=max(3, img.size[0] // 280),
            dash_on=dash_on_px,
            dash_off=dash_off_px,
        )

    img = Image.alpha_composite(img, overlay)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _sample_catmullrom_bezier(
    points: list[tuple[float, float]],
    samples_per_segment: int = 16,
) -> list[tuple[float, float]]:
    """Sample the Catmull-Rom → cubic Bezier curve into a fine polyline.

    Mirrors the curve construction in `_points_to_bezier_content_stream` so
    the preview shows exactly the same curves the PDF cut path contains.
    """
    n = len(points)
    if n < 3:
        return list(points)

    sampled: list[tuple[float, float]] = []
    for i in range(n):
        p0 = points[(i - 1) % n]
        p1 = points[i]
        p2 = points[(i + 1) % n]
        p3 = points[(i + 2) % n]

        cp1x = p1[0] + (p2[0] - p0[0]) / 6.0
        cp1y = p1[1] + (p2[1] - p0[1]) / 6.0
        cp2x = p2[0] - (p3[0] - p1[0]) / 6.0
        cp2y = p2[1] - (p3[1] - p1[1]) / 6.0

        for s in range(samples_per_segment):
            t = s / samples_per_segment
            u = 1.0 - t
            x = (
                u * u * u * p1[0]
                + 3 * u * u * t * cp1x
                + 3 * u * t * t * cp2x
                + t * t * t * p2[0]
            )
            y = (
                u * u * u * p1[1]
                + 3 * u * u * t * cp1y
                + 3 * u * t * t * cp2y
                + t * t * t * p2[1]
            )
            sampled.append((x, y))

    return sampled


def _draw_dashed_polyline(
    draw,
    points: list[tuple[float, float]],
    fill: tuple[int, int, int, int],
    width: int,
    dash_on: float,
    dash_off: float,
) -> None:
    """Draw a dashed polyline along the given points (closed path)."""
    import math as _math

    cycle = dash_on + dash_off
    distance_into_cycle = 0.0

    for i in range(len(points) - 1):
        x1, y1 = points[i]
        x2, y2 = points[i + 1]
        seg_dx = x2 - x1
        seg_dy = y2 - y1
        seg_len = _math.sqrt(seg_dx * seg_dx + seg_dy * seg_dy)
        if seg_len <= 0:
            continue

        ux = seg_dx / seg_len
        uy = seg_dy / seg_len
        consumed = 0.0
        while consumed < seg_len:
            in_dash = distance_into_cycle < dash_on
            remaining_in_phase = (
                dash_on - distance_into_cycle
                if in_dash
                else cycle - distance_into_cycle
            )
            step = min(remaining_in_phase, seg_len - consumed)
            if in_dash:
                sx = x1 + ux * consumed
                sy = y1 + uy * consumed
                ex = x1 + ux * (consumed + step)
                ey = y1 + uy * (consumed + step)
                draw.line([(sx, sy), (ex, ey)], fill=fill, width=width)
            consumed += step
            distance_into_cycle = (distance_into_cycle + step) % cycle


def _image_to_pdf_bytes(img: Image.Image, w_pt: float, h_pt: float) -> bytes:
    """Convert a PIL image to a single-page PDF at the given size."""
    img_rgb = img.convert("RGBA")
    buf = io.BytesIO()
    img_rgb.save(buf, format="PNG")
    buf.seek(0)

    doc = pymupdf.open()
    page = doc.new_page(width=w_pt, height=h_pt)
    page.insert_image(page.rect, stream=buf.getvalue())
    pdf_bytes = doc.tobytes(deflate=True)
    doc.close()
    return pdf_bytes


def _draw_cut_contour(page, points_pt: list[tuple[float, float]]) -> None:
    """Legacy fallback — draws a visible red stroke for preview purposes only."""
    if len(points_pt) < 3:
        return
    shape = page.new_shape()
    shape.draw_polyline([pymupdf.Point(x, y) for x, y in points_pt])
    shape.close()
    shape.finish(color=(1, 0, 0), width=0.5, closePath=True)
    shape.commit()


def _add_versaworks_cutcontour(
    pdf_bytes: bytes,
    points_pt: list[tuple[float, float]],
    page_w: float,
    page_h: float,
) -> bytes:
    """Add a RIP-compatible CutContour path to the sticker PDF.

    Reuses the same Separation/OCG patterns as the template compositor's
    cut_lines module. Produces one continuous closed cubic Bézier path
    that cutters follow without lifting the knife.

    Meets VersaWorks/Roland, Mimaki RasterLink, and Summa GoSign requirements.
    """
    from backend.services.cut_lines import CutLineSpec, embed as _embed_cutlines_raw

    points = _validate_cutline_geometry(points_pt)
    if len(points) < 3:
        return pdf_bytes

    points = _ensure_clockwise(points)

    import pikepdf

    pdf = pikepdf.open(io.BytesIO(pdf_bytes))
    page = pdf.pages[0]
    page_height = float(page.MediaBox[3] - page.MediaBox[1])

    bezier_ops = _points_to_bezier_content_stream(points, page_height)
    if not bezier_ops:
        pdf.close()
        return pdf_bytes

    sep_array = pikepdf.Array([
        pikepdf.Name("/Separation"),
        pikepdf.Name("/CutContour"),
        pikepdf.Name("/DeviceCMYK"),
        pikepdf.Dictionary(
            FunctionType=2,
            Domain=pikepdf.Array([0, 1]),
            C0=pikepdf.Array([0, 0, 0, 0]),
            C1=pikepdf.Array([0, 1, 0, 0]),
            N=1,
        ),
    ])

    resources = page.get("/Resources", pikepdf.Dictionary())
    if "/ColorSpace" not in resources:
        resources["/ColorSpace"] = pikepdf.Dictionary()
    resources["/ColorSpace"]["/CutContour"] = sep_array
    page["/Resources"] = resources

    content_stream = (
        "q\n"
        "/CutContour CS\n"
        "1 SCN\n"
        "0.25 w\n"
        "0 J\n"
        "0 j\n"
        "[] 0 d\n"
        f"{bezier_ops}\n"
        "S\n"
        "Q\n"
    )

    existing_content = page.get("/Contents")
    if existing_content is not None:
        if isinstance(existing_content, pikepdf.Array):
            streams = list(existing_content)
        else:
            streams = [existing_content]
    else:
        streams = []

    cut_stream = pikepdf.Stream(pdf, content_stream.encode("ascii"))
    streams.append(pdf.make_indirect(cut_stream))
    page["/Contents"] = pikepdf.Array(streams)

    out_buf = io.BytesIO()
    pdf.save(out_buf)
    pdf.close()
    return out_buf.getvalue()


def _validate_cutline_geometry(
    points: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """Clean up cutline geometry for VersaWorks compatibility.

    - Remove duplicate points closer than 0.02mm (~0.057pt)
    - Remove micro-segments shorter than 0.1mm (~0.28pt)
    - Merge almost-collinear points (angle < 2 degrees)
    - Ensure closed (first == last within tolerance)
    """
    import math

    if len(points) < 3:
        return points

    min_dist_pt = 0.057
    min_seg_pt = 0.28
    max_collinear_angle = 2.0

    cleaned: list[tuple[float, float]] = [points[0]]
    for p in points[1:]:
        dx = p[0] - cleaned[-1][0]
        dy = p[1] - cleaned[-1][1]
        if math.sqrt(dx * dx + dy * dy) >= min_dist_pt:
            cleaned.append(p)

    if len(cleaned) < 3:
        return cleaned

    first = cleaned[0]
    last = cleaned[-1]
    dx = first[0] - last[0]
    dy = first[1] - last[1]
    if math.sqrt(dx * dx + dy * dy) < 0.14:
        cleaned[-1] = first

    simplified: list[tuple[float, float]] = [cleaned[0]]
    for i in range(1, len(cleaned) - 1):
        prev = simplified[-1]
        curr = cleaned[i]
        nxt = cleaned[i + 1]

        d1 = math.sqrt((curr[0] - prev[0]) ** 2 + (curr[1] - prev[1]) ** 2)
        if d1 < min_seg_pt:
            continue

        v1 = (curr[0] - prev[0], curr[1] - prev[1])
        v2 = (nxt[0] - curr[0], nxt[1] - curr[1])
        len1 = math.sqrt(v1[0] ** 2 + v1[1] ** 2)
        len2 = math.sqrt(v2[0] ** 2 + v2[1] ** 2)
        if len1 > 0 and len2 > 0:
            cos_angle = (v1[0] * v2[0] + v1[1] * v2[1]) / (len1 * len2)
            cos_angle = max(-1.0, min(1.0, cos_angle))
            angle_deg = math.degrees(math.acos(cos_angle))
            if angle_deg < max_collinear_angle:
                continue

        simplified.append(curr)
    simplified.append(cleaned[-1])

    return simplified


def _ensure_clockwise(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Ensure polygon points are in clockwise order (PDF coordinate space)."""
    area = 0.0
    n = len(points)
    for i in range(n):
        j = (i + 1) % n
        area += points[i][0] * points[j][1]
        area -= points[j][0] * points[i][1]
    if area > 0:
        points = list(reversed(points))
    return points


def _points_to_bezier_content_stream(
    points: list[tuple[float, float]],
    page_height: float,
) -> str:
    """Convert polygon points to a single closed path of straight line
    segments. Outputs PDF content stream operators.

    We intentionally use STRAIGHT line segments (not Catmull-Rom Bézier
    smoothing) so the exported CutContour matches the cut line shown in
    the editor exactly. Catmull-Rom smoothing overshoots on geometric
    shapes (rectangles, rounded rects) producing wavy, bulging cut paths
    in VersaWorks. The points are already dense (corner arcs are sampled,
    organic contours are Chaikin-smoothed upstream) so straight segments
    render smoothly and are the most RIP-compatible representation.

    PDF coordinate system has origin at bottom-left, so we flip Y.
    """
    n = len(points)
    if n < 3:
        return ""

    def flip_y(p: tuple[float, float]) -> tuple[float, float]:
        return (p[0], page_height - p[1])

    pts = [flip_y(p) for p in points]

    ops: list[str] = []
    ops.append(f"{pts[0][0]:.4f} {pts[0][1]:.4f} m")
    for i in range(1, n):
        ops.append(f"{pts[i][0]:.4f} {pts[i][1]:.4f} l")
    ops.append("h")
    return "\n".join(ops)


def _generate_thumbnail(border_png: bytes, max_px: int = 512) -> bytes:
    """Generate a JPEG thumbnail from the border image."""
    img = Image.open(io.BytesIO(border_png)).convert("RGBA")

    bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
    bg.paste(img, mask=img.split()[3])
    bg = bg.convert("RGB")

    bg.thumbnail((max_px, max_px), Image.LANCZOS)

    buf = io.BytesIO()
    bg.save(buf, format="JPEG", quality=80)
    return buf.getvalue()
