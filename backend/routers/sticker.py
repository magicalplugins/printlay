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
from PIL import Image
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

# Cap heavy image-processing work per machine. Each job is CPU-bound (OpenCV /
# Pillow / NumPy), so running several at once on a shared-cpu-2x machine pegs
# the CPU and starves the /api/health handler — the health check then fails and
# the Fly proxy drops ALL traffic (Cloudflare 524). Limiting to 2 keeps a slice
# of CPU free for health checks and other requests while still allowing some
# parallelism. Fly auto-scales additional machines once the configured request
# concurrency limit is reached.
_MAX_CONCURRENT_HEAVY_JOBS = 2
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
    # Unfiltered background-removed cutout — used by the frontend to preview
    # photo filters without double-applying onto the already-baked border.
    cutout_url: str = ""
    width_mm: float
    height_mm: float
    bg_type: str
    removal_method: str | None
    session_id: str
    # Cut path as normalised [x, y] points (0–1 relative to the border image)
    # plus the image pixel size, so the frontend can render an editable
    # overlay for the hand-draw fix tool.
    cutline_points: list[list[float]] = []
    img_w_px: int = 0
    img_h_px: int = 0


def _safe_presigned(key: str) -> str:
    try:
        return storage.presigned_get(key)
    except Exception:
        return ""


def _normalised_points(
    points_px: list, width_px: int, height_px: int
) -> list[list[float]]:
    """Convert pixel cut points to 0–1 normalised coords for the frontend."""
    if width_px <= 0 or height_px <= 0:
        return []
    return [[float(x) / width_px, float(y) / height_px] for x, y in points_px]


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
    filter_id: str = Form("none"),
    beautify_smooth: float = Form(0.0),
    beautify_eyes: float = Form(0.0),
    beautify_tone: float = Form(0.0),
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

    from backend.services.cutline_generator import FaceNotFoundError
    from backend.services.sticker_processor import process_sticker as do_process
    with _heavy_job_slot("process"):
        try:
            result = do_process(
                image_bytes=raw,
                removal_method=removal_method,
                border_width_mm=border_width_mm,
                bleed_mm=bleed_mm,
                cutline_mode=cutline_mode if cutline_mode in ("contour", "rectangle", "face") else "contour",
                cutline_precision=cutline_precision if cutline_precision in ("tight", "medium") else "medium",
                filter_id=filter_id,
                beautify_smooth=max(0.0, min(1.0, beautify_smooth)),
                beautify_eyes=max(0.0, min(1.0, beautify_eyes)),
                beautify_tone=max(0.0, min(1.0, beautify_tone)),
            )
        except FaceNotFoundError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))
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

    # Persist the original source image so the sticker is re-editable later
    # (allows re-running background removal with a different method).
    src_ct = file.content_type or "image/png"
    storage.put_bytes(f"{prefix}/source.png", raw, src_ct)
    storage.put_bytes(f"{prefix}/preview.png", result.preview_png, "image/png")
    storage.put_bytes(f"{prefix}/border.png", result.border_png, "image/png")
    if result.cutout_png:
        storage.put_bytes(f"{prefix}/cutout.png", result.cutout_png, "image/png")

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
        "work_dpi": result.work_dpi,
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
        cutout_url=_safe_presigned(f"{prefix}/cutout.png"),
        width_mm=result.width_mm,
        height_mm=result.height_mm,
        bg_type=result.bg_type,
        removal_method=result.removal_method,
        session_id=session_id,
        cutline_points=_normalised_points(
            result.cutline.points_px,
            result.cutline.width_px,
            result.cutline.height_px,
        ),
        img_w_px=result.cutline.width_px,
        img_h_px=result.cutline.height_px,
    )


class RegenerateRequest(BaseModel):
    session_id: str
    cutline_mode: str = "contour"
    cutline_precision: str = "medium"
    border_width_mm: float = 2.0
    bleed_mm: float = 3.0
    filter_id: str = "none"
    beautify_smooth: float = 0.0
    beautify_eyes: float = 0.0
    beautify_tone: float = 0.0


