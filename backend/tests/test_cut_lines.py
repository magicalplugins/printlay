"""Cut-line embedding tests.

These cover the post-composite step that turns each slot bbox into a
stroked path drawn in a Separation colour space - the geometry a Roland
or Mimaki RIP routes to its cutter. The "is the path actually on the
page?" checks parse the output PDF back through pikepdf so we're
verifying real PDF objects, not just our generated source string.
"""

from __future__ import annotations

import io

import pikepdf
import pymupdf
import pytest

from backend.services import cut_lines, pdf_compositor, pdf_generator


@pytest.fixture
def template_3x2():
    """Same A4-landscape 80x80mm grid the existing pipeline tests use,
    so a cut-line failure is unambiguously about THIS module and not a
    template/parser regression."""
    return pdf_generator.generate(
        artboard_w=297, artboard_h=210, units="mm",
        shape_kind="rect",
        shape_w=80, shape_h=80,
        gap_x=5, gap_y=5,
    )


@pytest.fixture
def circle_template():
    return pdf_generator.generate(
        artboard_w=200, artboard_h=200, units="mm",
        shape_kind="circle",
        shape_w=40, shape_h=40,
        gap_x=10, gap_y=10,
    )


def test_compositor_does_not_add_cut_lines_when_unset(template_3x2):
    """Default behaviour: no cut_line_spec means the output is byte-for-
    byte the artwork-only file. Critical regression guard for every
    user who ISN'T using the new feature."""
    sheet = pdf_compositor.composite(
        template_pdf=template_3x2.pdf_bytes,
        slot_shapes=template_3x2.shapes,
        asset_pdfs={},
    )
    with pikepdf.open(io.BytesIO(sheet.pdf_bytes)) as pdf:
        page = pdf.pages[0]
        cs = page.Resources.get("/ColorSpace") if "/Resources" in page else None
        if cs is None:
            return  # nothing to check; no Separation present
        assert "/CutContour" not in cs, (
            "Default generate added a cut-line Separation. Backwards "
            "compatibility with non-cut workflows is broken."
        )


def test_cut_line_separation_resource_added_with_user_name(template_3x2):
    """The Separation resource key on the page MUST equal the user's
    chosen spot name verbatim - that's how Roland VersaWorks identifies
    which paths to send to the cutter."""
    spec = cut_lines.CutLineSpec(spot_name="CutContour", rgb=(255, 0, 255))
    sheet = pdf_compositor.composite(
        template_pdf=template_3x2.pdf_bytes,
        slot_shapes=template_3x2.shapes,
        asset_pdfs={},
        cut_line_spec=spec,
    )
    with pikepdf.open(io.BytesIO(sheet.pdf_bytes)) as pdf:
        page = pdf.pages[0]
        cs = page.Resources.ColorSpace
        assert "/CutContour" in cs, (
            "Cut-line Separation resource missing - RIP will not see "
            "the spot colour and the geometry won't reach the cutter."
        )
        sep = cs["/CutContour"]
        assert str(sep[0]) == "/Separation"
        assert str(sep[1]) == "/CutContour"
        assert str(sep[2]) == "/DeviceRGB"


def test_cut_line_custom_spot_name_carries_through(template_3x2):
    """Mimaki shops use 'Through-cut'. The exact name has to land on the
    page - we don't normalise or lowercase it."""
    spec = cut_lines.CutLineSpec(spot_name="Through-cut", rgb=(255, 0, 255))
    sheet = pdf_compositor.composite(
        template_pdf=template_3x2.pdf_bytes,
        slot_shapes=template_3x2.shapes,
        asset_pdfs={},
        cut_line_spec=spec,
    )
    with pikepdf.open(io.BytesIO(sheet.pdf_bytes)) as pdf:
        page = pdf.pages[0]
        assert "/Through-cut" in page.Resources.ColorSpace


