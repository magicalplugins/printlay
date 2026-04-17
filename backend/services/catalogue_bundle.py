"""Catalogue bundle export/import.

A bundle is a ZIP file with the following layout:

    manifest.json
    assets/<asset_id>.pdf          # normalised PDF (always present)
    thumbnails/<asset_id>.jpg      # JPEG thumbnail if present in source

`manifest.json` is:

    {
      "schema": "printlay.catalogue.v1",
      "exported_at": "2026-04-17T12:34:56Z",
      "category": { "name": "Gaff cards" },
      "assets": [
        {"id": "<old_id>", "name": "...", "kind": "pdf", "width_pt": 252,
         "height_pt": 360, "file_size": 12345}
      ]
    }

Asset IDs in the manifest are the *source* IDs; on import we mint fresh UUIDs
so bundles are safely round-trippable across users without collision.
"""

from __future__ import annotations

import io
import json
import uuid
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import IO

from backend.models import Asset

SCHEMA_TAG = "printlay.catalogue.v1"


@dataclass
class BundledAsset:
    name: str
    kind: str
    width_pt: float
    height_pt: float
    file_size: int
    pdf_bytes: bytes
    thumbnail_jpg: bytes | None


@dataclass
class ParsedBundle:
    category_name: str
    assets: list[BundledAsset]


def export_bundle(category_name: str, assets: list[Asset], pdf_loader, thumbnail_loader) -> bytes:
    """Build a ZIP bundle of one category.

    `pdf_loader(asset)` and `thumbnail_loader(asset)` are callables that pull
    bytes from R2 (or wherever); kept as callbacks so this module stays free
    of I/O concerns.
    """
    buf = io.BytesIO()
    manifest_assets: list[dict] = []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for a in assets:
            try:
                pdf_bytes = pdf_loader(a)
            except Exception:
                continue  # skip unreadable assets rather than abort the bundle
            zf.writestr(f"assets/{a.id}.pdf", pdf_bytes)
            if a.thumbnail_r2_key:
                try:
                    thumb = thumbnail_loader(a)
                    if thumb:
                        zf.writestr(f"thumbnails/{a.id}.jpg", thumb)
                except Exception:
                    pass
            manifest_assets.append(
                {
                    "id": str(a.id),
                    "name": a.name,
                    "kind": a.kind,
                    "width_pt": a.width_pt,
                    "height_pt": a.height_pt,
                    "file_size": a.file_size,
                }
            )

        manifest = {
            "schema": SCHEMA_TAG,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "category": {"name": category_name},
            "assets": manifest_assets,
        }
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))
    return buf.getvalue()


def parse_bundle(file_bytes: bytes | IO[bytes]) -> ParsedBundle:
    if isinstance(file_bytes, (bytes, bytearray)):
        f: IO[bytes] = io.BytesIO(file_bytes)
    else:
        f = file_bytes

    with zipfile.ZipFile(f, "r") as zf:
        names = set(zf.namelist())
        if "manifest.json" not in names:
            raise ValueError("Bundle missing manifest.json")
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
        if manifest.get("schema") != SCHEMA_TAG:
            raise ValueError(f"Unsupported bundle schema: {manifest.get('schema')!r}")

        cat_name = (manifest.get("category") or {}).get("name") or "Imported"

        assets: list[BundledAsset] = []
        for entry in manifest.get("assets", []):
            old_id = entry.get("id")
            if not old_id:
                continue
            pdf_path = f"assets/{old_id}.pdf"
            if pdf_path not in names:
                continue
            pdf_bytes = zf.read(pdf_path)
            thumb_path = f"thumbnails/{old_id}.jpg"
            thumb_bytes = zf.read(thumb_path) if thumb_path in names else None

            assets.append(
                BundledAsset(
                    name=entry.get("name") or "Imported asset",
                    kind=entry.get("kind") or "pdf",
                    width_pt=float(entry.get("width_pt") or 0),
                    height_pt=float(entry.get("height_pt") or 0),
                    file_size=int(entry.get("file_size") or len(pdf_bytes)),
                    pdf_bytes=pdf_bytes,
                    thumbnail_jpg=thumb_bytes,
                )
            )

    return ParsedBundle(category_name=cat_name, assets=assets)


def fresh_asset_id() -> uuid.UUID:
    return uuid.uuid4()
