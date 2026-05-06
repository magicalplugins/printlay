import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from sqlalchemy.orm import Session

from backend.audit import record
from backend.auth import AuthenticatedUser, get_current_user
from backend.database import get_db
from backend.models import Asset, ColorProfile, Job, Output, SpotColor, Template, User
from backend.rate_limit import generate_burst_limit, generate_limit, limiter
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
    storage,
    storage_usage,
    telemetry,
)

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


_PREVIEW_CONTENT_TYPES: dict[str, str] = {
    "svg": "image/svg+xml",
    "png": "image/png",
    "jpg": "image/jpeg",
}


def _preview_url_for(a: Asset) -> str | None:
    """Highest-fidelity preview the browser can render directly.
    SVG/PNG/JPG get the original source; PDFs fall back to the thumbnail."""
    ct = _PREVIEW_CONTENT_TYPES.get(a.kind)
    if ct and a.r2_key_original:
        try:
            return storage.presigned_get(
                a.r2_key_original,
                expires_in=3600,
                content_type=ct,
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
    )


def _purge_job_uploads(db: Session, job: Job) -> None:
    """Delete R2 storage for any job-attached assets. The DB rows themselves
    cascade-delete via the FK when the Job is deleted."""
    uploads = db.query(Asset).filter(Asset.job_id == job.id).all()
    for a in uploads:
        for k in (a.r2_key, a.r2_key_original, a.thumbnail_r2_key):
            if k:
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
        width_pt=norm.width_pt,
        height_pt=norm.height_pt,
        file_size=len(norm.pdf_bytes),
    )
    db.add(asset)
    db.commit()
    db.refresh(asset)
    return _asset_to_out(asset)


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
        rows = (
            db.query(Asset)
            .filter(Asset.id.in_(asset_ids), Asset.user_id == user.id)
            .all()
        )
        owned = {a.id: a for a in rows}
        missing = asset_ids - owned.keys()
        if missing:
            raise HTTPException(404, f"Asset not found: {next(iter(missing))}")
    else:
        owned = {}

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
            }
            cursor += 1
        if cursor >= len(slot_order):
            break

    job.assignments = assignments
    db.commit()
    db.refresh(job)
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
    asset = db.query(Asset).filter(
        Asset.id == payload.asset_id, Asset.user_id == user.id
    ).one_or_none()
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
    db.commit()
    db.refresh(job)
    return job


