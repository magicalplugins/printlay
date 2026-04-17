from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from backend.audit import record
from backend.auth import AuthenticatedUser, get_current_user
from backend.database import get_db
from backend.models import Asset, Job, Output, Template, User
from backend.rate_limit import generate_limit, limiter
from backend.routers.templates import _resolve_user
from backend.schemas.job import FillRequest, JobCreate, JobOut, JobUpdate
from backend.schemas.output import OutputOut
from backend.services import pdf_compositor, r2

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


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
    db.delete(job)
    db.commit()


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
    )
    db.add(copy)
    db.commit()
    db.refresh(copy)
    record(db, user, "job.duplicate", target_type="job", target_id=copy.id, payload={"src_id": str(src.id)})
    return copy


@router.post("/{job_id}/generate", response_model=OutputOut, status_code=status.HTTP_201_CREATED)
@limiter.limit(generate_limit())
def generate_output(
    request: Request,
    job_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Output:
    user = _resolve_user(db, auth)
    request.state.auth_user = auth
    job = _own_job(db, user, job_id)
    tpl = db.query(Template).filter(Template.id == job.template_id).one()

    try:
        template_bytes = r2.get_bytes(tpl.r2_key)
    except r2.R2NotConfigured as exc:
        raise HTTPException(503, str(exc))

    asset_pdfs: dict[int, bytes] = {}
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
            asset_pdfs[int(slot_key)] = r2.get_bytes(asset.r2_key)
        except Exception as exc:
            raise HTTPException(500, f"Failed to load asset {asset_id}: {exc}")

    try:
        sheet = pdf_compositor.composite(
            template_pdf=template_bytes,
            slot_shapes=tpl.shapes,
            asset_pdfs=asset_pdfs,
            positions_layer=tpl.positions_layer,
        )
    except pdf_compositor.CompositorError as exc:
        raise HTTPException(500, str(exc))

    output_id = uuid.uuid4()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    name = f"{job.name} — {timestamp}.pdf"
    r2_key = f"users/{user.id}/outputs/{output_id}.pdf"
    r2.put_bytes(r2_key, sheet.pdf_bytes, content_type="application/pdf")

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
    return out