@router.post("/regenerate", response_model=ProcessResponse)
def regenerate_sticker(
    body: RegenerateRequest,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Re-run the cut line on an existing session's background-removed image.

    Lets the preview screen change precision / switch to a face sticker
    without re-uploading or re-charging for AI background removal.
    """
    user = _resolve_user(db, auth)
    ent = entitlements.for_user(user)
    if not ent.allows("sticker_editor"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Sticker editor not available on your plan")

    prefix = f"sticker-sessions/{user.id}/{body.session_id}"
    try:
        cutout = storage.get_bytes(f"{prefix}/cutout.png")
    except Exception:
        raise HTTPException(
            404,
            "Sticker session expired. Please re-upload to change the cut line.",
        )

    # Reuse the DPI the cutout was processed at (it's already resolution-capped)
    # so changing the cut line keeps the sticker the same physical size.
    import json
    work_dpi = 300.0
    try:
        meta = json.loads(storage.get_bytes(f"{prefix}/cutline.json").decode("utf-8"))
        work_dpi = float(meta.get("work_dpi", 300.0))
    except Exception:
        work_dpi = 300.0

    mode = body.cutline_mode if body.cutline_mode in ("contour", "rectangle", "face") else "contour"
    precision = body.cutline_precision if body.cutline_precision in ("tight", "medium") else "medium"

    from backend.services.cutline_generator import FaceNotFoundError
    from backend.services.sticker_processor import regenerate_cutline

    with _heavy_job_slot("process"):
        try:
            result = regenerate_cutline(
                cutout_bytes=cutout,
                border_width_mm=body.border_width_mm,
                bleed_mm=body.bleed_mm,
                dpi=work_dpi,
                cutline_mode=mode,
                cutline_precision=precision,
                filter_id=body.filter_id,
                beautify_smooth=max(0.0, min(1.0, body.beautify_smooth)),
                beautify_eyes=max(0.0, min(1.0, body.beautify_eyes)),
                beautify_tone=max(0.0, min(1.0, body.beautify_tone)),
            )
        except FaceNotFoundError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))
        except Exception as exc:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR, f"Regeneration failed: {exc}"
            )

    storage.put_bytes(f"{prefix}/preview.png", result.preview_png, "image/png")
    storage.put_bytes(f"{prefix}/border.png", result.border_png, "image/png")

    cutline_payload = {
        "points_px": [list(p) for p in result.cutline.points_px],
        "points_pt": [list(p) for p in result.cutline.points_pt],
        "width_px": result.cutline.width_px,
        "height_px": result.cutline.height_px,
        "width_pt": result.cutline.width_pt,
        "height_pt": result.cutline.height_pt,
        "width_mm": result.width_mm,
        "height_mm": result.height_mm,
        "work_dpi": result.work_dpi,
    }
    storage.put_bytes(
        f"{prefix}/cutline.json",
        json.dumps(cutline_payload).encode("utf-8"),
        "application/json",
    )

    return ProcessResponse(
        preview_url=storage.presigned_get(f"{prefix}/preview.png"),
        border_url=storage.presigned_get(f"{prefix}/border.png"),
        cutout_url=_safe_presigned(f"{prefix}/cutout.png"),
        width_mm=result.width_mm,
        height_mm=result.height_mm,
        bg_type=result.bg_type,
        removal_method=result.removal_method,
        session_id=body.session_id,
        cutline_points=_normalised_points(
            result.cutline.points_px,
            result.cutline.width_px,
            result.cutline.height_px,
        ),
        img_w_px=result.cutline.width_px,
        img_h_px=result.cutline.height_px,
    )


class AIStyleRequest(BaseModel):
    session_id: str
    style: str = "cartoon"
    custom_prompt: str | None = None
    border_width_mm: float = 2.0
    bleed_mm: float = 3.0
    cutline_mode: str = "contour"


def _fit_into(stylized_png: bytes, target_w: int, target_h: int) -> bytes:
    """Scale the AI image to fit inside (target_w, target_h) without
    distortion and centre it on a transparent canvas of exactly that size.

    Keeps the sticker's pixel space (and therefore physical mm size and
    cut-line coordinate system) identical to the original cutout."""
    src = Image.open(io.BytesIO(stylized_png)).convert("RGBA")
    if target_w <= 0 or target_h <= 0:
        out = io.BytesIO()
        src.save(out, format="PNG")
        return out.getvalue()
    scale = min(target_w / src.width, target_h / src.height)
    new_w = max(1, round(src.width * scale))
    new_h = max(1, round(src.height * scale))
    src = src.resize((new_w, new_h), Image.LANCZOS)
    canvas = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
    canvas.paste(src, ((target_w - new_w) // 2, (target_h - new_h) // 2), src)
    out = io.BytesIO()
    canvas.save(out, format="PNG")
    return out.getvalue()


@router.post("/ai-style", response_model=ProcessResponse)
def ai_style_sticker(
    body: AIStyleRequest,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Redraw the sticker subject in an AI illustration style (cartoon,
    pencil, etc.) using the user's own OpenAI key, then re-cut around it.

    The stylized image replaces the session cutout so subsequent tighten /
    filter / hand-edit operations work on the new artwork.
    """
    from backend.services import ai_stylize, secrets_store

    user = _resolve_user(db, auth)
    ent = entitlements.for_user(user)
    if not ent.allows("sticker_editor"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Sticker editor not available on your plan")

    if body.style == "custom":
        if not (body.custom_prompt or "").strip():
            raise HTTPException(400, "Enter a description for your custom AI style.")
    elif body.style not in ai_stylize.STYLE_PROMPTS:
        raise HTTPException(400, f"Unknown AI style: {body.style}")

    api_key = secrets_store.decrypt_value(user.openai_api_key_enc)
    if not api_key:
        raise HTTPException(
            400,
            "Add your OpenAI API key in Settings → Preferences to use AI styles.",
        )

    prefix = f"sticker-sessions/{user.id}/{body.session_id}"
    try:
        cutout = storage.get_bytes(f"{prefix}/cutout.png")
    except Exception:
        raise HTTPException(404, "Sticker session expired. Please re-upload.")

    import json
    work_dpi = 300.0
    try:
        meta = json.loads(storage.get_bytes(f"{prefix}/cutline.json").decode("utf-8"))
        work_dpi = float(meta.get("work_dpi", 300.0))
    except Exception:
        work_dpi = 300.0

    # Original cutout dimensions — we fit the AI result back into these so the
    # sticker keeps its size and coordinate space.
    try:
        orig = Image.open(io.BytesIO(cutout)).convert("RGBA")
        orig_w, orig_h = orig.size
    except Exception:
        orig_w, orig_h = 0, 0

    # The OpenAI call is network-bound (tens of seconds) — keep it OUT of the
    # CPU heavy-job slot so it doesn't block other stickers.
    try:
        stylized = ai_stylize.stylize_image(
            cutout, body.style, api_key, custom_prompt=body.custom_prompt
        )
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"AI style failed: {exc}")

    new_cutout = _fit_into(stylized, orig_w, orig_h)
    # Replace the session cutout so later edits build on the stylized art.
    storage.put_bytes(f"{prefix}/cutout.png", new_cutout, "image/png")

    mode = body.cutline_mode if body.cutline_mode in ("contour", "rectangle", "face") else "contour"

    from backend.services.cutline_generator import FaceNotFoundError
    from backend.services.sticker_processor import regenerate_cutline

    with _heavy_job_slot("process"):
        try:
            result = regenerate_cutline(
                cutout_bytes=new_cutout,
                border_width_mm=body.border_width_mm,
                bleed_mm=body.bleed_mm,
                dpi=work_dpi,
                cutline_mode=mode,
                cutline_precision="medium",
            )
        except FaceNotFoundError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))
        except Exception as exc:
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR, f"Cut line failed after AI style: {exc}"
            )

    storage.put_bytes(f"{prefix}/preview.png", result.preview_png, "image/png")
    storage.put_bytes(f"{prefix}/border.png", result.border_png, "image/png")

    cutline_payload = {
        "points_px": [list(p) for p in result.cutline.points_px],
        "points_pt": [list(p) for p in result.cutline.points_pt],
        "width_px": result.cutline.width_px,
        "height_px": result.cutline.height_px,
        "width_pt": result.cutline.width_pt,
        "height_pt": result.cutline.height_pt,
        "width_mm": result.width_mm,
        "height_mm": result.height_mm,
        "work_dpi": result.work_dpi,
    }
    storage.put_bytes(
        f"{prefix}/cutline.json",
        json.dumps(cutline_payload).encode("utf-8"),
        "application/json",
    )

    return ProcessResponse(
        preview_url=storage.presigned_get(f"{prefix}/preview.png"),
        border_url=storage.presigned_get(f"{prefix}/border.png"),
        cutout_url=_safe_presigned(f"{prefix}/cutout.png"),
        width_mm=result.width_mm,
        height_mm=result.height_mm,
        bg_type=result.bg_type,
        removal_method=result.removal_method,
        session_id=body.session_id,
        cutline_points=_normalised_points(
            result.cutline.points_px,
            result.cutline.width_px,
            result.cutline.height_px,
        ),
        img_w_px=result.cutline.width_px,
        img_h_px=result.cutline.height_px,
    )