def test_cut_line_content_stream_uses_separation_and_strokes(template_3x2):
    """Walk the page's content streams and confirm the new layer:
       1. selects the Separation as the stroking colour space (`CS` op),
       2. sets full tint (`1 SCN`),
       3. issues actual stroke (`S`) operators.
    Without all three the visual cut path won't render and the cutter
    won't get the geometry."""
    spec = cut_lines.CutLineSpec(spot_name="CutContour", rgb=(255, 0, 255))
    sheet = pdf_compositor.composite(
        template_pdf=template_3x2.pdf_bytes,
        slot_shapes=template_3x2.shapes,
        asset_pdfs={},
        cut_line_spec=spec,
    )
    with pikepdf.open(io.BytesIO(sheet.pdf_bytes)) as pdf:
        page = pdf.pages[0]
        # Concatenate every content stream so we don't miss our
        # appended one (pikepdf returns Page.Contents as either a
        # stream or an array of streams depending on history).
        chunks: list[bytes] = []
        contents = page.Contents
        if isinstance(contents, pikepdf.Stream):
            chunks.append(bytes(contents.read_bytes()))
        else:
            for item in contents:
                if isinstance(item, pikepdf.Stream):
                    chunks.append(bytes(item.read_bytes()))
        all_content = b"\n".join(chunks)
        assert b"/CutContour CS" in all_content, (
            "Content stream never selects the cut-line Separation as "
            "the stroking colour space."
        )
        assert b"SCN" in all_content
        # At least one stroke per slot in the template.
        assert all_content.count(b"\nS\n") >= len(template_3x2.shapes), (
            "Fewer stroke operations than template slots - some slot "
            "outlines were silently skipped."
        )


def test_cut_line_geometry_lands_on_real_slot_positions(template_3x2):
    """The cut path's bbox needs to coincide with the slot bboxes. We
    rasterise the output to PNG and check that the ink density along
    each slot's perimeter is non-zero - any positioning bug (e.g. y-flip
    error, bleed accidentally extending the cut path) shows up here as
    blank perimeters."""
    spec = cut_lines.CutLineSpec(spot_name="CutContour", rgb=(255, 0, 255))
    sheet = pdf_compositor.composite(
        template_pdf=template_3x2.pdf_bytes,
        slot_shapes=template_3x2.shapes,
        asset_pdfs={},
        cut_line_spec=spec,
        # No bleed / no transforms - clean baseline.
    )

    # Render the output at 144 DPI and look for magenta along each
    # slot's edge. We don't need a perfect match - just non-trivial
    # presence of pink/magenta pixels in the bbox border.
    doc = pymupdf.open(stream=sheet.pdf_bytes, filetype="pdf")
    try:
        page = doc[0]
        zoom = 2.0
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        from PIL import Image
        img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")

        for shape in template_3x2.shapes:
            x_top, y_top, w, h = shape["bbox"]
            # Sample the centre of each edge of the bbox in image px.
            samples = [
                (x_top + w / 2, y_top),       # top edge centre
                (x_top + w / 2, y_top + h),   # bottom edge centre
                (x_top, y_top + h / 2),       # left edge centre
                (x_top + w, y_top + h / 2),   # right edge centre
            ]
            magenta_hits = 0
            for sx, sy in samples:
                # Allow a small radius around the sample point because
                # the stroke is hairline - we tolerate a couple of
                # pixels of antialiasing in any direction.
                cx = int(sx * zoom)
                cy = int(sy * zoom)
                hit = False
                for dx in range(-3, 4):
                    if hit:
                        break
                    for dy in range(-3, 4):
                        nx, ny = cx + dx, cy + dy
                        if not (0 <= nx < img.width and 0 <= ny < img.height):
                            continue
                        r, g, b = img.getpixel((nx, ny))
                        # Pink/magenta: R and B both saturated, G dipped
                        # by the antialiased stroke. The hairline rarely
                        # gets to 100% magenta at sub-pixel widths so we
                        # accept any noticeable G dip.
                        if r > 230 and b > 230 and g < 230:
                            hit = True
                            magenta_hits += 1
                            break
            assert magenta_hits >= 3, (
                f"Cut path missing on at least one edge of slot "
                f"{shape['shape_index']} - geometry alignment bug."
            )
    finally:
        doc.close()


