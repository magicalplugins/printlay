"""Sticker builder API — upload, process, adjust, save."""

from __future__ import annotations

import io
import logging
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.auth import AuthenticatedUser, get_current_user
from backend.database import get_db
from backend.models import User
from backend.models.sticker_usage import StickerUsage
from backend.services import entitlements, storage

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/sticker", tags=["sticker"])

MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB

# Cap heavy image-processing work per machine so we don't OOM under burst load.
# Sticker processing peaks at ~300-400MB of transient memory per request; with
# 2GB total RAM we can comfortably run 3 in parallel and leave headroom for
# FastAPI baseline + DB connections. Fly auto-scales additional machines once
# the configured request concurrency limit is reached.
_MAX_CONCURRENT_HEAVY_JOBS = 3
_heavy_job_semaphore = threading.BoundedSemaphore(_MAX_CONCURRENT_HEAVY_JOBS)


@contextmanager
def _heavy_job_slot(kind: str):
    """Acquire a slot for memory-heavy processing, or raise 503 if at capacity.

    The 503 includes a Retry-After hint so the frontend can show a friendly
    'high load, try again in a few seconds' message rather than a crash.
    """
    acquired = _heavy_job_semaphore.acquire(blocking=False)
    if not acquired:
        log.warning("sticker %s rejected: machine at capacity", kind)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Server is busy processing other stickers. Please try again in a moment.",
            headers={"Retry-After": "10"},
        )
    try:
        yield
    finally:
        _heavy_job_semaphore.release()


def _resolve_user(db: Session, auth: AuthenticatedUser) -> User:
    if not auth.email:
        raise HTTPException(400, "JWT missing email claim")
    from backend.services import user_provisioning
    return user_provisioning.get_or_provision(
        db, auth_id=auth.auth_id, email=auth.email
    )


def _current_month() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


def _get_usage(db: Session, user_id: uuid.UUID) -> int:
    row = (
        db.query(StickerUsage)
        .filter_by(user_id=user_id, month=_current_month())
        .first()
    )
    return row.removals_used if row else 0


def _increment_usage(db: Session, user_id: uuid.UUID) -> int:
    month = _current_month()
    row = (
        db.query(StickerUsage)
        .filter_by(user_id=user_id, month=month)
        .first()
    )
    if row:
        row.removals_used += 1
        row.updated_at = func.now()
    else:
        row = StickerUsage(user_id=user_id, month=month, removals_used=1)
        db.add(row)
    db.flush()
    return row.removals_used


class ProcessResponse(BaseModel):
    preview_url: str
    border_url: str
    width_mm: float
    height_mm: float
    bg_type: str
    removal_method: str | None
    session_id: str


class UsageResponse(BaseModel):
    used: int
    limit: int | None
    plan: str


