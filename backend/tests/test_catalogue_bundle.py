"""Bundle round-trip tests."""

from __future__ import annotations

import io
import zipfile

import pytest
from PIL import Image

from backend.services import catalogue_bundle


class _FakeAsset:
    def __init__(self, asset_id: str, name: str, kind: str = "pdf"):
        self.id = asset_id
        self.name = name
        self.kind = kind
        self.r2_key = f"users/u/assets/{asset_id}/normalised.pdf"
        self.thumbnail_r2_key = f"users/u/assets/{asset_id}/thumb.jpg"
        self.width_pt = 252.0
        self.height_pt = 360.0
        self.file_size = 4096


def _png_bytes(color=(0, 200, 100)) -> bytes:
    img = Image.new("RGB", (32, 32), color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


def test_export_then_parse_roundtrip():
    assets = [_FakeAsset("a1", "Card 1"), _FakeAsset("a2", "Card 2")]
    pdf_payloads = {a.id: f"PDF-{a.id}".encode() for a in assets}
    thumb_payloads = {a.id: _png_bytes() for a in assets}

    bundle = catalogue_bundle.export_bundle(
        "GAFF CARDS",
        assets,
        pdf_loader=lambda a: pdf_payloads[a.id],
        thumbnail_loader=lambda a: thumb_payloads[a.id],
    )

    assert isinstance(bundle, bytes) and len(bundle) > 100

    with zipfile.ZipFile(io.BytesIO(bundle)) as zf:
        names = set(zf.namelist())
        assert "manifest.json" in names
        assert "assets/a1.pdf" in names
        assert "assets/a2.pdf" in names
        assert "thumbnails/a1.jpg" in names

    parsed = catalogue_bundle.parse_bundle(bundle)
    assert parsed.category_name == "GAFF CARDS"
    assert len(parsed.assets) == 2
    assert {ba.name for ba in parsed.assets} == {"Card 1", "Card 2"}
    for ba in parsed.assets:
        assert ba.pdf_bytes.startswith(b"PDF-")
        assert ba.thumbnail_jpg is not None


def test_parse_bundle_rejects_bad_schema():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", '{"schema": "wrong", "assets": []}')
    with pytest.raises(ValueError):
        catalogue_bundle.parse_bundle(buf.getvalue())


def test_parse_bundle_skips_missing_pdfs():
    buf = io.BytesIO()
    manifest = {
        "schema": catalogue_bundle.SCHEMA_TAG,
        "category": {"name": "x"},
        "assets": [
            {"id": "real", "name": "good", "kind": "pdf", "width_pt": 1, "height_pt": 1, "file_size": 3},
            {"id": "ghost", "name": "bad", "kind": "pdf", "width_pt": 1, "height_pt": 1, "file_size": 0},
        ],
    }
    with zipfile.ZipFile(buf, "w") as zf:
        import json
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("assets/real.pdf", b"PDF")
    parsed = catalogue_bundle.parse_bundle(buf.getvalue())
    assert len(parsed.assets) == 1
    assert parsed.assets[0].name == "good"