def test_cut_line_works_for_circle_slots(circle_template):
    """The ellipse path-emitter has its own code (4 cubic Bezier arcs).
    Make sure circle templates produce real cut paths too, not silently
    skipped."""
    spec = cut_lines.CutLineSpec(spot_name="CutContour", rgb=(255, 0, 255))
    sheet = pdf_compositor.composite(
        template_pdf=circle_template.pdf_bytes,
        slot_shapes=circle_template.shapes,
        asset_pdfs={},
        cut_line_spec=spec,
    )
    with pikepdf.open(io.BytesIO(sheet.pdf_bytes)) as pdf:
        page = pdf.pages[0]
        chunks: list[bytes] = []
        contents = page.Contents
        if isinstance(contents, pikepdf.Stream):
            chunks.append(bytes(contents.read_bytes()))
        else:
            for item in contents:
                if isinstance(item, pikepdf.Stream):
                    chunks.append(bytes(item.read_bytes()))
        all_content = b"\n".join(chunks)
        # Ellipses use cubic Bezier (`c` operator) rather than `re`.
        assert b" c\n" in all_content or b" c " in all_content, (
            "Ellipse cut path never emitted Bezier curves - circle "
            "slots may be falling through to rect."
        )


def test_cut_lines_register_ocg_named_after_spot(template_3x2):
    """Open in Illustrator / Acrobat and the cut paths must appear as a
    standalone, named layer in the Layers panel - the same way the
    existing POSITIONS and DESIGN layers do. The OCG /Name has to
    equal the spot colour name verbatim so when the multi-spot phase
    arrives (Gloss, White, PerfCut) every spot gets its own clearly
    labelled layer."""
    spec = cut_lines.CutLineSpec(spot_name="CutContour", rgb=(255, 0, 255))
    sheet = pdf_compositor.composite(
        template_pdf=template_3x2.pdf_bytes,
        slot_shapes=template_3x2.shapes,
        asset_pdfs={},
        cut_line_spec=spec,
    )
    doc = pymupdf.open(stream=sheet.pdf_bytes, filetype="pdf")
    try:
        ocgs = doc.get_ocgs()
        names = [info["name"] for info in ocgs.values()]
        assert "POSITIONS" in names, "Existing POSITIONS layer was lost"
        assert "DESIGN" in names, "Existing DESIGN layer was lost"
        assert "CutContour" in names, (
            "Cut layer not registered as an OCG - opening the PDF in "
            "Illustrator will show a flat document instead of three "
            "separately toggleable layers."
        )
        cut_info = next(i for i in ocgs.values() if i["name"] == "CutContour")
        assert cut_info["on"] is True, (
            "CutContour layer must be ON by default so the cut path is "
            "visible the moment the file opens."
        )
        # Illustrator's Layers panel lists OCGs in /OCProperties/D/Order;
        # absence from Order means the layer exists but doesn't appear
        # in the panel UI (just as a hidden technical artefact). Verify
        # it lands in the user-visible list.
        ui_configs = doc.layer_ui_configs()
        ui_names = [c["text"] for c in ui_configs]
        assert "CutContour" in ui_names, (
            "CutContour OCG isn't listed in the Layers panel UI."
        )
    finally:
        doc.close()


def test_cut_line_content_wrapped_in_marked_content(template_3x2):
    """The cut content stream must be wrapped in a /OC ... BDC/EMC pair
    that references the OCG via the page's /Resources/Properties dict.
    Without this the geometry exists in the PDF but doesn't BELONG to
    the layer - toggling the layer in Illustrator wouldn't hide it."""
    spec = cut_lines.CutLineSpec(spot_name="CutContour", rgb=(255, 0, 255))
    sheet = pdf_compositor.composite(
        template_pdf=template_3x2.pdf_bytes,
        slot_shapes=template_3x2.shapes,
        asset_pdfs={},
        cut_line_spec=spec,
    )
    with pikepdf.open(io.BytesIO(sheet.pdf_bytes)) as pdf:
        page = pdf.pages[0]
        # 1. Resources/Properties must have an entry pointing to the OCG
        properties = page.Resources.Properties
        prop_keys = list(properties.keys())
        assert any("CutContour" in str(k) for k in prop_keys), (
            f"Page resource /Properties has no key bound to the cut OCG - "
            f"keys present: {prop_keys}"
        )
        prop_entry = next(
            properties[k] for k in prop_keys if "CutContour" in str(k)
        )
        # The property entry resolves to the OCG dict, whose Name is
        # the human-visible layer label.
        assert str(prop_entry.Name) == "CutContour"

        # 2. Content stream wraps cut paths in /OC /<key> BDC ... EMC
        contents = page.Contents
        chunks: list[bytes] = []
        if isinstance(contents, pikepdf.Stream):
            chunks.append(bytes(contents.read_bytes()))
        else:
            for item in contents:
                if isinstance(item, pikepdf.Stream):
                    chunks.append(bytes(item.read_bytes()))
        all_content = b"\n".join(chunks)
        assert b"/OC /PL_CutContour BDC" in all_content, (
            "Cut content stream is NOT inside an /OC marked-content block - "
            "Illustrator will show the geometry but won't let the user "
            "toggle it via the Layers panel."
        )
        assert b"\nEMC\n" in all_content, "Marked content never closed"