@router.post("/process", response_model=ProcessResponse)
def process_sticker(
    file: UploadFile = File(...),
    method: str = Form("auto"),
    border_width_mm: float = Form(5.0),
    bleed_mm: float = Form(3.0),
    cutline_mode: str = Form("contour"),
    cutline_precision: str = Form("medium"),
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Upload an image and process into a sticker with background removal + cutline."""
    user = _resolve_user(db, auth)
    ent = entitlements.for_user(user)

    if not ent.allows("sticker_editor"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Sticker editor not available on your plan")

    raw = file.file.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "File too large (max 25 MB)")

    from backend.services.bg_removal import (
        RemovalMethod,
        detect_background,
        normalise_orientation,
    )

    # iPhone "Take Photo" captures land here with EXIF orientation set
    # but pixel data in landscape — without baking the rotation in, the
    # bg removal model returns a PNG (no EXIF) in the wrong orientation
    # and the cut line / preview render sideways. No-op for images with
    # no EXIF rotation (existing portrait uploads, screenshots, etc).
    raw = normalise_orientation(raw)

    needs_ai = False
    removal_method: RemovalMethod | None = None

    if cutline_mode == "rectangle" or method == "none":
        removal_method = None
    else:
        bg_type = detect_background(raw)
        if method == "auto":
            if bg_type == "transparent":
                removal_method = None
            elif bg_type == "solid":
                removal_method = "solid_color"
            else:
                removal_method = "ai_basic"
                needs_ai = True
        elif method == "ai_basic":
            removal_method = "ai_basic"
            needs_ai = True
        elif method == "solid_color":
            removal_method = "solid_color"
        else:
            raise HTTPException(400, f"Unknown method: {method}")

    if needs_ai:
        limit = ent.quota("bg_removals_per_month")
        current = _get_usage(db, user.id)
        if limit is not None and current >= limit:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                f"Monthly AI removal limit reached ({limit}). Upgrade your plan for more.",
            )
        _increment_usage(db, user.id)

    from backend.services.sticker_processor import process_sticker as do_process
    with _heavy_job_slot("process"):
        try:
            result = do_process(
                image_bytes=raw,
                removal_method=removal_method,
                border_width_mm=border_width_mm,
                bleed_mm=bleed_mm,
                cutline_mode=cutline_mode if cutline_mode in ("contour", "rectangle") else "contour",
                cutline_precision=cutline_precision if cutline_precision in ("tight", "medium") else "medium",
            )
        except RuntimeError as exc:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))
        except Exception as exc:
            detail = str(exc)
            if "402" in detail or "credit" in detail.lower():
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE,
                    "AI background removal service temporarily unavailable. Please try again shortly.",
                )
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"Processing failed: {detail}")

    session_id = str(uuid.uuid4())
    prefix = f"sticker-sessions/{user.id}/{session_id}"

    storage.put_bytes(f"{prefix}/preview.png", result.preview_png, "image/png")
    storage.put_bytes(f"{prefix}/border.png", result.border_png, "image/png")

    import json
    cutline_payload = {
        "points_px": [list(p) for p in result.cutline.points_px],
        "points_pt": [list(p) for p in result.cutline.points_pt],
        "width_px": result.cutline.width_px,
        "height_px": result.cutline.height_px,
        "width_pt": result.cutline.width_pt,
        "height_pt": result.cutline.height_pt,
        "width_mm": result.width_mm,
        "height_mm": result.height_mm,
    }
    storage.put_bytes(
        f"{prefix}/cutline.json",
        json.dumps(cutline_payload).encode("utf-8"),
        "application/json",
    )

    db.commit()

    return ProcessResponse(
        preview_url=storage.presigned_get(f"{prefix}/preview.png"),
        border_url=storage.presigned_get(f"{prefix}/border.png"),
        width_mm=result.width_mm,
        height_mm=result.height_mm,
        bg_type=result.bg_type,
        removal_method=result.removal_method,
        session_id=session_id,
    )


class SaveRequest(BaseModel):
    session_id: str
    name: str = "Sticker"
    include_cut_contour: bool = True


class SaveResponse(BaseModel):
    asset_id: str
    thumbnail_url: str


@router.post("/save", response_model=SaveResponse)
def save_sticker(
    body: SaveRequest,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Save a processed sticker as a catalogue asset (PDF with CutContour)."""
    user = _resolve_user(db, auth)
    ent = entitlements.for_user(user)

    if not ent.allows("sticker_editor"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Sticker editor not available on your plan")

    prefix = f"sticker-sessions/{user.id}/{body.session_id}"
    try:
        border_png = storage.get_bytes(f"{prefix}/border.png")
    except Exception:
        raise HTTPException(404, "Sticker session not found or expired")

    import json
    try:
        cutline_json = storage.get_bytes(f"{prefix}/cutline.json")
        cutline_payload = json.loads(cutline_json.decode("utf-8"))
    except Exception:
        raise HTTPException(
            404,
            "Sticker session is incomplete (missing cutline). Please re-process and save again.",
        )

    from backend.services.cutline_generator import CutlineResult
    from backend.services.sticker_processor import StickerProcessResult, save_sticker_pdf

    cutline = CutlineResult(
        points_px=[tuple(p) for p in cutline_payload["points_px"]],
        points_pt=[tuple(p) for p in cutline_payload["points_pt"]],
        width_px=int(cutline_payload["width_px"]),
        height_px=int(cutline_payload["height_px"]),
        width_pt=float(cutline_payload["width_pt"]),
        height_pt=float(cutline_payload["height_pt"]),
        border_image=border_png,
    )
    result = StickerProcessResult(
        preview_png=b"",
        border_png=border_png,
        cutline=cutline,
        width_mm=float(cutline_payload["width_mm"]),
        height_mm=float(cutline_payload["height_mm"]),
        bg_type="transparent",
        removal_method=None,
    )
    with _heavy_job_slot("save"):
        try:
            saved = save_sticker_pdf(result, include_cut_contour=body.include_cut_contour)
        except Exception as exc:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                f"PDF generation failed: {exc}",
            )

    from backend.models import Asset
    asset_id = uuid.uuid4()
    r2_key = f"assets/{user.id}/{asset_id}.pdf"
    thumb_key = f"assets/{user.id}/{asset_id}_thumb.jpg"

    storage.put_bytes(r2_key, saved.pdf_bytes, "application/pdf")
    storage.put_bytes(thumb_key, saved.thumbnail_bytes, "image/jpeg")

    asset = Asset(
        id=asset_id,
        user_id=user.id,
        name=body.name,
        original_filename=f"{body.name}.pdf",
        file_type="pdf",
        width_pt=saved.width_pt,
        height_pt=saved.height_pt,
        r2_key=r2_key,
        thumbnail_r2_key=thumb_key,
        size_bytes=len(saved.pdf_bytes),
    )
    db.add(asset)
    db.commit()

    return SaveResponse(
        asset_id=str(asset_id),
        thumbnail_url=storage.presigned_get(thumb_key),
    )


@router.get("/usage", response_model=UsageResponse)
def get_usage(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get current month's AI background removal usage."""
    user = _resolve_user(db, auth)
    ent = entitlements.for_user(user)
    current = _get_usage(db, user.id)
    limit = ent.quota("bg_removals_per_month")
    return UsageResponse(used=current, limit=limit, plan=ent.plan)
