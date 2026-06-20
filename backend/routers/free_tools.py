"""Free gang-sheet tool — public endpoints requiring no authentication.

Allows anonymous users to:
  1. Create a temporary session (token stored client-side)
  2. Upload up to 5 artworks (stored in R2 under tmp/{token}/)
  3. Run auto-layout
  4. Export a PDF — which immediately deletes all uploaded assets

No database records are created. A background cleanup task purges
stale tmp/ prefixes older than 1 hour.
"""
from __future__ import annotations

import io
import secrets
import time
import uuid

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import Response
from pydantic import BaseModel

from backend.services import storage
from backend.services.asset_pipeline import normalise
from backend.services.sheet_compositor import (
    Placement,
    SheetConfig,
    compose_pdf,
)

router = APIRouter(prefix="/api/free-tools", tags=["free-tools"])

MAX_ASSETS = 5
TOKEN_BYTES = 16
SESSION_PREFIX = "tmp/"


def _session_prefix(token: str) -> str:
    return f"{SESSION_PREFIX}{token}/"


def _asset_key(token: str, asset_id: str) -> str:
    return f"{_session_prefix(token)}{asset_id}.pdf"


def _thumb_key(token: str, asset_id: str) -> str:
    return f"{_session_prefix(token)}{asset_id}_thumb.jpg"


def _manifest_key(token: str) -> str:
    return f"{_session_prefix(token)}_manifest.json"


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class SessionOut(BaseModel):
    token: str


class FreeAssetOut(BaseModel):
    id: str
    name: str
    kind: str
    width_pt: float
    height_pt: float
    width_px: int | None = None
    height_px: int | None = None
    thumbnail_url: str | None = None


class FreePlacementIn(BaseModel):
    asset_id: str
    x_mm: float
    y_mm: float
    rotation_deg: int = 0
    scale: float = 1.0


class FreeExportIn(BaseModel):
    token: str
    sheet_width_mm: float = 700
    sheet_height_mm: float = 1000
    gap_mm: float = 5
    edge_margin_mm: float = 10
    mirror_output: bool = False
    placements: list[FreePlacementIn]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/session", response_model=SessionOut)
def create_session():
    """Create a temporary anonymous session token."""
    token = secrets.token_urlsafe(TOKEN_BYTES)
    # Store a small marker file so we know this session exists and when it was created
    marker = f'{{"created":{int(time.time())}}}'.encode()
    storage.put_bytes(f"{_session_prefix(token)}.session", marker, content_type="application/json")
    return SessionOut(token=token)


@router.post("/upload", response_model=FreeAssetOut)
def upload_asset(
    token: str = Form(...),
    file: UploadFile = File(...),
):
    """Upload an artwork file to the temporary session. Max 5 per session."""
    # Validate session exists
    if not storage.exists(f"{_session_prefix(token)}.session"):
        raise HTTPException(401, "Invalid or expired session")

    # Check count
    existing = storage.list_prefix(_session_prefix(token))
    asset_count = sum(1 for k in existing if k.endswith(".pdf") and not k.endswith("_manifest.json"))
    if asset_count >= MAX_ASSETS:
        raise HTTPException(400, f"Maximum {MAX_ASSETS} artworks per session")

    body = file.file.read()
    if len(body) > 20 * 1024 * 1024:
        raise HTTPException(400, "File too large (max 20MB)")

    try:
        norm = normalise(body, file.filename or "artwork", file.content_type)
    except ValueError as exc:
        raise HTTPException(415, str(exc))
    except RuntimeError as exc:
        raise HTTPException(503, str(exc))

    asset_id = str(uuid.uuid4())

    # Store normalised PDF
    storage.put_bytes(_asset_key(token, asset_id), norm.pdf_bytes, content_type="application/pdf")

    # Store thumbnail
    thumb_url = None
    if norm.thumbnail_jpg:
        storage.put_bytes(_thumb_key(token, asset_id), norm.thumbnail_jpg, content_type="image/jpeg")
        thumb_url = storage.presigned_get(_thumb_key(token, asset_id), expires_in=3600)

    # Pixel dimensions for raster assets
    wpx = hpx = None
    if norm.kind in ("png", "jpg"):
        wpx = round(norm.width_pt * 300 / 72)
        hpx = round(norm.height_pt * 300 / 72)

    return FreeAssetOut(
        id=asset_id,
        name=file.filename or "artwork",
        kind=norm.kind,
        width_pt=norm.width_pt,
        height_pt=norm.height_pt,
        width_px=wpx,
        height_px=hpx,
        thumbnail_url=thumb_url,
    )