def test_cut_line_layer_idempotent_when_embed_runs_twice(template_3x2):
    """Re-running embed for the same spot name (e.g. user re-generates
    after a UI tweak, or future multi-layer feature embeds the same spot
    twice) must NOT duplicate the OCG - we'd end up with 'CutContour',
    'CutContour' in Illustrator's Layers panel, which is confusing and
    breaks the toggle-in-one-place mental model."""
    spec = cut_lines.CutLineSpec(spot_name="CutContour", rgb=(255, 0, 255))
    sheet1 = pdf_compositor.composite(
        template_pdf=template_3x2.pdf_bytes,
        slot_shapes=template_3x2.shapes,
        asset_pdfs={},
        cut_line_spec=spec,
    )
    # Run embed AGAIN on the already-cut output - this is what the
    # multi-spot future would do if a user added two layers with the
    # same name (we want them to share the OCG).
    out2 = cut_lines.embed(
        pdf_bytes=sheet1.pdf_bytes,
        slot_shapes=template_3x2.shapes,
        spec=spec,
    )
    doc = pymupdf.open(stream=out2, filetype="pdf")
    try:
        names = [i["name"] for i in doc.get_ocgs().values()]
        assert names.count("CutContour") == 1, (
            f"OCG duplicated on re-embed; Layers panel would show two "
            f"identical entries. Names: {names}"
        )
    finally:
        doc.close()


def test_cut_line_layer_name_uses_spot_name_for_each_machine():
    """When the user picks 'Through-cut' (Mimaki) or 'PerfCut' (custom),
    the OCG name has to follow - operators expect the layer label in
    Illustrator to match the spot they configured, not a generic 'CUT'."""
    template = pdf_generator.generate(
        artboard_w=200, artboard_h=200, units="mm",
        shape_kind="rect", shape_w=80, shape_h=80,
    )
    for spot_name in ("Through-cut", "PerfCut", "Gloss", "White"):
        spec = cut_lines.CutLineSpec(spot_name=spot_name, rgb=(255, 0, 255))
        sheet = pdf_compositor.composite(
            template_pdf=template.pdf_bytes,
            slot_shapes=template.shapes,
            asset_pdfs={},
            cut_line_spec=spec,
        )
        doc = pymupdf.open(stream=sheet.pdf_bytes, filetype="pdf")
        try:
            names = [i["name"] for i in doc.get_ocgs().values()]
            assert spot_name in names, (
                f"Layer for '{spot_name}' missing - Illustrator will not "
                f"show a layer with that label."
            )
        finally:
            doc.close()


def test_cut_line_separation_tint_carries_user_rgb(template_3x2):
    """The tint transform's C1 vector is the user's preview RGB
    normalised to [0, 1]. Wrong values here would show the cut path in
    the wrong colour in Acrobat (and mislead operators)."""
    spec = cut_lines.CutLineSpec(spot_name="CutContour", rgb=(204, 0, 102))
    sheet = pdf_compositor.composite(
        template_pdf=template_3x2.pdf_bytes,
        slot_shapes=template_3x2.shapes,
        asset_pdfs={},
        cut_line_spec=spec,
    )
    with pikepdf.open(io.BytesIO(sheet.pdf_bytes)) as pdf:
        sep = pdf.pages[0].Resources.ColorSpace["/CutContour"]
        tint = sep[3]
        c1 = list(tint.C1)
        assert pytest.approx(float(c1[0]), abs=0.01) == 204 / 255
        assert pytest.approx(float(c1[1]), abs=0.01) == 0 / 255
        assert pytest.approx(float(c1[2]), abs=0.01) == 102 / 255