class EditCutlineRequest(BaseModel):
    session_id: str
    # Closed polygon of the hand-edited cut path, normalised 0–1 relative to
    # the border image (same space `cutline_points` is returned in).
    points: list[list[float]]


@router.post("/edit-cutline", response_model=ProcessResponse)
def edit_cutline(
    body: EditCutlineRequest,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Apply a hand-edited cut path to an existing session.

    The frontend draw tool replaces a stretch of the cut line with a freehand
    stroke and posts the resulting polygon. We re-key it to pixel/point space,
    enforce a cutter-safe minimum corner radius, re-render the dashed preview
    and persist it so Save picks up the edited path.
    """
    user = _resolve_user(db, auth)
    ent = entitlements.for_user(user)
    if not ent.allows("sticker_editor"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Sticker editor not available on your plan")

    if len(body.points) < 3:
        raise HTTPException(400, "A cut path needs at least 3 points")

    prefix = f"sticker-sessions/{user.id}/{body.session_id}"
    import json
    try:
        border_png = storage.get_bytes(f"{prefix}/border.png")
        meta = json.loads(storage.get_bytes(f"{prefix}/cutline.json").decode("utf-8"))
    except Exception:
        raise HTTPException(
            404,
            "Sticker session expired. Please re-process before editing the cut line.",
        )

    width_px = int(meta["width_px"])
    height_px = int(meta["height_px"])
    width_pt = float(meta["width_pt"])
    height_pt = float(meta["height_pt"])
    width_mm = float(meta["width_mm"])
    height_mm = float(meta["height_mm"])

    # Normalised → pixel space, clamped inside the image.
    points_px = [
        (
            max(0.0, min(1.0, float(nx))) * width_px,
            max(0.0, min(1.0, float(ny))) * height_px,
        )
        for nx, ny in body.points
    ]

    from backend.services.cutline_generator import (
        CutlineResult,
        _chaikin_smooth,
        _enforce_min_corner_radius,
        _smooth_oscillating_regions,
    )

    dpi = width_px * 25.4 / width_mm if width_mm > 0 else 300
    # The freehand stroke is hand-drawn with a mouse, so smooth out the wobble
    # before it becomes a cut path: target oscillating runs, round corners with
    # Chaikin, then enforce a cutter-safe minimum radius so the knife never has
    # to pivot in place.
    try:
        points_px = _smooth_oscillating_regions(
            points_px, iterations=10, window=6, wiggle_threshold=0.3, strength=0.55
        )
        points_px = _chaikin_smooth(points_px, iterations=3)
        points_px = _enforce_min_corner_radius(points_px, dpi=int(dpi), min_radius_mm=1.0)
    except Exception:
        pass

    px_to_pt_x = width_pt / width_px if width_px else 0.0
    px_to_pt_y = height_pt / height_px if height_px else 0.0
    points_pt = [(x * px_to_pt_x, y * px_to_pt_y) for x, y in points_px]

    cutline = CutlineResult(
        points_px=[(float(x), float(y)) for x, y in points_px],
        points_pt=[(float(x), float(y)) for x, y in points_pt],
        width_px=width_px,
        height_px=height_px,
        width_pt=width_pt,
        height_pt=height_pt,
        border_image=border_png,
    )

    from backend.services.sticker_processor import _render_preview

    preview_png = _render_preview(cutline)
    storage.put_bytes(f"{prefix}/preview.png", preview_png, "image/png")

    cutline_payload = {
        "points_px": [list(p) for p in cutline.points_px],
        "points_pt": [list(p) for p in cutline.points_pt],
        "width_px": width_px,
        "height_px": height_px,
        "width_pt": width_pt,
        "height_pt": height_pt,
        "width_mm": width_mm,
        "height_mm": height_mm,
    }
    storage.put_bytes(
        f"{prefix}/cutline.json",
        json.dumps(cutline_payload).encode("utf-8"),
        "application/json",
    )

    return ProcessResponse(
        preview_url=storage.presigned_get(f"{prefix}/preview.png"),
        border_url=storage.presigned_get(f"{prefix}/border.png"),
        cutout_url=_safe_presigned(f"{prefix}/cutout.png"),
        width_mm=width_mm,
        height_mm=height_mm,
        bg_type="transparent",
        removal_method=None,
        session_id=body.session_id,
        cutline_points=_normalised_points(cutline.points_px, width_px, height_px),
        img_w_px=width_px,
        img_h_px=height_px,
    )


class ResumeResponse(BaseModel):
    """Everything the frontend needs to hydrate the sticker editor at the
    last saved state — cutout image, cut line geometry, and a fresh
    session_id that subsequent edits will operate on (we reuse the original
    session files so no data is duplicated)."""
    session_id: str
    cutout_url: str
    border_url: str
    preview_url: str
    source_url: str | None = None
    cutline_points: list[list[float]]
    img_w_px: int
    img_h_px: int
    width_mm: float
    height_mm: float
    work_dpi: float


@router.get("/resume/{asset_id}", response_model=ResumeResponse)
def resume_sticker(
    asset_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Resume editing a previously saved sticker. Returns presigned URLs for
    the session files so the frontend can hydrate the editor without
    re-processing."""
    from backend.models import Asset

    user = _resolve_user(db, auth)
    asset = (
        db.query(Asset)
        .filter(Asset.id == asset_id, Asset.user_id == user.id)
        .one_or_none()
    )
    if asset is None:
        raise HTTPException(404, "Asset not found")
    if not asset.sticker_session_prefix:
        raise HTTPException(
            400, "This asset was not created with the sticker editor or is not re-editable."
        )

    prefix = asset.sticker_session_prefix
    import json

    # Load cutline metadata
    try:
        cutline_raw = storage.get_bytes(f"{prefix}/cutline.json")
        cutline_payload = json.loads(cutline_raw.decode("utf-8"))
    except Exception:
        raise HTTPException(
            404,
            "Sticker session data is missing. The sticker may need to be re-created.",
        )

    # Verify the cutout still exists
    try:
        storage.get_bytes(f"{prefix}/cutout.png")
    except Exception:
        raise HTTPException(
            404, "Cutout image is missing from storage. The sticker cannot be resumed."
        )

    # Source image may not exist for stickers created before we started
    # persisting it — that's fine, the user just can't change bg removal method.
    source_url = _safe_presigned(f"{prefix}/source.png")

    cutline_points = _normalised_points(
        [tuple(p) for p in cutline_payload["points_px"]],
        int(cutline_payload["width_px"]),
        int(cutline_payload["height_px"]),
    )

    # The session_id is embedded in the prefix path
    # e.g. "sticker-sessions/{user_id}/{session_id}"
    parts = prefix.rstrip("/").split("/")
    session_id = parts[-1] if len(parts) >= 3 else str(uuid.uuid4())

    return ResumeResponse(
        session_id=session_id,
        cutout_url=_safe_presigned(f"{prefix}/cutout.png"),
        border_url=_safe_presigned(f"{prefix}/border.png"),
        preview_url=_safe_presigned(f"{prefix}/preview.png"),
        source_url=source_url,
        cutline_points=cutline_points,
        img_w_px=int(cutline_payload["width_px"]),
        img_h_px=int(cutline_payload["height_px"]),
        width_mm=float(cutline_payload["width_mm"]),
        height_mm=float(cutline_payload["height_mm"]),
        work_dpi=float(cutline_payload.get("work_dpi", 300.0)),
    )


class SaveRequest(BaseModel):
    session_id: str
    name: str = "Sticker"
    include_cut_contour: bool = True
    category_id: str | None = None


def _resolve_sticker_category(db: Session, user_id: uuid.UUID, category_id: str | None):
    """Resolve the catalogue category to save a sticker into.

    - If `category_id` is given, validate it belongs to the user.
    - Otherwise find-or-create a "Stickers" category so the asset always
      satisfies the `ck_assets_category_or_job` constraint.
    """
    from backend.models import AssetCategory

    if category_id:
        try:
            cat_uuid = uuid.UUID(category_id)
        except (ValueError, TypeError):
            raise HTTPException(400, "Invalid category id")
        cat = (
            db.query(AssetCategory)
            .filter(AssetCategory.id == cat_uuid, AssetCategory.user_id == user_id)
            .one_or_none()
        )
        if cat is None:
            raise HTTPException(404, "Category not found")
        return cat

    cat = (
        db.query(AssetCategory)
        .filter(AssetCategory.user_id == user_id, AssetCategory.name == "Stickers")
        .first()
    )
    if cat is None:
        cat = AssetCategory(user_id=user_id, name="Stickers")
        db.add(cat)
        db.flush()
    return cat


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

    category = _resolve_sticker_category(db, user.id, body.category_id)

    # Persist the custom cut line as normalised points (0..1, top-left) so the
    # Sheet Builder can draw/export the real contour instead of a rectangle.
    cut_contour_json: str | None = None
    if body.include_cut_contour:
        try:
            norm = _normalised_points(
                [tuple(p) for p in cutline_payload["points_px"]],
                int(cutline_payload["width_px"]),
                int(cutline_payload["height_px"]),
            )
            if len(norm) >= 3:
                cut_contour_json = json.dumps([list(p) for p in norm])
        except Exception:
            cut_contour_json = None

    asset_id = uuid.uuid4()
    r2_key = f"assets/{user.id}/{asset_id}.pdf"
    thumb_key = f"assets/{user.id}/{asset_id}_thumb.jpg"

    storage.put_bytes(r2_key, saved.pdf_bytes, "application/pdf")
    storage.put_bytes(thumb_key, saved.thumbnail_bytes, "image/jpeg")

    asset = Asset(
        id=asset_id,
        user_id=user.id,
        category_id=category.id,
        name=body.name,
        kind="pdf",
        width_pt=saved.width_pt,
        height_pt=saved.height_pt,
        r2_key=r2_key,
        thumbnail_r2_key=thumb_key,
        file_size=len(saved.pdf_bytes),
        cut_contour_json=cut_contour_json,
        sticker_session_prefix=prefix,
    )
    db.add(asset)
    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            f"Failed to save sticker asset: {exc}",
        )

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
