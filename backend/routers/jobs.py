import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from backend.audit import record
from backend.auth import AuthenticatedUser, get_current_user
from backend.database import get_db
from backend.models import Asset, CatalogueSubscription, AssetCategory, ColorProfile, Job, Output, Template, User
from backend.rate_limit import generate_burst_limit, generate_limit, limiter

log = logging.getLogger(__name__)
from backend.routers.templates import _resolve_user
from backend.schemas.asset import AssetOut
from backend.schemas.color_profile import (
    ColorProfileOut,
    ColorSwap,
    JobColorAttach,
    JobColorsResponse,
)
from backend.schemas.job import (
    FillRequest,
    GenerateOptions,
    JobCreate,
    JobOut,
    JobUpdate,
    QueueRequest,
)
from backend.schemas.output import OutputOut
from backend.services import (
    asset_pipeline,
    color_swap,
    cut_lines,
    entitlements,
    pdf_compositor,
    r2_cache,
    storage,
    storage_usage,
    telemetry,
)

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


def _preview_url_for(a: Asset) -> str | None:
    """Highest-fidelity preview the browser can render directly. SVGs get
    their original vector source (sharp at any zoom); everything else
    falls back to the thumbnail."""
    if a.kind == "svg" and a.r2_key_original:
        try:
            return storage.presigned_get(
                a.r2_key_original,
                expires_in=3600,
                content_type="image/svg+xml",
            )
        except Exception:
            return None
    return None


def _asset_to_out(a: Asset) -> AssetOut:
    thumb_url = None
    if a.thumbnail_r2_key:
        try:
            thumb_url = storage.presigned_get(a.thumbnail_r2_key, expires_in=3600)
        except Exception:
            thumb_url = None
    preview = _preview_url_for(a) or thumb_url
    return AssetOut(
        id=a.id,
        category_id=a.category_id,
        job_id=a.job_id,
        name=a.name,
        kind=a.kind,
        width_pt=a.width_pt,
        height_pt=a.height_pt,
        file_size=a.file_size,
        thumbnail_url=thumb_url,
        preview_url=preview,
        created_at=a.created_at,
        page_count=max(1, int(getattr(a, "page_count", 1) or 1)),
    )


def _accessible_assets(db: Session, user: User, asset_ids: set[uuid.UUID]) -> dict[uuid.UUID, Asset]:
    """Load assets by ID, allowing both owned assets and assets from
    subscribed official catalogues."""
    if not asset_ids:
        return {}

    subscribed_cat_ids = {
        row[0] for row in
        db.query(CatalogueSubscription.category_id)
        .filter(CatalogueSubscription.user_id == user.id)
        .all()
    }

    rows = (
        db.query(Asset)
        .filter(Asset.id.in_(asset_ids))
        .all()
    )

    result: dict[uuid.UUID, Asset] = {}
    for a in rows:
        if a.user_id == user.id:
            result[a.id] = a
        elif a.category_id in subscribed_cat_ids:
            cat = db.query(AssetCategory).filter(AssetCategory.id == a.category_id).first()
            if cat and (cat.is_official or cat.is_private_share):
                result[a.id] = a
    return result


def _purge_job_uploads(db: Session, job: Job) -> None:
    """Delete R2 storage for any job-attached assets. The DB rows themselves
    cascade-delete via the FK when the Job is deleted.

    R2 keys are reference-counted: an object key is only removed from
    storage if no OTHER Asset row (in any of the three key columns)
    still points at it. This is required because :func:`duplicate_job`
    re-uses R2 keys across cloned Asset rows (so duplicating a job
    doesn't bloat storage quotas) - without this guard, deleting either
    the source job or a duplicate would silently destroy the other's
    bytes.
    """
    uploads = db.query(Asset).filter(Asset.job_id == job.id).all()
    for a in uploads:
        for k in (a.r2_key, a.r2_key_original, a.thumbnail_r2_key):
            if not k:
                continue
            still_used = (
                db.query(Asset)
                .filter(
                    Asset.id != a.id,
                    or_(
                        Asset.r2_key == k,
                        Asset.r2_key_original == k,
                        Asset.thumbnail_r2_key == k,
                    ),
                )
                .limit(1)
                .first()
            )
            if still_used is not None:
                continue
            try:
                storage.delete(k)
            except Exception:
                pass


def _own_job(db: Session, user: User, job_id: uuid.UUID) -> Job:
    job = db.query(Job).filter(Job.id == job_id, Job.user_id == user.id).one_or_none()
    if job is None:
        raise HTTPException(404, "Job not found")
    return job


