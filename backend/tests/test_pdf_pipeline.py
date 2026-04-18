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

import pymupdf
import pytest
from PIL import Image

from backend.services import asset_pipeline, pdf_compositor, pdf_generator, pdf_parser


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


def test_compositor_ignores_unknown_shape_indices(template):
    norm = asset_pipeline.normalise(_checker_png(), "card.png", "image/png")
    asset_pdfs = {99999: norm.pdf_bytes}

    sheet = pdf_compositor.composite(
        template_pdf=template.pdf_bytes,
        slot_shapes=template.shapes,
        asset_pdfs=asset_pdfs,
    )
    assert sheet.slots_filled == 0
