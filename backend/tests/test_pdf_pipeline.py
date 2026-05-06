"""End-to-end tests for the PDF pipeline.

These cover the most expensive-to-debug-in-prod parts of Printlay:

* `pdf_generator` produces a PDF whose page size matches the input artboard
  byte-exact in points, with the expected number of slots.
* `pdf_parser` round-trips a generated template back to the same shape list.
* `asset_pipeline` normalises raster bytes into a PDF whose page matches the
  source raster's natural dimensions (at our chosen DPI), and emits a thumb.
* `pdf_compositor` places assets in slots, leaves the artboard untouched, and
  -- the fragile bit -- persists the POSITIONS OCG as OFF so the rectangles
  are hidden in the printed sheet.
"""

from __future__ import annotations

import io
import math

import pymupdf
import pytest
from PIL import Image

from backend.services import (
    asset_pipeline,
    color_swap,
    pdf_compositor,
    pdf_generator,
    pdf_parser,
)


def _checker_png(width: int = 200, height: int = 200, color=(220, 30, 100)) -> bytes:
    """Tiny non-trivial raster so compositor visual checks are meaningful."""
    img = Image.new("RGB", (width, height), (255, 255, 255))
    px = img.load()
    for y in range(height):
        for x in range(width):
            if (x // 20 + y // 20) % 2 == 0:
                px[x, y] = color
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def template():
    """A4 landscape with a 3x2 grid of 80x80mm rect slots, 5mm gap, centered."""
    return pdf_generator.generate(
        artboard_w=297, artboard_h=210, units="mm",
        shape_kind="rect",
        shape_w=80, shape_h=80,
        gap_x=5, gap_y=5,
    )


def test_generator_artboard_dimensions_byte_exact(template):
    expected_w_pt = 297 * (72.0 / 25.4)
    expected_h_pt = 210 * (72.0 / 25.4)
    assert template.page_width == pytest.approx(expected_w_pt, abs=0.01)
    assert template.page_height == pytest.approx(expected_h_pt, abs=0.01)
    assert len(template.shapes) >= 4


def test_generator_pdf_page_size_matches_artboard(template):
    doc = pymupdf.open(stream=template.pdf_bytes, filetype="pdf")
    try:
        assert doc.page_count == 1
        page = doc[0]
        assert float(page.rect.width) == pytest.approx(template.page_width, abs=0.01)
        assert float(page.rect.height) == pytest.approx(template.page_height, abs=0.01)
    finally:
        doc.close()


def test_generator_creates_positions_ocg(template):
    doc = pymupdf.open(stream=template.pdf_bytes, filetype="pdf")
    try:
        ocgs = doc.get_ocgs()
        names = [info["name"] for info in ocgs.values()]
        assert "POSITIONS" in names
    finally:
        doc.close()


def test_generator_rejects_oversized_shape():
    with pytest.raises(ValueError):
        pdf_generator.generate(
            artboard_w=100, artboard_h=100, units="mm",
            shape_kind="rect",
            shape_w=200, shape_h=200,
            gap_x=0, gap_y=0,
        )


def _bbox_mm(shape: dict) -> tuple[float, float, float, float]:
    """Convert a generated shape's bbox from points back to mm for assertion."""
    pt_per_mm = 72.0 / 25.4
    x, y, w, h = shape["bbox"]
    return (x / pt_per_mm, y / pt_per_mm, w / pt_per_mm, h / pt_per_mm)


def test_edge_margin_keeps_slots_inside_safe_zone():
    """No slot should encroach inside a 10 mm edge margin."""
    g = pdf_generator.generate(
        artboard_w=297, artboard_h=210, units="mm",
        shape_kind="rect",
        shape_w=50, shape_h=50,
        gap_x=5, gap_y=5,
        edge_margin=10,
    )
    margin = 10.0
    for shape in g.shapes:
        x, y, w, h = _bbox_mm(shape)
        assert x >= margin - 1e-3, f"slot {shape['shape_index']} crosses left margin"
        assert y >= margin - 1e-3, f"slot {shape['shape_index']} crosses top margin"
        assert x + w <= 297 - margin + 1e-3, "slot crosses right margin"
        assert y + h <= 210 - margin + 1e-3, "slot crosses bottom margin"


def test_edge_margin_can_drop_a_column():
    """A4: 5 columns of 50mm fit at 0mm margin (with 5mm gaps), but only
    4 columns fit when 30mm of edge margin is carved off each side."""
    no_margin = pdf_generator.generate(
        artboard_w=297, artboard_h=210, units="mm",
        shape_kind="rect", shape_w=50, shape_h=50,
        gap_x=5, gap_y=5, edge_margin=0,
    )
    with_margin = pdf_generator.generate(
        artboard_w=297, artboard_h=210, units="mm",
        shape_kind="rect", shape_w=50, shape_h=50,
        gap_x=5, gap_y=5, edge_margin=30,
    )
    # Per-row column count: count distinct x positions (rounded to mm).
    def cols(g) -> int:
        return len({round(_bbox_mm(s)[0], 1) for s in g.shapes})
    assert cols(no_margin) == 5
    assert cols(with_margin) == 4


def test_even_mode_distributes_slots_flush_to_safe_edges():
    """In even mode, the first slot's leading edge sits at the margin and the
    last slot's trailing edge sits at (page - margin)."""
    g = pdf_generator.generate(
        artboard_w=200, artboard_h=200, units="mm",
        shape_kind="rect", shape_w=40, shape_h=40,
        edge_margin=10, spacing_mode="even",
    )
    xs = sorted({round(_bbox_mm(s)[0], 3) for s in g.shapes})
    ys = sorted({round(_bbox_mm(s)[1], 3) for s in g.shapes})
    # avail = 200 - 2*10 = 180; floor(180/40) = 4 cols/rows
    assert len(xs) == 4
    assert len(ys) == 4
    assert xs[0] == pytest.approx(10.0, abs=0.05), "first slot must hug left safe edge"
    assert xs[-1] + 40 == pytest.approx(190.0, abs=0.05), "last slot must hug right safe edge"
    assert ys[0] == pytest.approx(10.0, abs=0.05)
    assert ys[-1] + 40 == pytest.approx(190.0, abs=0.05)
    # Spacing between slots should be uniform
    gaps = [xs[i + 1] - (xs[i] + 40) for i in range(len(xs) - 1)]
    assert all(abs(g - gaps[0]) < 0.05 for g in gaps), "even-mode gaps must be uniform"


def test_even_mode_respects_min_gap():
    """In even mode, gap_x/gap_y act as a *minimum* gap. Bumping the minimum
    high enough must drop a column rather than violate it."""
    # 50 mm circles on A4 landscape (297 mm) with no edge margin.
    # No min gap -> 5 columns fit, natural spacing = (297 - 5*50) / 4 = 11.75
    loose = pdf_generator.generate(
        artboard_w=297, artboard_h=210, units="mm",
        shape_kind="rect", shape_w=50, shape_h=50,
        gap_x=0, gap_y=0, spacing_mode="even",
    )
    assert len({round(_bbox_mm(s)[0], 1) for s in loose.shapes}) == 5

    # Min gap of 12 mm > the natural 11.75 -> must drop to 4 columns.
    tight = pdf_generator.generate(
        artboard_w=297, artboard_h=210, units="mm",
        shape_kind="rect", shape_w=50, shape_h=50,
        gap_x=12, gap_y=0, spacing_mode="even",
    )
    xs = sorted({round(_bbox_mm(s)[0], 3) for s in tight.shapes})
    assert len(xs) == 4
    # Resulting spacing must be >= the requested minimum.
    spacings = [xs[i + 1] - (xs[i] + 50) for i in range(len(xs) - 1)]
    assert all(sp >= 12 - 0.05 for sp in spacings)


def test_even_mode_single_slot_centers_in_safe_zone():
    g = pdf_generator.generate(
        artboard_w=100, artboard_h=100, units="mm",
        shape_kind="rect", shape_w=70, shape_h=70,
        edge_margin=10, spacing_mode="even",
    )
    assert len(g.shapes) == 1
    x, y, w, h = _bbox_mm(g.shapes[0])
    # avail = 80, size = 70, leftover = 10 -> centred at margin + 5
    assert x == pytest.approx(15.0, abs=0.05)
    assert y == pytest.approx(15.0, abs=0.05)


def test_edge_margin_too_large_raises():
    with pytest.raises(ValueError, match="no room"):
        pdf_generator.generate(
            artboard_w=100, artboard_h=100, units="mm",
            shape_kind="rect", shape_w=10, shape_h=10,
            edge_margin=60,
        )


def test_shape_larger_than_safe_zone_raises():
    with pytest.raises(ValueError, match="available area"):
        pdf_generator.generate(
            artboard_w=100, artboard_h=100, units="mm",
            shape_kind="rect", shape_w=90, shape_h=90,
            edge_margin=10,
        )


def test_parser_roundtrip_finds_positions_layer(template):
    parsed = pdf_parser.parse(template.pdf_bytes)
    assert parsed.has_positions_ocg is True
    assert parsed.positions_layer == "POSITIONS"
    assert parsed.page_width == pytest.approx(template.page_width, abs=0.01)
    assert parsed.page_height == pytest.approx(template.page_height, abs=0.01)
    assert len(parsed.shapes) == len(template.shapes)


def test_parser_recovers_corner_radius_from_rounded_rects():
    """Slot kind/radius must round-trip - a rounded rect generated with
    a 5mm corner radius must come back from the parser as `kind="rect"`
    with `corner_radius_pt` matching 5mm (= 14.17pt) within sub-pt
    tolerance. Without this, the editable area in the designer falls
    back to an axis-aligned ellipse and stops matching the cut line."""
    tpl = pdf_generator.generate(
        artboard_w=100, artboard_h=80, units="mm",
        shape_kind="rect", shape_w=60, shape_h=40,
        corner_radius=5,
    )
    parsed = pdf_parser.parse(tpl.pdf_bytes)
    assert parsed.shapes, "parser found no shapes"
    s = parsed.shapes[0]
    assert s.kind == "rect", f"expected rounded rect to be detected as rect, got {s.kind!r}"
    expected_radius_pt = 5 * 72.0 / 25.4
    assert s.corner_radius_pt == pytest.approx(expected_radius_pt, abs=0.5), (
        f"corner radius mismatch: parsed={s.corner_radius_pt}pt, expected≈{expected_radius_pt:.2f}pt"
    )


def _hexagon_template_pdf(
    page_w_pt: float = 200, page_h_pt: float = 200,
    centre: tuple[float, float] = (100, 100), radius: float = 60,
) -> bytes:
    """Build a single-page PDF with a regular hexagon stroked by 6
    `l` ops on a `POSITIONS` OCG. Mimics what an Illustrator export of
    a hexagonal die-cut looks like - a closed straight-line path with
    no `re` op and no curves - so the polygon detector has something
    real to chew on without depending on the in-app generator."""
    doc = pymupdf.open()
    try:
        page = doc.new_page(width=page_w_pt, height=page_h_pt)
        ocg_xref = doc.add_ocg("POSITIONS", on=True)
        cx, cy = centre
        verts = [
            (
                cx + radius * math.cos(math.pi / 3 * i - math.pi / 2),
                cy + radius * math.sin(math.pi / 3 * i - math.pi / 2),
            )
            for i in range(6)
        ]
        shape = page.new_shape()
        for i in range(6):
            a = verts[i]
            b = verts[(i + 1) % 6]
            shape.draw_line(pymupdf.Point(*a), pymupdf.Point(*b))
        shape.finish(color=(0, 0, 0), width=1.0, oc=ocg_xref)
        shape.commit()
        out = io.BytesIO()
        doc.save(out)
        return out.getvalue()
    finally:
        doc.close()


def test_parser_classifies_hexagon_as_polygon_with_path():
    """A 6-vertex closed straight-line path (a hexagon) must come back
    as `kind="polygon"` with a normalised `path` of 6 vertices, not as
    a plain rectangle. Without this, the editor draws a square pink cut
    line over the actual hexagonal cut and dropped artwork can't be
    clipped to the real shape."""
    pdf = _hexagon_template_pdf()
    parsed = pdf_parser.parse(pdf)
    assert parsed.shapes, "parser found no shapes"
    poly = next((s for s in parsed.shapes if s.kind == "polygon"), None)
    assert poly is not None, (
        f"hexagon should be detected as polygon, got kinds: "
        f"{[s.kind for s in parsed.shapes]}"
    )
    assert poly.path is not None and len(poly.path) == 6, (
        f"polygon path should have 6 vertices, got {poly.path}"
    )
    # Normalised vertices live in [0, 1]; accept a tiny epsilon for
    # floating-point + stroke rounding from the PDF round-trip.
    for u, v in poly.path:
        assert -0.01 <= u <= 1.01, f"u out of range: {u}"
        assert -0.01 <= v <= 1.01, f"v out of range: {v}"


def test_parser_does_not_misclassify_axis_aligned_rect_as_polygon():
    """A 4-vertex closed straight-line path with axis-aligned edges
    is still a rectangle, not a polygon - polygon detection must skip
    it so corner-radius / handle / cut-line behaviour stays exactly
    as before."""
    doc = pymupdf.open()
    try:
        page = doc.new_page(width=200, height=200)
        shape = page.new_shape()
        pts = [
            pymupdf.Point(40, 40),
            pymupdf.Point(160, 40),
            pymupdf.Point(160, 160),
            pymupdf.Point(40, 160),
        ]
        for i in range(4):
            shape.draw_line(pts[i], pts[(i + 1) % 4])
        shape.finish(color=(0, 0, 0), width=1.0)
        shape.commit()
        out = io.BytesIO()
        doc.save(out)
        pdf = out.getvalue()
    finally:
        doc.close()
    parsed = pdf_parser.parse(pdf)
    assert parsed.shapes
    s = parsed.shapes[0]
    assert s.kind == "rect", f"axis-aligned 4-line rect should stay rect, got {s.kind!r}"
    assert s.path is None, "rect should not carry a polygon path"


def test_parser_still_classifies_pure_circles_as_ellipse():
    """Sanity check the rounded-rect detection didn't reclassify
    circles - a generator-emitted circle must come back with
    `kind="ellipse"` and zero corner radius."""
    tpl = pdf_generator.generate(
        artboard_w=100, artboard_h=80, units="mm",
        shape_kind="circle", shape_w=50, shape_h=50,
    )
    parsed = pdf_parser.parse(tpl.pdf_bytes)
    assert parsed.shapes, "parser found no shapes"
    s = parsed.shapes[0]
    assert s.kind == "ellipse", f"expected circle -> ellipse, got {s.kind!r}"
    assert s.corner_radius_pt == 0.0


def test_generator_emits_ellipse_with_independent_width_height():
    """A non-square ellipse slot must be drawn at the requested w x h
    (oval), tagged `kind="ellipse"` in the generator's shape list, and
    round-trip through the parser as `kind="ellipse"` with the same
    bbox dimensions. Regression guard for the new ellipse option in
    the generator wizard."""
    PT = 72.0 / 25.4
    tpl = pdf_generator.generate(
        artboard_w=200, artboard_h=150, units="mm",
        shape_kind="ellipse", shape_w=80, shape_h=40,
    )
    assert tpl.shapes, "generator produced no shapes"
    g = tpl.shapes[0]
    assert g["kind"] == "ellipse", f"expected ellipse kind, got {g['kind']!r}"
    assert g["bbox"][2] == pytest.approx(80 * PT, abs=0.05), "ellipse width drifted"
    assert g["bbox"][3] == pytest.approx(40 * PT, abs=0.05), "ellipse height drifted"
    assert "corner_radius_pt" not in g, "ellipse must not carry corner_radius_pt"

    parsed = pdf_parser.parse(tpl.pdf_bytes)
    assert parsed.shapes, "parser found no shapes"
    s = parsed.shapes[0]
    assert s.kind == "ellipse", (
        f"non-square oval should round-trip as ellipse, got {s.kind!r}"
    )
    assert s.bbox[2] == pytest.approx(80 * PT, abs=0.5), "parsed ellipse width drifted"
    assert s.bbox[3] == pytest.approx(40 * PT, abs=0.5), "parsed ellipse height drifted"
    assert s.corner_radius_pt == 0.0


def test_generator_ellipse_grid_packs_like_a_rect():
    """Ellipses must use the same axis-aligned bbox layout as rects -
    same row/column count for the same w/h/gap inputs - so the wizard
    preview math (which is shape-agnostic) stays accurate when the
    user switches between rect and ellipse."""
    common = dict(
        artboard_w=200, artboard_h=150, units="mm",
        shape_w=40, shape_h=30, gap_x=5, gap_y=5,
    )
    rect = pdf_generator.generate(shape_kind="rect", **common)
    oval = pdf_generator.generate(shape_kind="ellipse", **common)
    assert len(oval.shapes) == len(rect.shapes), (
        "ellipse layout count diverged from rect - they must share the "
        "same bbox-based packing math."
    )


def test_parser_roundtrip_preserves_slot_positions(template):
    """Each generated slot bbox must round-trip through the parser
    without a y-flip or stroke fudge - slot N's parsed (x, y, w, h)
    must equal what `pdf_generator` recorded, within sub-pixel
    tolerance. This is the test that would have caught the silent
    y-flip that misaligned every imported PDF."""
    parsed = pdf_parser.parse(template.pdf_bytes)
    gen_by_pos = {(round(s["bbox"][0], 1), round(s["bbox"][1], 1)): s for s in template.shapes}

    for ps in parsed.shapes:
        key = (round(ps.bbox[0], 1), round(ps.bbox[1], 1))
        assert key in gen_by_pos, (
            f"parsed shape at {ps.bbox} has no matching generated slot at "
            f"the same top-left corner"
        )
        gen = gen_by_pos[key]
        assert ps.bbox[2] == pytest.approx(gen["bbox"][2], abs=0.5), (
            f"width mismatch at {key}: parsed={ps.bbox[2]} gen={gen['bbox'][2]}"
        )
        assert ps.bbox[3] == pytest.approx(gen["bbox"][3], abs=0.5), (
            f"height mismatch at {key}: parsed={ps.bbox[3]} gen={gen['bbox'][3]}"
        )


def test_asset_pipeline_normalises_png_to_pdf():
    norm = asset_pipeline.normalise(_checker_png(), "card.png", "image/png")
    assert norm.kind == "png"
    assert norm.thumbnail_jpg is not None
    assert len(norm.thumbnail_jpg) > 50

    doc = pymupdf.open(stream=norm.pdf_bytes, filetype="pdf")
    try:
        assert doc.page_count == 1
        # 200px @ 300dpi -> 48pt
        page = doc[0]
        assert float(page.rect.width) == pytest.approx(48.0, abs=0.5)
        assert float(page.rect.height) == pytest.approx(48.0, abs=0.5)
    finally:
        doc.close()


def test_compositor_preserves_artboard_and_disables_positions(template):
    norm = asset_pipeline.normalise(_checker_png(), "card.png", "image/png")
    fillable = [s["shape_index"] for s in template.shapes][:2]
    asset_pdfs = {idx: norm.pdf_bytes for idx in fillable}

    sheet = pdf_compositor.composite(
        template_pdf=template.pdf_bytes,
        slot_shapes=template.shapes,
        asset_pdfs=asset_pdfs,
    )

    assert sheet.page_width_pt == pytest.approx(template.page_width, abs=0.01)
    assert sheet.page_height_pt == pytest.approx(template.page_height, abs=0.01)
    assert sheet.slots_filled == 2
    assert sheet.slots_total == len(template.shapes)

    doc = pymupdf.open(stream=sheet.pdf_bytes, filetype="pdf")
    try:
        ocgs = doc.get_ocgs()
        positions = [info for info in ocgs.values() if info["name"] == "POSITIONS"]
        assert positions, "POSITIONS OCG missing from output"
        assert positions[0]["on"] is False, (
            "POSITIONS OCG must be OFF in output PDF or the slot rectangles "
            "will print on top of the artwork."
        )
    finally:
        doc.close()


def test_compositor_default_contain_places_asset_at_native_size():
    """In the default ("contain") mode, a placed asset must come out at
    its EXACT native physical size, centred on the slot - never stretched
    up to the slot dimensions. This is what a print designer expects:
    a 60x86 mm playing card stays 60x86 mm, with white margin if the
    slot is bigger. Without this, the printed cards come out the size
    of the cut line instead of the artwork's true size, which is the
    bug the user hit in Illustrator (`W: 86.302 mm` instead of the
    asset's real ~60 mm width)."""
    # Slot size 88.2 x 63 mm; asset is 60 x 86 mm (smaller than slot
    # in width, taller in height - exercises both "fits" axes).
    tpl = pdf_generator.generate(
        artboard_w=200, artboard_h=150, units="mm",
        shape_kind="rect", shape_w=88.2, shape_h=63,
    )
    asset_doc = pymupdf.open()
    asset_w_pt = 60 * 72 / 25.4
    asset_h_pt = 86 * 72 / 25.4
    ap = asset_doc.new_page(width=asset_w_pt, height=asset_h_pt)
    ap.draw_rect(ap.rect, color=(0, 0, 0), fill=(1, 1, 0), width=1)
    asset_bytes = asset_doc.tobytes()
    asset_doc.close()

    sheet = pdf_compositor.composite(
        template_pdf=tpl.pdf_bytes,
        slot_shapes=tpl.shapes,
        asset_pdfs={tpl.shapes[0]["shape_index"]: asset_bytes},
    )

    # Re-parse the output and find the placed asset's drawn rect.
    # The slot outline + the asset's own filled rect are both there;
    # we look for the one matching the asset size, not the slot size.
    doc = pymupdf.open(stream=sheet.pdf_bytes, filetype="pdf")
    try:
        page = doc[0]
        # The asset is embedded as an XObject Form. Its placement
        # bbox is set by show_pdf_page via the CTM in the page
        # content stream, so the most reliable check is to look at
        # every XObject Form's CTM. We can also derive the placed
        # rect from the page drawings: filter to the rect that
        # matches the *asset's* native size (not the slot size).
        slot_w_pt = 88.2 * 72 / 25.4
        found_native = False
        for d in page.get_drawings():
            r = d.get("rect")
            if r is None:
                continue
            # Match the asset's drawn fill rectangle (60x86 mm,
            # within 1 pt tolerance). It must NOT be slot-sized.
            if (
                abs(r.width - asset_w_pt) < 1.5
                and abs(r.height - asset_h_pt) < 1.5
                and abs(r.width - slot_w_pt) > 5
            ):
                found_native = True
                break
        assert found_native, (
            "expected asset to be placed at its native 60x86 mm size, "
            "but no drawing in the output PDF matches those dimensions - "
            "the compositor is still scaling the asset to fit the slot."
        )
    finally:
        doc.close()


def test_compositor_manual_mode_with_90_rotation_keeps_aspect():
    """Manual placements describe the asset's bounding box BEFORE the
    designer's CSS rotation, which spins around the box centre. When the
    user rotates a portrait card 90 deg into a landscape slot, the
    on-page visible footprint must end up at swapped dimensions about
    the same centre - otherwise `show_pdf_page` rotates the asset INTO
    a wrong-aspect target rect with `keep_proportion=False` and visibly
    squashes the artwork. This was the playing-card distortion regression.

    The asset here is a 60x90 mm portrait page with a tall ellipse fill.
    The user "saves" the placement as 60x90 mm centred in an 88.2x63 mm
    landscape slot, with rotation=90. After the fix the placed ellipse
    must come out at the rotated 90x60 mm bounds - aspect ~1.5 - not at
    the saved 60x90 mm portrait footprint.
    """
    PT = 72.0 / 25.4
    tpl = pdf_generator.generate(
        artboard_w=200, artboard_h=150, units="mm",
        shape_kind="rect", shape_w=88.2, shape_h=63,
    )
    asset_doc = pymupdf.open()
    asset_w_pt = 60 * PT
    asset_h_pt = 90 * PT
    ap = asset_doc.new_page(width=asset_w_pt, height=asset_h_pt)
    # Distinctive asset content - a filled ellipse that fills the page.
    # We use an ellipse not a rect because page.get_drawings() reports
    # ellipse paths via curves, which we have to inspect via their bbox.
    ap.draw_oval(ap.rect, color=(0, 0, 0), fill=(1, 0, 0), width=0)
    asset_bytes = asset_doc.tobytes()
    asset_doc.close()

    slot = tpl.shapes[0]
    sx, sy, sw, sh = slot["bbox"]
    cx_loc = sw / 2.0
    cy_loc = sh / 2.0

    t = pdf_compositor.SlotTransform(
        rotation_deg=90,
        fit_mode="manual",
        x_pt=cx_loc - asset_w_pt / 2.0,
        y_pt=cy_loc - asset_h_pt / 2.0,
        w_pt=asset_w_pt,
        h_pt=asset_h_pt,
    )
    sheet = pdf_compositor.composite(
        template_pdf=tpl.pdf_bytes,
        slot_shapes=tpl.shapes,
        asset_pdfs={slot["shape_index"]: asset_bytes},
        slot_transforms={slot["shape_index"]: t},
    )

    # Render the output and measure the placed ellipse's bounding box.
    # With the fix, the rotated asset (originally 60x90 mm, rotated 90)
    # must occupy a 90x60 mm footprint - aspect 1.5. Without the fix,
    # show_pdf_page squashes the rotated content into the saved 60x90 mm
    # portrait rect, giving aspect ~0.67 (the visible distortion).
    from PIL import Image as _Image, ImageChops as _ImageChops
    doc = pymupdf.open(stream=sheet.pdf_bytes, filetype="pdf")
    try:
        # Render at 200 DPI = 200/25.4 px per mm.
        pix = doc[0].get_pixmap(dpi=200, alpha=False)
        png = pix.tobytes("png")
    finally:
        doc.close()

    img = _Image.open(io.BytesIO(png)).convert("RGB")
    # Mask everything that isn't the red ellipse fill (255, 0, 0).
    # Slot outline is black, page background is white; both get filtered out.
    # Use a coarse threshold so anti-aliased edges count.
    mono = _Image.new("RGB", img.size, (255, 255, 255))
    px_img = img.load()
    px_out = mono.load()
    for yy in range(img.size[1]):
        for xx in range(img.size[0]):
            r, g, b = px_img[xx, yy]
            if r > 150 and g < 100 and b < 100:
                px_out[xx, yy] = (0, 0, 0)
    bg = _Image.new("RGB", mono.size, (255, 255, 255))
    bbox = _ImageChops.difference(mono, bg).getbbox()
    assert bbox is not None, "no red ellipse rendered - asset wasn't placed"
    px_per_mm = 200 / 25.4
    bw_mm = (bbox[2] - bbox[0]) / px_per_mm
    bh_mm = (bbox[3] - bbox[1]) / px_per_mm
    aspect = bw_mm / bh_mm
    # Rotated 60x90 mm -> 90x60 mm visible -> aspect 1.5. Allow some
    # slack for rasterisation and AA. Pre-fix aspect was ~0.67, so a
    # tolerance of 0.1 is more than enough to distinguish.
    assert abs(aspect - 1.5) < 0.1, (
        f"rotated asset placement is distorted: visible footprint is "
        f"{bw_mm:.1f} x {bh_mm:.1f} mm (aspect {aspect:.2f}), expected "
        f"~90 x 60 mm (aspect 1.50). The compositor is rendering the "
        f"rotated asset into a wrong-aspect target rect - the playing-"
        f"card distortion regression."
    )


def test_compositor_arbitrary_rotation_keeps_aspect_and_centres():
    """The designer slider runs 0-359 deg in 1 deg steps, so the
    compositor must place artwork at exactly the user-requested angle
    (NOT snap to 0/90/180/270). Two requirements verified here:

    1. Aspect is preserved: a 60x90 mm asset rotated 20 deg comes out
       with the same 60x90 mm footprint, just tilted - no squash.
    2. Centre is preserved: the rotated artwork's centre stays at the
       same point as the saved manual box's centre.

    Verified across a representative set of "interesting" angles:
    20deg (small tilt - the user's reported failing case), 45deg
    (diagonal), and 137deg (an arbitrary mid-arc value that snaps
    badly with a `nearest of 0/90/180/270` rule). 0deg is also tested
    as a regression guard for the orthogonal fast path.
    """
    PT = 72.0 / 25.4
    tpl = pdf_generator.generate(
        artboard_w=200, artboard_h=150, units="mm",
        shape_kind="rect", shape_w=88.2, shape_h=63,
    )
    # Asset must fit comfortably inside the slot at every angle so its
    # visible bbox isn't clipped by the page edge - we're checking the
    # placement transform, not slot-overflow behaviour.
    nat_w_mm, nat_h_mm = 30.0, 50.0
    asset_doc = pymupdf.open()
    asset_w_pt = nat_w_mm * PT
    asset_h_pt = nat_h_mm * PT
    ap = asset_doc.new_page(width=asset_w_pt, height=asset_h_pt)
    ap.draw_oval(ap.rect, color=(0, 0, 0), fill=(1, 0, 0), width=0)
    asset_bytes = asset_doc.tobytes()
    asset_doc.close()

    slot = tpl.shapes[0]
    sw_mm = slot["bbox"][2] / PT
    sh_mm = slot["bbox"][3] / PT

    from PIL import Image as _Image, ImageChops as _ImageChops

    expected_diagonal_mm = math.hypot(nat_w_mm, nat_h_mm)

    # 110 deg is the regression-critical value: it's non-orthogonal but
    # snaps to 90 under `_nearest_orthogonal`. The compositor used to
    # reuse the 90/270 dimension swap on that path, which made
    # sx != sy in the rotation matrix and visibly skewed the asset.
    # 200 covers the same trap on the 180-snap side. 22 deg is the
    # small-tilt case the user reported.
    for angle in (0.0, 20.0, 22.0, 45.0, 110.0, 137.0, 200.0):
        t = pdf_compositor.SlotTransform(
            rotation_deg=angle,
            fit_mode="manual",
            x_pt=(sw_mm - nat_w_mm) / 2.0 * PT,
            y_pt=(sh_mm - nat_h_mm) / 2.0 * PT,
            w_pt=asset_w_pt,
            h_pt=asset_h_pt,
        )
        sheet = pdf_compositor.composite(
            template_pdf=tpl.pdf_bytes,
            slot_shapes=tpl.shapes,
            asset_pdfs={slot["shape_index"]: asset_bytes},
            slot_transforms={slot["shape_index"]: t},
        )

        doc = pymupdf.open(stream=sheet.pdf_bytes, filetype="pdf")
        try:
            pix = doc[0].get_pixmap(dpi=200, alpha=False)
        finally:
            doc.close()
        png_bytes = pix.tobytes("png")
        img = _Image.open(io.BytesIO(png_bytes)).convert("RGB")

        # Mask only the red ellipse; ignore the slot outline (black) and
        # the page background (white).
        mono = _Image.new("RGB", img.size, (255, 255, 255))
        for yy in range(img.size[1]):
            for xx in range(img.size[0]):
                r, g, b = img.getpixel((xx, yy))
                if r > 150 and g < 100 and b < 100:
                    mono.putpixel((xx, yy), (0, 0, 0))
        bg = _Image.new("RGB", mono.size, (255, 255, 255))
        bbox = _ImageChops.difference(mono, bg).getbbox()
        assert bbox is not None, f"asset not rendered at {angle} deg"

        px_per_mm = 200 / 25.4
        bw_mm = (bbox[2] - bbox[0]) / px_per_mm
        bh_mm = (bbox[3] - bbox[1]) / px_per_mm
        cx_mm = (bbox[0] + bbox[2]) / 2.0 / px_per_mm
        cy_mm = (bbox[1] + bbox[3]) / 2.0 / px_per_mm

        # Centre must stay locked on the saved box centre regardless of
        # rotation. Slot centre on page in mm:
        slot_cx_mm = (slot["bbox"][0] + slot["bbox"][2] / 2.0) / PT
        slot_cy_mm = (slot["bbox"][1] + slot["bbox"][3] / 2.0) / PT
        assert abs(cx_mm - slot_cx_mm) < 0.5, (
            f"@{angle} deg: ellipse centre x={cx_mm:.2f} mm but slot "
            f"centre is {slot_cx_mm:.2f} mm - rotation isn't pivoting "
            "around the saved box centre."
        )
        assert abs(cy_mm - slot_cy_mm) < 0.5, (
            f"@{angle} deg: ellipse centre y={cy_mm:.2f} mm but slot "
            f"centre is {slot_cy_mm:.2f} mm."
        )

        # Aspect: a rotated rectangle's axis-aligned bbox sides depend
        # on the angle, but the diagonal stays equal to the rectangle's
        # diagonal (sqrt(w^2 + h^2)). Use that as a rotation-agnostic
        # invariant - if the asset got squashed, this drops below the
        # expected diagonal noticeably.
        diag_mm = math.hypot(bw_mm, bh_mm)
        # Tolerance covers a few px of AA on each side at 200 dpi.
        assert abs(diag_mm - expected_diagonal_mm) < 1.5, (
            f"@{angle} deg: visible bbox diagonal {diag_mm:.1f} mm, "
            f"expected ~{expected_diagonal_mm:.1f} mm. Asset is being "
            "squashed instead of just rotated."
        )


def test_compositor_clips_manual_overflow_to_slot_bleed():
    """A manually-placed asset whose bounding box extends past the slot+bleed
    bbox MUST be trimmed at the bleed edge — print imposition cannot allow
    one cell's design to spill into the next cell's area, otherwise the cut
    line bisects the wrong artwork.

    Regression for https://printlay.fly.dev/app/jobs feedback: user dragged
    an oversized JPG so its bbox covered the whole sheet, the PDF rendered
    it across every neighbouring slot, the operator's playing-card output
    was unusable.

    Scenario: 2 slots side by side, 60x40mm each, 0mm bleed, 0mm gap.
    Asset (red) is placed in slot 0 with manual mode at a w/h DOUBLE the
    slot's footprint and offset so it stretches well into slot 1's area.
    After the fix:
      * Red pixels exist in slot 0's bbox (asset rendered).
      * NO red pixels exist anywhere in slot 1's bbox (clip honoured).
    """
    PT = 72.0 / 25.4
    tpl = pdf_generator.generate(
        artboard_w=120, artboard_h=40, units="mm",
        shape_kind="rect",
        shape_w=60, shape_h=40,
        gap_x=0, gap_y=0,
        edge_margin=0,
    )
    assert len(tpl.shapes) == 2, "fixture expected 2 horizontally-adjacent slots"

    asset_doc = pymupdf.open()
    ap = asset_doc.new_page(width=120 * PT, height=40 * PT)
    ap.draw_rect(ap.rect, color=(0, 0, 0), fill=(1, 0, 0), width=0)
    asset_bytes = asset_doc.tobytes()
    asset_doc.close()

    # Saved manual bbox spans the whole artboard from slot 0's perspective:
    # x_pt = 0 (left edge of slot 0), w_pt = 120mm (covers both slots).
    slot0 = tpl.shapes[0]
    slot1 = tpl.shapes[1]
    t = pdf_compositor.SlotTransform(
        rotation_deg=0,
        fit_mode="manual",
        x_pt=0,
        y_pt=0,
        w_pt=120 * PT,
        h_pt=40 * PT,
    )
    sheet = pdf_compositor.composite(
        template_pdf=tpl.pdf_bytes,
        slot_shapes=tpl.shapes,
        asset_pdfs={slot0["shape_index"]: asset_bytes},
        slot_transforms={slot0["shape_index"]: t},
    )

    from PIL import Image as _Image
    doc = pymupdf.open(stream=sheet.pdf_bytes, filetype="pdf")
    try:
        pix = doc[0].get_pixmap(dpi=200, alpha=False)
    finally:
        doc.close()
    img = _Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")

    px_per_mm = 200 / 25.4

    def _has_red(bbox_mm: tuple[float, float, float, float]) -> bool:
        # bbox_mm: (x_mm, y_mm, w_mm, h_mm) — count any "clearly red" pixel.
        x0 = int(bbox_mm[0] * px_per_mm)
        y0 = int(bbox_mm[1] * px_per_mm)
        x1 = int((bbox_mm[0] + bbox_mm[2]) * px_per_mm)
        y1 = int((bbox_mm[1] + bbox_mm[3]) * px_per_mm)
        red = 0
        for yy in range(y0, y1):
            for xx in range(x0, x1):
                r, g, b = img.getpixel((xx, yy))
                if r > 200 and g < 80 and b < 80:
                    red += 1
        return red > 100  # tolerate AA / sampling noise

    s0_mm = (
        slot0["bbox"][0] / PT, slot0["bbox"][1] / PT,
        slot0["bbox"][2] / PT, slot0["bbox"][3] / PT,
    )
    # Slot 1 inset by 1mm on each side so we don't catch slot-1's own
    # outline pixels or any AA spillover at the cut line.
    s1_mm = (
        slot1["bbox"][0] / PT + 1, slot1["bbox"][1] / PT + 1,
        slot1["bbox"][2] / PT - 2, slot1["bbox"][3] / PT - 2,
    )
    assert _has_red(s0_mm), (
        "asset wasn't rendered into slot 0 at all — placement broke entirely."
    )
    assert not _has_red(s1_mm), (
        "asset bled into slot 1's area — slot+bleed clipping is missing. "
        "Each cell's design must terminate at its own cut/bleed edge."
    )


def test_compositor_safe_crop_trims_to_safe_rect_not_to_bleed():
    """`safe_crop=True` is the user's "frame this with a clean white border"
    finishing toggle. The compositor must:

      * Render the asset only inside the slot-safe rect (slot bbox shrunk
        by `safe_pt` on every side).
      * Leave the strip between the safe rect and the cut line as
        unrendered white — the print operator's matte effect.
      * Preserve the user's original placement coords so toggling
        safe_crop OFF restores the full slot+bleed footprint exactly.

    Scenario: 100x80mm slot, 5mm safe area. Asset (red) is placed manual
    covering the whole slot. With safe_crop on, the rendered red area
    must equal the safe rect (90x70mm) and the bleed strip (the 5mm
    band between safe and cut) must be white.
    """
    PT = 72.0 / 25.4
    tpl = pdf_generator.generate(
        artboard_w=140, artboard_h=120, units="mm",
        shape_kind="rect",
        shape_w=100, shape_h=80,
        edge_margin=10,
    )
    slot = tpl.shapes[0]
    sx, sy, sw, sh = slot["bbox"]

    asset_doc = pymupdf.open()
    ap = asset_doc.new_page(width=100 * PT, height=80 * PT)
    ap.draw_rect(ap.rect, color=(0, 0, 0), fill=(1, 0, 0), width=0)
    asset_bytes = asset_doc.tobytes()
    asset_doc.close()

    safe_mm = 5.0
    enriched = [
        {**s, "bleed_pt": 0.0, "safe_pt": safe_mm * PT} for s in tpl.shapes
    ]

    t_safe = pdf_compositor.SlotTransform(
        rotation_deg=0,
        fit_mode="manual",
        x_pt=0, y_pt=0,
        w_pt=100 * PT, h_pt=80 * PT,
        safe_crop=True,
    )
    sheet = pdf_compositor.composite(
        template_pdf=tpl.pdf_bytes,
        slot_shapes=enriched,
        asset_pdfs={slot["shape_index"]: asset_bytes},
        slot_transforms={slot["shape_index"]: t_safe},
    )

    from PIL import Image as _Image
    doc = pymupdf.open(stream=sheet.pdf_bytes, filetype="pdf")
    try:
        pix = doc[0].get_pixmap(dpi=200, alpha=False)
    finally:
        doc.close()
    img = _Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    px_per_mm = 200 / 25.4

    def _is_red(px: tuple[int, int, int]) -> bool:
        return px[0] > 200 and px[1] < 80 and px[2] < 80

    def _is_white(px: tuple[int, int, int]) -> bool:
        return px[0] > 240 and px[1] > 240 and px[2] > 240

    # Inside the safe rect (1mm inset from safe boundary): expect red.
    safe_x0_mm = sx / PT + safe_mm + 1
    safe_y0_mm = sy / PT + safe_mm + 1
    safe_x1_mm = (sx + sw) / PT - safe_mm - 1
    safe_y1_mm = (sy + sh) / PT - safe_mm - 1
    inside_red = 0
    inside_total = 0
    for yy in range(int(safe_y0_mm * px_per_mm), int(safe_y1_mm * px_per_mm)):
        for xx in range(int(safe_x0_mm * px_per_mm), int(safe_x1_mm * px_per_mm)):
            inside_total += 1
            if _is_red(img.getpixel((xx, yy))):
                inside_red += 1
    assert inside_red / max(inside_total, 1) > 0.95, (
        f"safe_crop=True: inside the safe rect we expected ~100% red, got "
        f"{inside_red}/{inside_total}. The compositor isn't rendering the "
        f"asset inside the safe area."
    )

    # In the matte band (between safe rect and cut line, 1.5mm into it):
    # expect WHITE — the asset must not have rendered there even though
    # the user's manual placement covers it.
    band_y_mm = sy / PT + safe_mm * 0.3  # 1.5mm into the matte band
    band_white = 0
    band_total = 0
    for xx in range(int((sx / PT + 1) * px_per_mm), int(((sx + sw) / PT - 1) * px_per_mm)):
        band_total += 1
        if _is_white(img.getpixel((xx, int(band_y_mm * px_per_mm)))):
            band_white += 1
    assert band_white / max(band_total, 1) > 0.95, (
        f"safe_crop=True: matte band between safe and cut line should be "
        f"WHITE, got {band_white}/{band_total} white pixels. The "
        f"compositor isn't honouring safe_crop — the asset is bleeding "
        f"into the safe-frame area."
    )


def test_compositor_rotation_direction_matches_css_clockwise():
    """The designer applies `transform: rotate(${angle}deg)` which is
    CLOCKWISE on screen for positive angles; the on-canvas SlotOverlay
    preview uses the same CSS transform. The generated PDF MUST tilt
    the asset in the same direction the user saw - otherwise the print
    is mirrored relative to what was designed.

    Regression for the "slight angle, output rotation in opposite
    direction, looks mirrored" report. We place a directional asset
    (a yellow card with a red mark in its TOP-LEFT corner) at a small
    positive rotation and assert the red mark ends up on the screen-
    LEFT and screen-TOP half of the placed card's bounding box - which
    is where it lands under a CSS clockwise rotation. Before the fix,
    pymupdf's `rotate=N` (CCW on screen) and the matrix path's positive
    theta both rotated the wrong way, so the mark would land on the
    screen-RIGHT half instead.

    Tested at both an arbitrary angle (matrix path) and 90 deg
    (orthogonal fast path) to lock both code paths.
    """
    PT = 72.0 / 25.4
    nat_w_mm, nat_h_mm = 30.0, 50.0
    asset_w_pt = nat_w_mm * PT
    asset_h_pt = nat_h_mm * PT

    asset_doc = pymupdf.open()
    ap = asset_doc.new_page(width=asset_w_pt, height=asset_h_pt)
    ap.draw_rect(ap.rect, color=(0, 0, 0), fill=(1, 1, 0.6), width=0)
    # Red square in TOP-LEFT corner of the asset (low x, low y in the
    # PDF page rect which has top-left origin in display orientation).
    mark_size_pt = 8 * PT
    ap.draw_rect(
        pymupdf.Rect(0, 0, mark_size_pt, mark_size_pt),
        color=(1, 0, 0), fill=(1, 0, 0), width=0,
    )
    asset_bytes = asset_doc.tobytes()
    asset_doc.close()

    tpl = pdf_generator.generate(
        artboard_w=200, artboard_h=150, units="mm",
        shape_kind="rect", shape_w=88.2, shape_h=63,
    )
    slot = tpl.shapes[0]
    sw_mm = slot["bbox"][2] / PT
    sh_mm = slot["bbox"][3] / PT

    from PIL import Image as _Image, ImageChops as _ImageChops

    def _red_centroid_mm(png_bytes: bytes):
        img = _Image.open(io.BytesIO(png_bytes)).convert("RGB")
        sx = sy = n = 0
        for yy in range(img.size[1]):
            row = [img.getpixel((xx, yy)) for xx in range(img.size[0])]
            for xx, (r, g, b) in enumerate(row):
                if r > 180 and g < 90 and b < 90:
                    sx += xx; sy += yy; n += 1
        assert n > 0, "red mark not visible in output"
        px_per_mm = 200 / 25.4
        return sx / n / px_per_mm, sy / n / px_per_mm

    slot_cx_mm = (slot["bbox"][0] + slot["bbox"][2] / 2.0) / PT
    slot_cy_mm = (slot["bbox"][1] + slot["bbox"][3] / 2.0) / PT

    for angle, path_label in ((22.0, "arbitrary"), (90.0, "orthogonal")):
        t = pdf_compositor.SlotTransform(
            rotation_deg=angle, fit_mode="manual",
            x_pt=(sw_mm - nat_w_mm) / 2.0 * PT,
            y_pt=(sh_mm - nat_h_mm) / 2.0 * PT,
            w_pt=asset_w_pt, h_pt=asset_h_pt,
        )
        sheet = pdf_compositor.composite(
            template_pdf=tpl.pdf_bytes,
            slot_shapes=tpl.shapes,
            asset_pdfs={slot["shape_index"]: asset_bytes},
            slot_transforms={slot["shape_index"]: t},
        )
        doc = pymupdf.open(stream=sheet.pdf_bytes, filetype="pdf")
        try:
            png_bytes = doc[0].get_pixmap(dpi=200, alpha=False).tobytes("png")
        finally:
            doc.close()

        cx_mm, cy_mm = _red_centroid_mm(png_bytes)
        # Mark started in the asset's TOP-LEFT corner. Under a CSS
        # clockwise rotation around the slot centre, the TOP-LEFT
        # corner sweeps toward the TOP-RIGHT (for small angles) and
        # eventually to the screen TOP for 90 deg. The unifying
        # invariant for ALL positive CW angles in (0, 180) is:
        # the mark stays ABOVE the slot centre (smaller y in display
        # coordinates). Under the buggy CCW behaviour it would drop
        # BELOW the centre instead. So we just check y < slot centre.
        assert cy_mm < slot_cy_mm - 1.0, (
            f"@{angle}deg ({path_label} path): red mark centroid "
            f"y={cy_mm:.2f}mm is BELOW slot centre y={slot_cy_mm:.2f}mm. "
            f"Asset rotated CCW instead of CSS-clockwise (mirrored output)."
        )
        # 90 deg case has a stricter, additional check: the TOP-LEFT
        # corner of a portrait asset must end up on the TOP-RIGHT of
        # the page (positive x relative to centre) under CSS clockwise.
        if abs(angle - 90.0) < 0.01:
            assert cx_mm > slot_cx_mm + 1.0, (
                f"@90deg orthogonal: red mark centroid x={cx_mm:.2f}mm "
                f"is LEFT of slot centre x={slot_cx_mm:.2f}mm. The "
                f"orthogonal fast path is rotating CCW instead of CW."
            )


def test_compositor_tags_placed_assets_under_design_layer(template):
    """Every placed asset must be wrapped in an OCG named "DESIGN" so
    Illustrator (and Acrobat) shows the artwork as a toggle-able layer
    next to "POSITIONS". Without this, the placed cards live in the
    page content stream untagged - functional, but not editable as a
    layer in Illustrator."""
    norm = asset_pipeline.normalise(_checker_png(), "card.png", "image/png")
    fillable = [s["shape_index"] for s in template.shapes][:2]
    asset_pdfs = {idx: norm.pdf_bytes for idx in fillable}

    sheet = pdf_compositor.composite(
        template_pdf=template.pdf_bytes,
        slot_shapes=template.shapes,
        asset_pdfs=asset_pdfs,
    )

    doc = pymupdf.open(stream=sheet.pdf_bytes, filetype="pdf")
    try:
        ocgs = doc.get_ocgs()
        design = [info for info in ocgs.values() if info["name"] == "DESIGN"]
        assert design, "DESIGN OCG missing from output"
        assert design[0]["on"] is True, (
            "DESIGN OCG must default to ON so the placed artwork is "
            "visible when the file is opened."
        )
        # Both layers should appear in the UI configuration so Illustrator
        # surfaces them in its Layers panel.
        names = {l["text"] for l in (doc.layer_ui_configs() or [])}
        assert "DESIGN" in names and "POSITIONS" in names
    finally:
        doc.close()


def test_compositor_strips_illustrator_pieceinfo(template):
    """The output must not carry Illustrator's `/PieceInfo` cache - if
    it does, Illustrator restores the empty template from the cache
    and ignores the placed artwork on re-open."""
    norm = asset_pipeline.normalise(_checker_png(), "card.png", "image/png")
    asset_pdfs = {template.shapes[0]["shape_index"]: norm.pdf_bytes}
    sheet = pdf_compositor.composite(
        template_pdf=template.pdf_bytes,
        slot_shapes=template.shapes,
        asset_pdfs=asset_pdfs,
    )
    # Inflate any FlateDecode stream and check the raw bytes - PieceInfo
    # lives on the page dict, not inside content streams, so a substring
    # check on the serialised PDF is sufficient.
    assert b"/PieceInfo" not in sheet.pdf_bytes
    assert b"/AIPrivateData" not in sheet.pdf_bytes


def test_compositor_ignores_unknown_shape_indices(template):
    norm = asset_pipeline.normalise(_checker_png(), "card.png", "image/png")
    asset_pdfs = {99999: norm.pdf_bytes}

    sheet = pdf_compositor.composite(
        template_pdf=template.pdf_bytes,
        slot_shapes=template.shapes,
        asset_pdfs=asset_pdfs,
    )
    assert sheet.slots_filled == 0


def test_compositor_bakes_filter_via_raster_path(template):
    """When a non-passthrough filter is set we route the asset through the
    rasterise-and-embed path so the colour grading lands in the printed
    output. Smoke test: the composite still produces a valid PDF and the
    slot is reported as filled."""
    norm = asset_pipeline.normalise(_checker_png(), "card.png", "image/png")
    fillable = [s["shape_index"] for s in template.shapes][:1]
    asset_pdfs = {idx: norm.pdf_bytes for idx in fillable}
    transforms = {
        idx: pdf_compositor.SlotTransform(filter_id="bw") for idx in fillable
    }

    sheet = pdf_compositor.composite(
        template_pdf=template.pdf_bytes,
        slot_shapes=template.shapes,
        asset_pdfs=asset_pdfs,
        slot_transforms=transforms,
    )

    assert sheet.slots_filled == 1
    # Reopen to confirm the bytes are a valid PDF (the raster insert
    # pathway can mishandle JPEG sources if the rotate kwarg is wrong).
    doc = pymupdf.open(stream=sheet.pdf_bytes, filetype="pdf")
    try:
        assert doc.page_count == 1
    finally:
        doc.close()


# ---------------------------------------------------------------------------
# Colour swap pipeline
# ---------------------------------------------------------------------------


def _vector_card_pdf(width_mm: float, height_mm: float, fill_rgb255):
    """A tiny single-page vector PDF with one filled rectangle of a known
    colour. Stand-in for an Illustrator-exported playing card so colour
    swap detection/application can be verified without a real asset."""
    PT = 72.0 / 25.4
    doc = pymupdf.open()
    page = doc.new_page(width=width_mm * PT, height=height_mm * PT)
    page.draw_rect(page.rect, color=(0, 0, 0), fill=(1, 1, 1), width=0.5)
    inner = pymupdf.Rect(
        5 * PT, 5 * PT, (width_mm - 5) * PT, (height_mm - 5) * PT
    )
    r, g, b = fill_rgb255
    page.draw_rect(inner, color=None, fill=(r / 255, g / 255, b / 255), width=0)
    out = doc.tobytes()
    doc.close()
    return out


def test_color_swap_apply_rewrites_exact_match_to_devicergb():
    """Exact-match source colour gets rewritten to the user's target as
    DeviceRGB (so Illustrator round-trips the byte-exact 0..255 triplet
    rather than mangling it through a calibrated profile)."""
    asset = _vector_card_pdf(60, 90, (211, 25, 79))  # #D3194F (Adobe red-ish)
    detected = color_swap.detect(asset)
    assert (211, 25, 79) in detected, (
        f"Detect must surface the literal fill colour the user can swap; "
        f"got {detected}"
    )

    swapped, report = color_swap.apply(
        asset, [{"source": [211, 25, 79], "target": [74, 23, 211]}]
    )
    assert report.swaps_applied >= 1, (
        "report.swaps_applied must increment when a swap fires - regression "
        "for the bug where the counter stayed at 0 even though the stream "
        "WAS rewritten, hiding the success from the UI."
    )
    # Confirm the bytes really changed: re-detect should now find the
    # target and NOT the source.
    after = color_swap.detect(swapped)
    assert (74, 23, 211) in after
    assert (211, 25, 79) not in after, (
        "Original source colour must be gone from the output - otherwise "
        "the print will show the old colour."
    )

    # And the rendered pixel is the user's target (within JPEG/AA noise).
    pix = pymupdf.open(stream=swapped, filetype="pdf")[0].get_pixmap(dpi=72)
    cx, cy = pix.width // 2, pix.height // 2
    px = pix.pixel(cx, cy)
    assert abs(px[0] - 74) <= 3 and abs(px[1] - 23) <= 3 and abs(px[2] - 211) <= 3, (
        f"centre pixel {px} should match target #4A17D3"
    )


def test_color_swap_off_by_one_source_does_not_fire():
    """The user's most common failure mode: typing a HEX value that's
    1 channel off from the actual artwork colour. Match is intentionally
    EXACT (no fuzzy tolerance - per spec) so this MUST report 0 applied
    AND surface the unmatched source so the UI can warn loudly."""
    asset = _vector_card_pdf(60, 90, (211, 25, 79))  # #D3194F
    swapped, report = color_swap.apply(
        # User typed #D3184E - off by 1g and 1b.
        asset, [{"source": [211, 24, 78], "target": [74, 23, 211]}]
    )
    assert report.swaps_applied == 0
    # The actual colour in the doc must show up in `unmatched` so the
    # UI can tell the user "the colour you typed isn't in this artwork
    # - did you mean #D3194F?".
    assert (211, 25, 79) in report.unmatched


def test_compositor_color_swap_report_is_attached_and_counted():
    """End-to-end: composite() with active swaps populates the sheet's
    color_swap_report. This is what flows back to the UI to render the
    "12 swaps applied" toast (or "0 applied - source not found" warning)
    after Generate PDF."""
    PT = 72.0 / 25.4
    tpl = pdf_generator.generate(
        artboard_w=200, artboard_h=150, units="mm",
        shape_kind="rect", shape_w=88.2, shape_h=63,
    )
    asset = _vector_card_pdf(60, 90, (211, 25, 79))
    slot_idx = tpl.shapes[0]["shape_index"]

    sheet = pdf_compositor.composite(
        template_pdf=tpl.pdf_bytes,
        slot_shapes=tpl.shapes,
        asset_pdfs={slot_idx: asset},
        color_swaps=[{"source": [211, 25, 79], "target": [74, 23, 211]}],
    )
    assert sheet.color_swap_report is not None
    assert sheet.color_swap_report["swaps_applied"] >= 1
    assert "#4A17D3" in sheet.color_swap_report["by_color"].values() or any(
        v >= 1 for v in sheet.color_swap_report["by_color"].values()
    )