@router.get("", response_model=list[JobOut])
def list_jobs(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[Job]:
    user = _resolve_user(db, auth)
    return (
        db.query(Job)
        .filter(Job.user_id == user.id)
        .order_by(Job.created_at.desc())
        .all()
    )


@router.post("", response_model=JobOut, status_code=status.HTTP_201_CREATED)
def create_job(
    payload: JobCreate,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Job:
    user = _resolve_user(db, auth)
    tpl = db.query(Template).filter(
        Template.id == payload.template_id, Template.user_id == user.id
    ).one_or_none()
    if tpl is None:
        raise HTTPException(404, "Template not found")
    job = Job(
        user_id=user.id,
        template_id=payload.template_id,
        name=payload.name,
        slot_order=list(payload.slot_order),
        assignments={
            k: v.model_dump(mode="json") for k, v in payload.assignments.items()
        },
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


@router.get("/{job_id}", response_model=JobOut)
def get_job(
    job_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Job:
    user = _resolve_user(db, auth)
    return _own_job(db, user, job_id)


@router.patch("/{job_id}", response_model=JobOut)
def update_job(
    job_id: uuid.UUID,
    payload: JobUpdate,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Job:
    user = _resolve_user(db, auth)
    job = _own_job(db, user, job_id)
    if payload.name is not None:
        job.name = payload.name
    if payload.slot_order is not None:
        job.slot_order = list(payload.slot_order)
    if payload.assignments is not None:
        job.assignments = {
            k: v.model_dump(mode="json") for k, v in payload.assignments.items()
        }
    db.commit()
    db.refresh(job)
    return job


@router.delete("/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_job(
    job_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    user = _resolve_user(db, auth)
    job = _own_job(db, user, job_id)
    _purge_job_uploads(db, job)
    db.delete(job)
    db.commit()


@router.get("/{job_id}/uploads", response_model=list[AssetOut])
def list_job_uploads(
    job_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AssetOut]:
    user = _resolve_user(db, auth)
    job = _own_job(db, user, job_id)
    rows = (
        db.query(Asset)
        .filter(Asset.job_id == job.id, Asset.user_id == user.id)
        .order_by(Asset.created_at.asc())
        .all()
    )
    return [_asset_to_out(a) for a in rows]


@router.post("/{job_id}/uploads", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
async def upload_job_asset(
    job_id: uuid.UUID,
    file: UploadFile = File(...),
    name: str | None = Form(None),
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AssetOut:
    """Upload a file directly attached to this job (not the catalogue).
    These ephemeral assets are deleted when the job is deleted."""
    user = _resolve_user(db, auth)
    job = _own_job(db, user, job_id)

    ent = entitlements.for_user(user)
    if not ent.allows("pdf_export"):
        raise HTTPException(
            402,
            detail={
                "code": "plan_locked",
                "message": "Your trial has ended. Reactivate your account to upload artwork.",
            },
        )

    body = await file.read()
    if not body:
        raise HTTPException(400, "Empty upload")

    size_mb = len(body) / (1024 * 1024)
    cap_mb = ent.quota("asset_size_mb_max")
    if cap_mb is not None and size_mb > cap_mb:
        raise HTTPException(
            402,
            detail={
                "code": "quota_exceeded",
                "limit": "asset_size_mb_max",
                "cap": cap_mb,
                "message": (
                    f"File is {size_mb:.1f} MB, which exceeds your {cap_mb} MB "
                    "per-asset limit. Upgrade to upload larger files."
                ),
            },
        )

    # Total-storage ceiling. Catalogue + job uploads share the same pool;
    # this stops a user from filling their quota by attaching dozens of
    # ephemeral files to a single job.
    storage_cap_mb = ent.quota("storage_mb_max")
    if storage_usage.would_exceed_cap(db, user.id, len(body), storage_cap_mb):
        used_mb = storage_usage.current_storage_mb(db, user.id)
        raise HTTPException(
            402,
            detail={
                "code": "quota_exceeded",
                "limit": "storage_mb_max",
                "cap": storage_cap_mb,
                "message": (
                    f"This upload would push you over your {storage_cap_mb} MB "
                    f"storage cap (currently using {used_mb:.0f} MB). "
                    "Delete unused artwork or upgrade for more space."
                ),
            },
        )

    try:
        norm = asset_pipeline.normalise(body, file.filename or "asset", file.content_type)
    except ValueError as exc:
        raise HTTPException(415, str(exc))
    except RuntimeError as exc:
        raise HTTPException(503, str(exc))

    asset_id = uuid.uuid4()
    base = f"users/{user.id}/jobs/{job.id}/uploads/{asset_id}"
    key_pdf = f"{base}/normalised.pdf"
    key_thumb = f"{base}/thumb.jpg"
    key_orig = f"{base}/original.{norm.kind}" if norm.original_kept else None

    try:
        storage.put_bytes(key_pdf, norm.pdf_bytes, content_type="application/pdf")
        if norm.thumbnail_jpg:
            storage.put_bytes(key_thumb, norm.thumbnail_jpg, content_type="image/jpeg")
        if key_orig:
            ct = file.content_type or "application/octet-stream"
            if norm.kind == "svg":
                ct = "image/svg+xml"
            elif norm.kind == "png":
                ct = "image/png"
            elif norm.kind == "jpg":
                ct = "image/jpeg"
            storage.put_bytes(
                key_orig,
                norm.original_bytes if norm.original_bytes is not None else body,
                content_type=ct,
            )
    except storage.StorageNotConfigured as exc:
        raise HTTPException(503, str(exc))

    # Pre-warm local disk cache so generation doesn't need to re-download
    r2_cache.put(key_pdf, norm.pdf_bytes)

    # Generate placement-optimised PDF (300 DPI) for faster composition
    key_placement = None
    placement_bytes = asset_pipeline.generate_placement_pdf(norm.pdf_bytes)
    if placement_bytes:
        key_placement = f"{base}/placement.pdf"
        try:
            storage.put_bytes(key_placement, placement_bytes, content_type="application/pdf")
        except Exception:
            key_placement = None

    asset = Asset(
        id=asset_id,
        user_id=user.id,
        category_id=None,
        job_id=job.id,
        name=name or file.filename or "Untitled",
        kind=norm.kind,
        r2_key=key_pdf,
        r2_key_original=key_orig,
        thumbnail_r2_key=key_thumb if norm.thumbnail_jpg else None,
        placement_r2_key=key_placement,
        width_pt=norm.width_pt,
        height_pt=norm.height_pt,
        file_size=len(norm.pdf_bytes),
        page_count=norm.page_count,
    )
    db.add(asset)
    db.commit()
    db.refresh(asset)
    return _asset_to_out(asset)


# ---------------------------------------------------------------------------
# Bulk optimise large assets (rasterise to 600 DPI PNG)
# ---------------------------------------------------------------------------

class OptimiseResult(BaseModel):
    optimised: int
    skipped: int
    total_before_bytes: int
    total_after_bytes: int


@router.post("/{job_id}/optimise-assets", response_model=OptimiseResult)
def optimise_job_assets(
    job_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> OptimiseResult:
    """Force-rasterise all large PDF assets in a job to 600 DPI PNGs.

    Any PDF over 2MB is converted — including vectors. The user has
    explicitly chosen speed over infinite-resolution vector fidelity.
    The original R2 file is replaced with the optimised version.
    """
    from concurrent.futures import ThreadPoolExecutor

    user = _resolve_user(db, auth)
    job = _own_job(db, user, job_id)

    assets = (
        db.query(Asset)
        .filter(Asset.job_id == job.id, Asset.user_id == user.id)
        .all()
    )

    # Collect asset info then close the DB session so other requests aren't blocked
    asset_info = [
        {"id": a.id, "r2_key": a.r2_key, "file_size": a.file_size or 0}
        for a in assets
        if a.r2_key and (a.file_size or 0) >= 2_000_000
    ]
    skipped = len(assets) - len(asset_info)
    db.close()

    # Rasterise in parallel (CPU + I/O heavy, no DB needed)
    def _process(info: dict) -> dict | None:
        try:
            source_bytes = r2_cache.get_bytes(info["r2_key"])
        except Exception:
            return None

        compressed = asset_pipeline.force_rasterise(source_bytes)
        if compressed is source_bytes or len(compressed) >= len(source_bytes):
            return None

        storage.put_bytes(info["r2_key"], compressed, content_type="application/pdf")
        r2_cache.put(info["r2_key"], compressed)
        return {
            "id": info["id"],
            "before": len(source_bytes),
            "after": len(compressed),
        }

    results = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(_process, asset_info))

    # Re-open DB to update file sizes (quick operation)
    successful = [r for r in results if r is not None]
    skipped += sum(1 for r in results if r is None)

    if successful:
        for s in successful:
            asset = db.query(Asset).get(s["id"])
            if asset:
                asset.file_size = s["after"]
                asset.placement_r2_key = None
        job_row = db.query(Job).get(job.id)
        if job_row:
            job_row.optimised_at = datetime.now(timezone.utc)
        db.commit()

    total_before = sum(s["before"] for s in successful)
    total_after = sum(s["after"] for s in successful)

    return OptimiseResult(
        optimised=len(successful),
        skipped=skipped,
        total_before_bytes=total_before,
        total_after_bytes=total_after,
    )


@router.delete("/{job_id}/uploads/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_job_upload(
    job_id: uuid.UUID,
    asset_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    user = _resolve_user(db, auth)
    job = _own_job(db, user, job_id)
    asset = (
        db.query(Asset)
        .filter(Asset.id == asset_id, Asset.user_id == user.id, Asset.job_id == job.id)
        .one_or_none()
    )
    if asset is None:
        raise HTTPException(404, "Upload not found")
    for k in (asset.r2_key, asset.r2_key_original, asset.thumbnail_r2_key):
        if k:
            try:
                storage.delete(k)
            except Exception:
                pass
    db.delete(asset)
    db.commit()


@router.post("/{job_id}/queue", response_model=JobOut)
def apply_queue(
    job_id: uuid.UUID,
    payload: QueueRequest,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Job:
    """Replace `assignments` by walking `slot_order` and applying the queue in
    order. The first item fills the first N slots, the second fills the next M,
    etc. Surplus quantity is silently dropped."""
    user = _resolve_user(db, auth)
    job = _own_job(db, user, job_id)

    asset_ids = {item.asset_id for item in payload.queue}
    if asset_ids:
        owned = _accessible_assets(db, user, asset_ids)
        missing = asset_ids - owned.keys()
        if missing:
            raise HTTPException(404, f"Asset not found: {next(iter(missing))}")
    else:
        owned = {}

    total_requested = sum(item.quantity for item in payload.queue)
    assignments: dict[str, dict] = {}
    cursor = 0
    slot_order = list(job.slot_order or [])
    for item in payload.queue:
        asset = owned.get(item.asset_id)
        if asset is None:
            continue
        rot = ((item.rotation_deg or 0) % 360 + 360) % 360
        for _ in range(item.quantity):
            if cursor >= len(slot_order):
                break
            page_index = max(0, int(item.page_index or 0))
            # Clamp to actual asset page_count so a stale picker can't
            # write an out-of-range index that 500s at compose time.
            pc = max(1, int(getattr(asset, "page_count", 1) or 1))
            if page_index >= pc:
                page_index = 0
            assignments[str(slot_order[cursor])] = {
                "asset_id": str(asset.id),
                "asset_kind": asset.kind,
                "asset_name": asset.name,
                "rotation_deg": rot,
                "fit_mode": item.fit_mode or "contain",
                "x_mm": float(item.x_mm or 0.0),
                "y_mm": float(item.y_mm or 0.0),
                "w_mm": item.w_mm,
                "h_mm": item.h_mm,
                "filter_id": item.filter_id or "none",
                "safe_crop": bool(item.safe_crop),
                "page_index": page_index,
            }
            cursor += 1
        if cursor >= len(slot_order):
            break

    dropped = total_requested - cursor
    if dropped > 0:
        log.warning(
            "Queue overflow: job %s (user %s) tried to place %d items but template only has %d slots — %d dropped",
            job.id, user.id, total_requested, len(slot_order), dropped,
        )

    job.assignments = assignments
    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        log.error(
            "Failed to save queue for job %s (user %s, %d assignments): %s",
            job.id, user.id, len(assignments), exc,
        )
        raise HTTPException(500, detail={
            "code": "save_failed",
            "message": (
                f"Failed to save your layout ({len(assignments)} placements). "
                "This has been logged — please try again or contact support."
            ),
        })
    db.refresh(job)

    if dropped > 0:
        from fastapi.responses import JSONResponse
        from backend.schemas.job import JobOut as _JobOut
        job_data = _JobOut.model_validate(job).model_dump(mode="json")
        job_data["_warning"] = (
            f"Only {len(slot_order)} slots available on this template — "
            f"{dropped} item(s) could not be placed. "
            f"Consider using a larger template or splitting into multiple jobs."
        )
        return JSONResponse(content=job_data)

    # Pre-warm cache in background for any assets not already cached
    asset_ids_to_warm = {a.get("asset_id") for a in assignments.values() if a.get("asset_id")}
    if asset_ids_to_warm:
        warm_assets = db.query(Asset).filter(Asset.id.in_(asset_ids_to_warm)).all()
        warm_keys = [a.r2_key for a in warm_assets if a.r2_key]
        if warm_keys:
            import threading
            from concurrent.futures import ThreadPoolExecutor

            def _warm(keys):
                def _fetch(k):
                    try:
                        r2_cache.get_bytes(k)
                    except Exception:
                        pass
                with ThreadPoolExecutor(max_workers=8) as pool:
                    pool.map(_fetch, keys)

            threading.Thread(target=_warm, args=(warm_keys,), daemon=True).start()

    return job


@router.post("/{job_id}/fill", response_model=JobOut)
def fill_job(
    job_id: uuid.UUID,
    payload: FillRequest,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Job:
    """Drop `quantity` copies of `asset_id` into the next empty slots in
    `slot_order`. Returns the updated job with new assignments.
    """
    user = _resolve_user(db, auth)
    job = _own_job(db, user, job_id)
    accessible = _accessible_assets(db, user, {payload.asset_id})
    asset = accessible.get(payload.asset_id)
    if asset is None:
        raise HTTPException(404, "Asset not found")

    assignments = dict(job.assignments or {})
    placed = 0
    for shape_index in job.slot_order:
        if placed >= payload.quantity:
            break
        key = str(shape_index)
        if key in assignments:
            continue
        assignments[key] = {
            "asset_id": str(asset.id),
            "asset_kind": asset.kind,
            "asset_name": asset.name,
        }
        placed += 1

    job.assignments = assignments
    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        log.error(
            "Failed to save fill for job %s (user %s, asset %s, placed %d): %s",
            job.id, user.id, payload.asset_id, placed, exc,
        )
        raise HTTPException(500, detail={
            "code": "save_failed",
            "message": "Failed to save your placement. This has been logged — please try again.",
        })
    db.refresh(job)
    return job


def _remap_assignment_asset_ids(
    assignments: dict | None,
    asset_id_map: dict[str, str],
) -> dict:
    """Return a copy of ``assignments`` with any ``asset_id`` that appears
    in ``asset_id_map`` rewritten to its mapped value. Used by
    :func:`duplicate_job` to redirect the duplicated job's slot
    assignments away from the source job's uploaded asset rows and onto
    the cloned-and-attached asset rows owned by the new job.

    Catalogue assignments (asset ids that aren't keys in the map) are
    preserved as-is - those are user-level shared assets, not per-job
    uploads, so the duplicate is meant to keep pointing at the same
    underlying row.
    """
    out: dict = {}
    for slot_key, asg in (assignments or {}).items():
        asg_copy = dict(asg)
        old_aid = str(asg_copy.get("asset_id") or "")
        if old_aid and old_aid in asset_id_map:
            asg_copy["asset_id"] = asset_id_map[old_aid]
        out[slot_key] = asg_copy
    return out


@router.post("/{job_id}/duplicate", response_model=JobOut, status_code=status.HTTP_201_CREATED)
def duplicate_job(
    job_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Job:
    user = _resolve_user(db, auth)
    src = _own_job(db, user, job_id)

    # Build the new Job shell first; assignments are filled in below
    # once we know the cloned-asset id mapping. Without this two-step
    # the duplicated job's assignments would still reference the source
    # job's uploaded Asset rows - and JobFiller's loader resolves
    # uploads via `listJobUploads(new_job.id)`, which only returns
    # assets tagged with the *new* job_id. That mismatch is why
    # pre-fix duplicates opened with all slots empty.
    copy = Job(
        user_id=user.id,
        template_id=src.template_id,
        name=f"{src.name} (copy)",
        slot_order=list(src.slot_order or []),
        assignments={},
        color_profile_id=src.color_profile_id,
        color_swaps_draft=list(src.color_swaps_draft or []) or None,
    )
    db.add(copy)
    db.flush()  # need copy.id to attach cloned assets

    # Clone the source job's uploaded assets so the duplicate is fully
    # independent (deleting one job doesn't break the other's artwork).
    # We REUSE the R2 storage keys to avoid re-uploading bytes and
    # double-counting against the user's storage quota; the cloned
    # row's `file_size` is set to 0 so only the original counts toward
    # the quota meter. `_purge_job_uploads` reference-counts those
    # keys before calling `storage.delete`, so this sharing is safe
    # under deletion of either job.
    src_uploads = (
        db.query(Asset)
        .filter(Asset.job_id == src.id, Asset.user_id == user.id)
        .all()
    )
    asset_id_map: dict[str, str] = {}
    for a in src_uploads:
        clone = Asset(
            user_id=user.id,
            category_id=None,
            job_id=copy.id,
            name=a.name,
            kind=a.kind,
            r2_key=a.r2_key,
            r2_key_original=a.r2_key_original,
            thumbnail_r2_key=a.thumbnail_r2_key,
            width_pt=a.width_pt,
            height_pt=a.height_pt,
            # Bytes are shared with the source asset row; only the
            # original row contributes to the storage-usage SUM so
            # the quota meter stays honest. The compositor reads
            # from `r2_key`, not `file_size`, so the clone is fully
            # functional for printing.
            file_size=0,
        )
        db.add(clone)
        db.flush()
        asset_id_map[str(a.id)] = str(clone.id)

    copy.assignments = _remap_assignment_asset_ids(
        dict(src.assignments or {}), asset_id_map
    )
    db.commit()
    db.refresh(copy)
    record(db, user, "job.duplicate", target_type="job", target_id=copy.id, payload={"src_id": str(src.id)})
    return copy


# ---------------------------------------------------------------------------
# Colour swap endpoints
# ---------------------------------------------------------------------------


def _hex_to_rgb_tuple(hex_str: str | None, fallback=(255, 0, 255)) -> tuple[int, int, int]:
    """Parse '#RRGGBB' (or 'RRGGBB') → (r, g, b); fallback on anything odd."""
    if not hex_str:
        return fallback
    s = hex_str.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if len(s) != 6:
        return fallback
    try:
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except ValueError:
        return fallback


# Built-in spot presets, mirrored from the Sheet Builder picker so a job
# resolves the same names even when the user has no saved library yet.
_BUILTIN_SPOTS: dict[str, tuple[int, int, int]] = {
    "CutContour": (139, 92, 246),
    "Score": (0, 0, 255),
    "Through-cut": (255, 0, 255),
}


def _resolve_spot(
    db: Session, user: User, value: str | None
) -> tuple[str | None, tuple[int, int, int]]:
    """Resolve a Sheet-Builder-style spot value into ``(name, rgb)``.

    ``value`` is either a spot **name** (matched against the user's
    `spot_colours` library, then the built-in presets) or a ``#RRGGBB``
    hex (a custom colour, no named Separation). Returns ``name=None`` for a
    pure custom colour."""
    if not value:
        return None, (0, 0, 0)
    if value.startswith("#"):
        return None, _hex_to_rgb_tuple(value)

    from backend.models import SpotColour

    row = (
        db.query(SpotColour)
        .filter(SpotColour.name == value, SpotColour.user_id == user.id)
        .one_or_none()
    )
    if row is not None:
        return row.name, _hex_to_rgb_tuple(row.display_color)
    if value in _BUILTIN_SPOTS:
        return value, _BUILTIN_SPOTS[value]
    # Unknown name — still honour it as a Separation so the RIP can match.
    return value, (255, 0, 255)


def _resolve_cut_line_spec(
    db: Session, user: User, opts: GenerateOptions
) -> cut_lines.CutLineSpec:
    """Pick which spot colour drives the cut layer, from the Sheet-Builder
    style picker value (``cut_line_spot_color``).

    A spot **name** becomes the PDF Separation name (so VersaWorks/Summa
    pick it up as a cut plate) with its colour as the RGB alternate. A
    custom ``#RRGGBB`` hex still cuts under a 'CutContour' Separation so
    every RIP keeps a named cut plate. With no selection we fall back to a
    standard 'CutContour' magenta so generation never fails.
    """
    name, rgb = _resolve_spot(db, user, opts.cut_line_spot_color)
    return cut_lines.CutLineSpec(spot_name=name or "CutContour", rgb=rgb)


def _resolve_active_swaps(db: Session, job: Job) -> list[dict]:
    """Effective swap list for a job: profile (if attached) overlaid by
    the job's draft (draft entries win on identical source)."""
    base: list[dict] = []
    if job.color_profile_id is not None:
        prof = db.query(ColorProfile).filter(
            ColorProfile.id == job.color_profile_id
        ).one_or_none()
        if prof is not None:
            base = list(prof.swaps or [])
    draft = list(job.color_swaps_draft or [])
    if not draft:
        return base
    # Overlay: draft entries replace base entries with the same source.
    by_source: dict[tuple, dict] = {}
    for s in base:
        try:
            by_source[tuple(s["source"])] = s
        except Exception:
            continue
    for s in draft:
        try:
            by_source[tuple(s["source"])] = s
        except Exception:
            continue
    return list(by_source.values())


@router.get("/{job_id}/colors", response_model=JobColorsResponse)
def get_job_colors(
    job_id: uuid.UUID,
    detect: bool = True,
    asset_id: list[uuid.UUID] = Query(default=[]),
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobColorsResponse:
    """Return the job's current colour state plus (optionally) every
    distinct RGB triple detected in the relevant assets.

    Detection source: if explicit `asset_id`s are passed (the live queue
    on the fill page, which may not be saved yet) we scan those; otherwise
    we fall back to the assets in the job's saved `assignments`. Detection
    is on by default; disable with `?detect=false`."""
    user = _resolve_user(db, auth)
    job = _own_job(db, user, job_id)

    detected: list[tuple[int, int, int]] = []
    if detect:
        seen: set[tuple[int, int, int]] = set()
        asset_ids: set[uuid.UUID] = set(asset_id)
        if not asset_ids:
            for assignment in (job.assignments or {}).values():
                aid = assignment.get("asset_id")
                if aid:
                    try:
                        asset_ids.add(uuid.UUID(aid))
                    except ValueError:
                        continue
        if asset_ids:
            assets = (
                db.query(Asset)
                .filter(Asset.id.in_(asset_ids), Asset.user_id == user.id)
                .all()
            )
            for a in assets:
                try:
                    pdf_bytes = storage.get_bytes(a.r2_key)
                except Exception:
                    continue
                for rgb in color_swap.detect(pdf_bytes):
                    seen.add(rgb)
        detected = sorted(seen)

    profile_out: ColorProfileOut | None = None
    if job.color_profile_id is not None:
        prof = db.query(ColorProfile).filter(
            ColorProfile.id == job.color_profile_id,
            ColorProfile.user_id == user.id,
        ).one_or_none()
        if prof is not None:
            profile_out = ColorProfileOut.model_validate(prof)

    return JobColorsResponse(
        detected=detected,
        color_profile_id=job.color_profile_id,
        color_swaps_draft=[
            ColorSwap.model_validate(s) for s in (job.color_swaps_draft or [])
        ],
        profile=profile_out,
    )


@router.patch("/{job_id}/colors", response_model=JobOut)
def update_job_colors(
    job_id: uuid.UUID,
    payload: JobColorAttach,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Job:
    """Attach/detach a saved profile and/or replace the draft swap
    list. Both fields are independent so the UI can do them together
    or separately."""
    user = _resolve_user(db, auth)
    job = _own_job(db, user, job_id)

    if payload.clear_profile:
        job.color_profile_id = None
    elif payload.color_profile_id is not None:
        # Verify the profile exists and is owned by this user.
        prof = (
            db.query(ColorProfile)
            .filter(
                ColorProfile.id == payload.color_profile_id,
                ColorProfile.user_id == user.id,
            )
            .one_or_none()
        )
        if prof is None:
            raise HTTPException(404, "Color profile not found")
        job.color_profile_id = prof.id

    if payload.clear_draft:
        job.color_swaps_draft = None
    elif payload.color_swaps_draft is not None:
        job.color_swaps_draft = [
            s.model_dump(mode="json") for s in payload.color_swaps_draft
        ] or None

    db.commit()
    db.refresh(job)
    return job


# ---------------------------------------------------------------------------
# Generation info (pre-flight size check)
# ---------------------------------------------------------------------------

class GenerationInfo(BaseModel):
    total_asset_bytes: int
    threshold_bytes: int
    compression_recommended: bool


@router.get("/{job_id}/generation-info", response_model=GenerationInfo)
def get_generation_info(
    job_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> GenerationInfo:
    from backend.services import generation_settings

    user = _resolve_user(auth, db)
    job = db.query(Job).filter(Job.id == job_id, Job.user_id == user.id).one_or_none()
    if job is None:
        raise HTTPException(404, "Job not found")

    all_asset_ids = set()
    for assignment in (job.assignments or {}).values():
        aid = assignment.get("asset_id")
        if aid:
            all_asset_ids.add(uuid.UUID(aid))

    total_bytes = 0
    if all_asset_ids:
        assets = db.query(Asset).filter(Asset.id.in_(all_asset_ids)).all()
        total_bytes = sum(a.file_size or 0 for a in assets)

    threshold_mb = generation_settings.get_compression_threshold_mb()
    threshold_bytes = threshold_mb * 1024 * 1024

    return GenerationInfo(
        total_asset_bytes=total_bytes,
        threshold_bytes=threshold_bytes,
        compression_recommended=total_bytes > threshold_bytes,
    )


@router.post("/{job_id}/generate", response_model=OutputOut, status_code=status.HTTP_201_CREATED)
@limiter.limit(generate_burst_limit())
@limiter.limit(generate_limit())
def generate_output(
    request: Request,
    job_id: uuid.UUID,
    options: GenerateOptions | None = None,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Output:
    opts = options or GenerateOptions()
    user = _resolve_user(db, auth)
    request.state.auth_user = auth

    ent = entitlements.for_user(user)
    if not ent.allows("pdf_export"):
        raise HTTPException(
            402,
            detail={
                "code": "plan_locked",
                "message": "Your trial has ended. Reactivate your account to generate PDFs.",
            },
        )

    # Check monthly export quota for Starter tier
    from datetime import datetime, timezone
    from sqlalchemy import func, extract
    now = datetime.now(timezone.utc)
    monthly_exports = (
        db.query(func.count())
        .select_from(Output)
        .filter(
            Output.user_id == user.id,
            extract("year", Output.created_at) == now.year,
            extract("month", Output.created_at) == now.month,
        )
        .scalar()
    ) or 0
    if not ent.under_quota("exports_per_month", monthly_exports):
        raise HTTPException(
            402,
            detail={
                "code": "quota_exceeded",
                "limit": "exports_per_month",
                "cap": ent.quota("exports_per_month"),
                "message": f"You've used all {ent.quota('exports_per_month')} exports this month. Upgrade to Pro for unlimited PDF generation.",
            },
        )

    job = _own_job(db, user, job_id)
    tpl = db.query(Template).filter(Template.id == job.template_id).one()

    # Count unique assets to decide if we should run async
    all_asset_ids = set()
    for assignment in (job.assignments or {}).values():
        aid = assignment.get("asset_id")
        if aid:
            all_asset_ids.add(uuid.UUID(aid))

    ASYNC_THRESHOLD = 20
    if len(all_asset_ids) > ASYNC_THRESHOLD:
        return _generate_async(db, user, job, tpl, opts)

    return _generate_sync(db, user, job, tpl, opts)

def _generate_sync(db: Session, user, job, tpl, opts: "GenerateOptions") -> Output:
    """Synchronous PDF generation for small jobs (under ASYNC_THRESHOLD unique assets)."""
    try:
        template_bytes = r2_cache.get_bytes(tpl.r2_key)
    except storage.StorageNotConfigured as exc:
        raise HTTPException(503, str(exc))

    asset_pdfs: dict[int, bytes] = {}
    slot_transforms: dict[int, pdf_compositor.SlotTransform] = {}

    all_asset_ids = set()
    for assignment in (job.assignments or {}).values():
        aid = assignment.get("asset_id")
        if aid:
            all_asset_ids.add(uuid.UUID(aid))
    accessible = _accessible_assets(db, user, all_asset_ids) if all_asset_ids else {}

    from concurrent.futures import ThreadPoolExecutor

    mm_to_pt = 72.0 / 25.4
    # Deduplicate downloads: map asset_id -> list of slot_keys
    asset_id_to_slots: dict[str, list[str]] = {}
    for slot_key, assignment in (job.assignments or {}).items():
        asset_id = assignment.get("asset_id")
        if not asset_id:
            continue
        asset = accessible.get(uuid.UUID(asset_id))
        if asset is None:
            continue
        asset_id_to_slots.setdefault(asset_id, []).append(slot_key)
        slot_transforms[int(slot_key)] = pdf_compositor.SlotTransform(
            rotation_deg=int(assignment.get("rotation_deg") or 0),
            fit_mode=str(assignment.get("fit_mode") or "contain"),
            x_pt=float(assignment.get("x_mm") or 0.0) * mm_to_pt,
            y_pt=float(assignment.get("y_mm") or 0.0) * mm_to_pt,
            w_pt=(float(assignment["w_mm"]) * mm_to_pt) if assignment.get("w_mm") else None,
            h_pt=(float(assignment["h_mm"]) * mm_to_pt) if assignment.get("h_mm") else None,
            filter_id=str(assignment.get("filter_id") or "none"),
            safe_crop=bool(assignment.get("safe_crop")),
            page_index=int(assignment.get("page_index") or 0),
        )

    # Parallel download unique assets from R2
    # Skip placement PDFs if colour swaps are active (swaps need vector data)
    active_swaps = _resolve_active_swaps(db, job)
    has_color_swaps = bool(active_swaps)
    should_compress = opts.compress and not has_color_swaps

    def _fetch_asset(asset_id: str) -> tuple[str, bytes]:
        asset = accessible[uuid.UUID(asset_id)]
        if has_color_swaps:
            r2_key = asset.r2_key
        else:
            r2_key = asset.placement_r2_key or asset.r2_key
        if should_compress:
            return asset_id, r2_cache.get_compressed(
                r2_key, asset_pipeline.compress_for_generation
            )
        return asset_id, r2_cache.get_bytes(r2_key)

    unique_ids = list(asset_id_to_slots.keys())
    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            fetched = dict(pool.map(_fetch_asset, unique_ids))
    except Exception as exc:
        log.error("Failed to load assets for job %s: %s", job.id, exc)
        raise HTTPException(500, detail={
            "code": "asset_load_failed",
            "message": "Could not load one or more artworks. They may have been deleted or are temporarily unavailable.",
        })

    for asset_id, slot_keys in asset_id_to_slots.items():
        pdf_bytes = fetched[asset_id]
        for sk in slot_keys:
            asset_pdfs[int(sk)] = pdf_bytes

    mm_to_pt = 72.0 / 25.4
    bleed_pt = float(tpl.bleed_mm or 0.0) * mm_to_pt
    safe_pt = float(tpl.safe_mm or 0.0) * mm_to_pt
    enriched_shapes = [
        {**s, "bleed_pt": bleed_pt, "safe_pt": safe_pt} for s in tpl.shapes
    ]

    cut_line_spec = _resolve_cut_line_spec(db, user, opts) if opts.include_cut_lines else None

    try:
        sheet = pdf_compositor.composite(
            template_pdf=template_bytes,
            slot_shapes=enriched_shapes,
            asset_pdfs=asset_pdfs,
            slot_transforms=slot_transforms,
            positions_layer=tpl.positions_layer,
            color_swaps=active_swaps,
            cut_line_spec=cut_line_spec,
        )
    except pdf_compositor.CompositorError as exc:
        log.error(
            "PDF composition failed for job %s (user %s, template %s, %d assets): %s",
            job.id, user.id, tpl.id, len(asset_pdfs), exc,
        )
        raise HTTPException(500, detail={
            "code": "composition_failed",
            "message": "Something went wrong generating your PDF. This has been logged and we'll look into it.",
            "detail": str(exc),
        })
    except MemoryError:
        log.error(
            "Out of memory compositing job %s (user %s, %d unique assets, template %s)",
            job.id, user.id, len(asset_pdfs), tpl.id,
        )
        raise HTTPException(500, detail={
            "code": "too_many_assets",
            "message": (
                f"This job has {len(asset_pdfs)} unique artworks which is too heavy to process in one go. "
                "Try splitting into smaller batches (e.g. two sheets of 27 instead of one sheet of 54)."
            ),
        })
    except Exception as exc:
        log.exception(
            "Unexpected error compositing job %s (user %s, %d assets, template %s)",
            job.id, user.id, len(asset_pdfs), tpl.id,
        )
        raise HTTPException(500, detail={
            "code": "generation_error",
            "message": "PDF generation failed unexpectedly. This has been logged and we'll investigate.",
            "ref": f"job:{job.id}",
        })

    output_bytes = sheet.pdf_bytes
    if tpl.registration_type:
        from backend.services import job_registration

        _, mark_rgb255 = _resolve_spot(db, user, opts.mark_spot_color)
        mark_rgb = tuple(c / 255.0 for c in mark_rgb255)
        try:
            output_bytes = job_registration.add_registration_marks(
                output_bytes,
                tpl.registration_type,
                mark_offset_mm=float(tpl.mark_offset_mm or 5.0),
                max_zone_length_mm=tpl.max_zone_length_mm,
                mark_rgb=mark_rgb,
            )
        except Exception as exc:
            log.error(
                "Registration marks failed for job %s (type=%s): %s",
                job.id, tpl.registration_type, exc,
            )
            raise HTTPException(500, detail={
                "code": "registration_marks_failed",
                "message": "Failed to add registration marks to your PDF. The export has been cancelled. This has been logged.",
                "ref": f"job:{job.id}",
            })

    output_id = uuid.uuid4()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    name = f"{job.name} — {timestamp}.pdf"
    r2_key = f"users/{user.id}/outputs/{output_id}.pdf"
    storage.put_bytes(r2_key, output_bytes, content_type="application/pdf")

    out = Output(
        id=output_id,
        user_id=user.id,
        job_id=job.id,
        name=name,
        r2_key=r2_key,
        file_size=len(output_bytes),
        slots_filled=sheet.slots_filled,
        slots_total=sheet.slots_total,
        status="ready",
    )
    db.add(out)
    db.commit()
    db.refresh(out)
    record(
        db,
        user,
        "output.generate",
        target_type="output",
        target_id=out.id,
        payload={
            "job_id": str(job.id),
            "template_id": str(tpl.id),
            "slots_filled": sheet.slots_filled,
            "slots_total": sheet.slots_total,
            "file_size": out.file_size,
        },
    )
    telemetry.emit(
        user,
        "pdf_exported",
        {
            "page_count": 1,
            "template_id": str(tpl.id),
            "slots_filled": sheet.slots_filled,
            "slots_total": sheet.slots_total,
        },
    )
    response = OutputOut.model_validate(out)
    response.color_swap_report = sheet.color_swap_report
    return response


def _generate_async(db: Session, user, job, tpl, opts: "GenerateOptions") -> Output:
    """For heavy jobs (many unique assets), create a 'processing' output and
    run the PDF composition in a background thread to avoid Cloudflare 524 timeouts."""
    import threading
    from backend.database import get_session_factory

    output_id = uuid.uuid4()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    name = f"{job.name} — {timestamp}.pdf"
    r2_key = f"users/{user.id}/outputs/{output_id}.pdf"

    out = Output(
        id=output_id,
        user_id=user.id,
        job_id=job.id,
        name=name,
        r2_key=r2_key,
        file_size=0,
        slots_filled=0,
        slots_total=len(tpl.shapes),
        status="processing",
    )
    db.add(out)
    db.commit()
    db.refresh(out)

    # Gather everything the background thread needs (all DB-bound values
    # resolved now since the session will close).
    job_id = job.id
    user_id = user.id
    tpl_id = tpl.id
    tpl_r2_key = tpl.r2_key
    tpl_shapes = list(tpl.shapes)
    tpl_bleed_mm = float(tpl.bleed_mm or 0.0)
    tpl_safe_mm = float(tpl.safe_mm or 0.0)
    tpl_positions_layer = tpl.positions_layer
    tpl_registration_type = tpl.registration_type
    tpl_mark_offset_mm = float(tpl.mark_offset_mm or 5.0)
    tpl_max_zone_length_mm = tpl.max_zone_length_mm
    assignments = dict(job.assignments or {})
    include_cut_lines = opts.include_cut_lines
    cut_spot = opts.cut_line_spot_color
    mark_spot = opts.mark_spot_color
    do_compress = opts.compress

    # Resolve accessible assets before we leave the request scope.
    all_asset_ids = set()
    for assignment in assignments.values():
        aid = assignment.get("asset_id")
        if aid:
            all_asset_ids.add(uuid.UUID(aid))
    accessible = _accessible_assets(db, user, all_asset_ids) if all_asset_ids else {}

    # If colour swaps are active, we MUST use full-res originals so that
    # vector colour commands remain intact for the swap engine.
    has_color_swaps = bool(_resolve_active_swaps(db, job))

    asset_r2_keys: dict[str, str] = {}
    for aid_uuid, asset_obj in accessible.items():
        if has_color_swaps:
            asset_r2_keys[str(aid_uuid)] = asset_obj.r2_key
        else:
            asset_r2_keys[str(aid_uuid)] = asset_obj.placement_r2_key or asset_obj.r2_key

    def _bg_generate():
        bg_db = get_session_factory()()
        try:
            from concurrent.futures import ThreadPoolExecutor

            template_bytes = r2_cache.get_bytes(tpl_r2_key)

            asset_pdfs: dict[int, bytes] = {}
            slot_transforms: dict[int, pdf_compositor.SlotTransform] = {}

            mm_to_pt = 72.0 / 25.4

            # Deduplicate: group slots by asset_id so each file is fetched once
            asset_id_to_slots: dict[str, list[str]] = {}
            for slot_key, assignment in assignments.items():
                asset_id = assignment.get("asset_id")
                if not asset_id or asset_id not in asset_r2_keys:
                    continue
                asset_id_to_slots.setdefault(asset_id, []).append(slot_key)
                slot_transforms[int(slot_key)] = pdf_compositor.SlotTransform(
                    rotation_deg=int(assignment.get("rotation_deg") or 0),
                    fit_mode=str(assignment.get("fit_mode") or "contain"),
                    x_pt=float(assignment.get("x_mm") or 0.0) * mm_to_pt,
                    y_pt=float(assignment.get("y_mm") or 0.0) * mm_to_pt,
                    w_pt=(float(assignment["w_mm"]) * mm_to_pt) if assignment.get("w_mm") else None,
                    h_pt=(float(assignment["h_mm"]) * mm_to_pt) if assignment.get("h_mm") else None,
                    filter_id=str(assignment.get("filter_id") or "none"),
                    safe_crop=bool(assignment.get("safe_crop")),
                    page_index=int(assignment.get("page_index") or 0),
                )

            # Parallel download unique assets from R2
            unique_ids = list(asset_id_to_slots.keys())
            should_compress = do_compress and not has_color_swaps

            def _fetch(aid: str) -> tuple[str, bytes]:
                if should_compress:
                    return aid, r2_cache.get_compressed(
                        asset_r2_keys[aid], asset_pipeline.compress_for_generation
                    )
                return aid, r2_cache.get_bytes(asset_r2_keys[aid])

            with ThreadPoolExecutor(max_workers=8) as pool:
                fetched = dict(pool.map(_fetch, unique_ids))

            # Map fetched bytes to all slots that use each asset
            for asset_id, slot_keys in asset_id_to_slots.items():
                pdf_bytes = fetched[asset_id]
                for sk in slot_keys:
                    asset_pdfs[int(sk)] = pdf_bytes

            bleed_pt = tpl_bleed_mm * mm_to_pt
            safe_pt = tpl_safe_mm * mm_to_pt
            enriched_shapes = [
                {**s, "bleed_pt": bleed_pt, "safe_pt": safe_pt} for s in tpl_shapes
            ]

            # Color swaps need a fresh query
            bg_job = bg_db.query(Job).filter(Job.id == job_id).one()
            active_swaps = _resolve_active_swaps(bg_db, bg_job)

            cut_line_spec = None
            if include_cut_lines:
                bg_user = bg_db.query(User).filter(User.id == user_id).one()
                cut_line_spec = _resolve_cut_line_spec(bg_db, bg_user, opts)

            sheet = pdf_compositor.composite(
                template_pdf=template_bytes,
                slot_shapes=enriched_shapes,
                asset_pdfs=asset_pdfs,
                slot_transforms=slot_transforms,
                positions_layer=tpl_positions_layer,
                color_swaps=active_swaps,
                cut_line_spec=cut_line_spec,
            )

            output_bytes = sheet.pdf_bytes
            if tpl_registration_type:
                from backend.services import job_registration
                bg_user = bg_db.query(User).filter(User.id == user_id).one()
                _, mark_rgb255 = _resolve_spot(bg_db, bg_user, mark_spot)
                mark_rgb = tuple(c / 255.0 for c in mark_rgb255)
                output_bytes = job_registration.add_registration_marks(
                    output_bytes,
                    tpl_registration_type,
                    mark_offset_mm=tpl_mark_offset_mm,
                    max_zone_length_mm=tpl_max_zone_length_mm,
                    mark_rgb=mark_rgb,
                )

            storage.put_bytes(r2_key, output_bytes, content_type="application/pdf")

            bg_out = bg_db.query(Output).filter(Output.id == output_id).one()
            bg_out.file_size = len(output_bytes)
            bg_out.slots_filled = sheet.slots_filled
            bg_out.slots_total = sheet.slots_total
            bg_out.status = "ready"
            bg_db.commit()

            log.info(
                "Async generation complete: output %s for job %s (%d assets, %d bytes)",
                output_id, job_id, len(asset_pdfs), len(output_bytes),
            )
        except Exception as exc:
            log.exception(
                "Background generation failed for output %s (job %s, user %s): %s",
                output_id, job_id, user_id, exc,
            )
            try:
                bg_out = bg_db.query(Output).filter(Output.id == output_id).one()
                bg_out.status = "failed"
                bg_db.commit()
            except Exception:
                pass
        finally:
            bg_db.close()

    thread = threading.Thread(target=_bg_generate, daemon=True)
    thread.start()

    return out


def _spot_hex(db: Session, user: User, value: str | None, fallback: str) -> str:
    """Resolve a spot value (name or #hex) to a concrete #RRGGBB for SVG
    strokes. A named spot resolves via the user's library / built-ins."""
    if value and value.startswith("#"):
        return value
    _, rgb = _resolve_spot(db, user, value)
    if value:
        return "#%02X%02X%02X" % rgb
    return fallback


def _shape_to_svg_cut(shape: dict, stroke: str) -> str:
    """Render a template slot shape as an SVG cut path in mm (top-left
    origin, matching the stored bbox coordinate space)."""
    PT_TO_MM = 25.4 / 72.0
    bbox = shape.get("bbox") or [0, 0, 0, 0]
    bx, by, bw, bh = (float(v) * PT_TO_MM for v in bbox[:4])
    kind = shape.get("kind") or "rect"
    if kind == "ellipse":
        return (
            f'  <ellipse cx="{bx + bw / 2:.2f}" cy="{by + bh / 2:.2f}" '
            f'rx="{bw / 2:.2f}" ry="{bh / 2:.2f}" '
            f'fill="none" stroke="{stroke}" stroke-width="0.1"/>'
        )
    path = shape.get("path")
    if kind == "polygon" and isinstance(path, list) and len(path) >= 3:
        pts = [(bx + float(u) * bw, by + float(v) * bh) for u, v in path]
        d = "M " + " L ".join(f"{px:.2f} {py:.2f}" for px, py in pts) + " Z"
        return f'  <path d="{d}" fill="none" stroke="{stroke}" stroke-width="0.1"/>'
    r = max(0.0, min(float(shape.get("corner_radius_pt") or 0.0) * PT_TO_MM, min(bw, bh) / 2))
    rxry = f' rx="{r:.2f}" ry="{r:.2f}"' if r > 0 else ""
    return (
        f'  <rect x="{bx:.2f}" y="{by:.2f}" width="{bw:.2f}" height="{bh:.2f}"{rxry} '
        f'fill="none" stroke="{stroke}" stroke-width="0.1"/>'
    )


@router.post("/{job_id}/export-svg")
def export_job_svg(
    job_id: uuid.UUID,
    cut_color: str = Query(default="CutContour"),
    mark_color: str = Query(default="#000000"),
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Export an SVG with the template's cut lines + registration marks only
    (no artwork). Mirrors the Sheet Builder's "Export Cut Lines": cut paths at
    0.1 stroke and HOLLOW registration marks (e.g. 6mm Velloblade circles) so
    a cutting machine routes the outline, while the print PDF keeps solid
    marks."""
    from backend.routers.sheet_builder import (
        _svg_generic_marks,
        _svg_summa_marks,
        _svg_velloblade_marks,
    )

    user = _resolve_user(db, auth)
    job = _own_job(db, user, job_id)
    tpl = db.query(Template).filter(Template.id == job.template_id).one()

    PT_TO_MM = 25.4 / 72.0
    w = tpl.page_width * PT_TO_MM
    h = tpl.page_height * PT_TO_MM

    cut_stroke = _spot_hex(db, user, cut_color, "#FF00FF")
    mark_stroke = _spot_hex(db, user, mark_color, "#000000")

    elements: list[str] = []
    for shape in tpl.shapes or []:
        elements.append(_shape_to_svg_cut(shape, cut_stroke))

    reg_type = tpl.registration_type
    mark_offset = float(tpl.mark_offset_mm or 5.0)
    max_zone = tpl.max_zone_length_mm
    if reg_type == "velloblade":
        _svg_velloblade_marks(elements, w, h, mark_offset, max_zone, mark_stroke)
    elif reg_type == "summa_opos":
        _svg_summa_marks(elements, w, h, mark_offset, max_zone, mark_stroke)
    elif reg_type == "generic":
        _svg_generic_marks(elements, w, h, mark_offset, mark_stroke)

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{w:.2f}mm" height="{h:.2f}mm" '
        f'viewBox="0 0 {w:.2f} {h:.2f}">\n'
        + "\n".join(elements)
        + "\n</svg>\n"
    )
    return Response(content=svg, media_type="image/svg+xml")
