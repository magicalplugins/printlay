from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from backend.auth import AuthenticatedUser, get_current_user
from backend.database import get_db
from backend.models import Output
from backend.routers.templates import _resolve_user
from backend.schemas.output import OutputOut
from backend.services import storage

router = APIRouter(prefix="/api/outputs", tags=["outputs"])


@router.get("", response_model=list[OutputOut])
def list_outputs(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[Output]:
    user = _resolve_user(db, auth)
    return (
        db.query(Output)
        .filter(Output.user_id == user.id)
        .order_by(Output.created_at.desc())
        .all()
    )


@router.get("/{output_id}/download")
def download_output(
    output_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, str | int]:
    user = _resolve_user(db, auth)
    out = db.query(Output).filter(
        Output.id == output_id, Output.user_id == user.id
    ).one_or_none()
    if out is None:
        raise HTTPException(404, "Output not found")
    safe = "".join(c if c.isalnum() or c in "-_." else "-" for c in out.name)
    url = storage.presigned_get(out.r2_key, expires_in=3600, download_filename=safe)
    return {"url": url, "expires_in": 3600}


@router.delete("/{output_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_output(
    output_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    user = _resolve_user(db, auth)
    out = db.query(Output).filter(
        Output.id == output_id, Output.user_id == user.id
    ).one_or_none()
    if out is None:
        raise HTTPException(404, "Output not found")
    try:
        storage.delete(out.r2_key)
    except Exception:
        pass
    db.delete(out)
    db.commit()
