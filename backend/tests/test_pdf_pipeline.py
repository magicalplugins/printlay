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