@router.post("/{job_id}/duplicate", response_model=JobOut, status_code=status.HTTP_201_CREATED)
def duplicate_job(
    job_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Job:
    user = _resolve_user(db, auth)
    src = _own_job(db, user, job_id)
    copy = Job(
        user_id=user.id,
        template_id=src.template_id,
        name=f"{src.name} (copy)",
        slot_order=list(src.slot_order or []),
        assignments=dict(src.assignments or {}),
        color_profile_id=src.color_profile_id,
        color_swaps_draft=list(src.color_swaps_draft or []) or None,
    )
    db.add(copy)
    db.commit()
    db.refresh(copy)
    record(db, user, "job.duplicate", target_type="job", target_id=copy.id, payload={"src_id": str(src.id)})
    return copy


# ---------------------------------------------------------------------------
# Colour swap endpoints
# ---------------------------------------------------------------------------


def _resolve_cut_line_spec(
    db: Session, user: User, opts: GenerateOptions
) -> cut_lines.CutLineSpec:
    """Pick which spot colour drives the cut layer.

    Resolution order:
      1. ``opts.cut_line_spot_color_id`` if provided - explicit user choice.
      2. The user's row flagged ``is_cut_line_default``.
      3. 400 with a clear message - the operator must either pick one
         on this generate call or set a library default in Settings.
    """
    if opts.cut_line_spot_color_id is not None:
        row = (
            db.query(SpotColor)
            .filter(
                SpotColor.id == opts.cut_line_spot_color_id,
                SpotColor.user_id == user.id,
            )
            .one_or_none()
        )
        if row is None:
            raise HTTPException(404, "Spot colour not found")
    else:
        row = (
            db.query(SpotColor)
            .filter(
                SpotColor.user_id == user.id,
                SpotColor.is_cut_line_default.is_(True),
            )
            .one_or_none()
        )
        if row is None:
            raise HTTPException(
                400,
                detail={
                    "code": "no_default_cut_line_spot",
                    "message": (
                        "No default cut-line spot colour is set on your "
                        "account. Pick one on the job page or mark a "
                        "library entry as the default."
                    ),
                },
            )

    rgb_list = list(row.rgb or [255, 0, 255])[:3]
    while len(rgb_list) < 3:
        rgb_list.append(0)
    return cut_lines.CutLineSpec(
        spot_name=row.name,
        rgb=(int(rgb_list[0]), int(rgb_list[1]), int(rgb_list[2])),
    )


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
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JobColorsResponse:
    """Return the job's current colour state plus (optionally) every
    distinct RGB triple detected in the assets currently filling its
    slots. Detection is on by default; disable with `?detect=false`
    to skip the storage round-trip if the caller just wants state."""
    user = _resolve_user(db, auth)
    job = _own_job(db, user, job_id)

    detected: list[tuple[int, int, int]] = []
    if detect:
        seen: set[tuple[int, int, int]] = set()
        asset_ids: set[uuid.UUID] = set()
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

    try:
        template_bytes = storage.get_bytes(tpl.r2_key)
    except storage.StorageNotConfigured as exc:
        raise HTTPException(503, str(exc))

    asset_pdfs: dict[int, bytes] = {}
    slot_transforms: dict[int, pdf_compositor.SlotTransform] = {}
    for slot_key, assignment in (job.assignments or {}).items():
        asset_id = assignment.get("asset_id")
        if not asset_id:
            continue
        asset = db.query(Asset).filter(
            Asset.id == uuid.UUID(asset_id), Asset.user_id == user.id
        ).one_or_none()
        if asset is None:
            continue
        try:
            asset_pdfs[int(slot_key)] = storage.get_bytes(asset.r2_key)
        except Exception as exc:
            raise HTTPException(500, f"Failed to load asset {asset_id}: {exc}")
        # Manual mm placements arrive in mm; convert to PDF points (1mm = 2.83465pt).
        mm_to_pt = 72.0 / 25.4
        slot_transforms[int(slot_key)] = pdf_compositor.SlotTransform(
            rotation_deg=int(assignment.get("rotation_deg") or 0),
            fit_mode=str(assignment.get("fit_mode") or "contain"),
            x_pt=float(assignment.get("x_mm") or 0.0) * mm_to_pt,
            y_pt=float(assignment.get("y_mm") or 0.0) * mm_to_pt,
            w_pt=(float(assignment["w_mm"]) * mm_to_pt) if assignment.get("w_mm") else None,
            h_pt=(float(assignment["h_mm"]) * mm_to_pt) if assignment.get("h_mm") else None,
            filter_id=str(assignment.get("filter_id") or "none"),
        )

    # Inject per-template bleed (in PDF points) onto each shape so the
    # compositor can grow its effective fillable area. Bleed never grows
    # the artboard - just lets art extend that far past the slot edge.
    mm_to_pt = 72.0 / 25.4
    bleed_pt = float(tpl.bleed_mm or 0.0) * mm_to_pt
    enriched_shapes = [{**s, "bleed_pt": bleed_pt} for s in tpl.shapes]

    active_swaps = _resolve_active_swaps(db, job)

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
        raise HTTPException(500, str(exc))

    output_id = uuid.uuid4()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    name = f"{job.name} — {timestamp}.pdf"
    r2_key = f"users/{user.id}/outputs/{output_id}.pdf"
    storage.put_bytes(r2_key, sheet.pdf_bytes, content_type="application/pdf")

    out = Output(
        id=output_id,
        user_id=user.id,
        job_id=job.id,
        name=name,
        r2_key=r2_key,
        file_size=len(sheet.pdf_bytes),
        slots_filled=sheet.slots_filled,
        slots_total=sheet.slots_total,
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