@router.post("/export")
def export_pdf(body: FreeExportIn):
    """Generate the gang-sheet PDF and delete all session assets."""
    token = body.token

    if not storage.exists(f"{_session_prefix(token)}.session"):
        raise HTTPException(401, "Invalid or expired session")

    if not body.placements:
        raise HTTPException(400, "No placements provided")

    # Load asset PDFs from R2
    asset_ids = list({p.asset_id for p in body.placements})
    asset_pdfs: dict[str, bytes] = {}
    for aid in asset_ids:
        key = _asset_key(token, aid)
        try:
            asset_pdfs[aid] = storage.get_bytes(key)
        except Exception:
            raise HTTPException(404, f"Asset {aid} not found in session")

    cfg = SheetConfig(
        media_width_mm=body.sheet_width_mm,
        media_height_mm=body.sheet_height_mm,
        mode="sheet",
        gap_mm=body.gap_mm,
        edge_margin_mm=body.edge_margin_mm,
        sheet_type="dtf" if body.mirror_output else "sticker",
        mirror_output=body.mirror_output,
    )

    placements_typed = [
        Placement(
            asset_id=p.asset_id,
            x_mm=p.x_mm,
            y_mm=p.y_mm,
            rotation_deg=p.rotation_deg,
            scale=p.scale,
        )
        for p in body.placements
    ]

    pdf_bytes = compose_pdf(cfg, placements_typed, asset_pdfs, body.sheet_height_mm)

    # Immediately clean up all session files
    storage.delete_prefix(_session_prefix(token))

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'attachment; filename="gang-sheet.pdf"',
        },
    )


@router.delete("/session/{token}")
def delete_session(token: str):
    """Manually end a session and clean up all uploaded files."""
    deleted = storage.delete_prefix(_session_prefix(token))
    return {"deleted": deleted}


# ---------------------------------------------------------------------------
# Cleanup: purge stale sessions older than 1 hour
# ---------------------------------------------------------------------------

import json
import logging

_log = logging.getLogger(__name__)
STALE_THRESHOLD_SECS = 3600  # 1 hour


def cleanup_stale_sessions() -> int:
    """Delete all tmp/ sessions whose .session marker is older than 1 hour.
    Returns number of sessions purged."""
    try:
        all_keys = storage.list_prefix(SESSION_PREFIX)
    except Exception:
        return 0

    # Find unique session tokens from .session marker files
    session_markers = [k for k in all_keys if k.endswith("/.session")]
    now = int(time.time())
    purged = 0

    for marker_key in session_markers:
        try:
            data = storage.get_bytes(marker_key)
            meta = json.loads(data)
            created = int(meta.get("created", 0))
            if now - created > STALE_THRESHOLD_SECS:
                # Extract token from key: tmp/{token}/.session
                parts = marker_key.split("/")
                if len(parts) >= 2:
                    token = parts[1]
                    storage.delete_prefix(_session_prefix(token))
                    purged += 1
        except Exception:
            continue

    if purged > 0:
        _log.info(f"Free tools cleanup: purged {purged} stale session(s)")
    return purged


@router.post("/cleanup")
def run_cleanup():
    """Admin/cron endpoint to purge stale anonymous sessions."""
    purged = cleanup_stale_sessions()
    return {"purged": purged}
