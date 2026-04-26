"""Colour profile CRUD + duplicate. Lives at /api/color-profiles.

Profiles are user-scoped, named, and hold a list of exact-match RGB
swaps. They're referenced by jobs via `jobs.color_profile_id`; deleting
a profile sets that link to NULL on every job that used it (the FK is
declared `ON DELETE SET NULL`) so nothing breaks in the user's job
list.
"""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.auth import AuthenticatedUser, get_current_user
from backend.database import get_db
from backend.models import ColorProfile, Job, User
from backend.routers.templates import _resolve_user
from backend.schemas.color_profile import (
    ColorProfileCreate,
    ColorProfileOut,
    ColorProfileUpdate,
)
from backend.services import entitlements


def _enforce_profile_quota(db: Session, user: User) -> None:
    """Block creation of a new colour profile when the user is at their
    plan's cap. Used by both the create and duplicate endpoints so we
    can't accidentally let one path slip through.
    """
    ent = entitlements.for_user(user)
    if not ent.allows("colour_swap"):
        raise HTTPException(
            402,
            detail={
                "code": "plan_locked",
                "message": "Your trial has ended. Reactivate your account to manage colour profiles.",
            },
        )
    current = (
        db.query(func.count(ColorProfile.id))
        .filter(ColorProfile.user_id == user.id)
        .scalar()
        or 0
    )
    if not ent.under_quota("color_profiles_max", current):
        cap = ent.quota("color_profiles_max")
        raise HTTPException(
            402,
            detail={
                "code": "quota_exceeded",
                "limit": "color_profiles_max",
                "cap": cap,
                "message": (
                    f"You've reached your {cap}-profile limit. "
                    "Upgrade to Pro for unlimited colour profiles."
                ),
            },
        )

router = APIRouter(prefix="/api/color-profiles", tags=["color-profiles"])


def _own_profile(db: Session, user: User, profile_id: uuid.UUID) -> ColorProfile:
    p = (
        db.query(ColorProfile)
        .filter(ColorProfile.id == profile_id, ColorProfile.user_id == user.id)
        .one_or_none()
    )
    if p is None:
        raise HTTPException(404, "Color profile not found")
    return p


def _to_out(db: Session, p: ColorProfile) -> ColorProfileOut:
    job_count = (
        db.query(func.count(Job.id))
        .filter(Job.color_profile_id == p.id)
        .scalar()
        or 0
    )
    out = ColorProfileOut.model_validate(p)
    out.job_count = int(job_count)
    return out


@router.get("", response_model=list[ColorProfileOut])
def list_profiles(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ColorProfileOut]:
    user = _resolve_user(db, auth)
    rows = (
        db.query(ColorProfile)
        .filter(ColorProfile.user_id == user.id)
        .order_by(ColorProfile.name.asc())
        .all()
    )
    # Single aggregate query for job counts so we don't N+1.
    counts = dict(
        db.query(Job.color_profile_id, func.count(Job.id))
        .filter(Job.color_profile_id.in_([p.id for p in rows]))
        .group_by(Job.color_profile_id)
        .all()
    ) if rows else {}
    out: list[ColorProfileOut] = []
    for p in rows:
        item = ColorProfileOut.model_validate(p)
        item.job_count = int(counts.get(p.id, 0))
        out.append(item)
    return out


@router.post("", response_model=ColorProfileOut, status_code=status.HTTP_201_CREATED)
def create_profile(
    payload: ColorProfileCreate,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ColorProfileOut:
    user = _resolve_user(db, auth)
    _enforce_profile_quota(db, user)
    p = ColorProfile(
        user_id=user.id,
        name=payload.name.strip(),
        swaps=[s.model_dump(mode="json") for s in payload.swaps],
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return _to_out(db, p)


@router.get("/{profile_id}", response_model=ColorProfileOut)
def get_profile(
    profile_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ColorProfileOut:
    user = _resolve_user(db, auth)
    p = _own_profile(db, user, profile_id)
    return _to_out(db, p)


@router.patch("/{profile_id}", response_model=ColorProfileOut)
def update_profile(
    profile_id: uuid.UUID,
    payload: ColorProfileUpdate,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ColorProfileOut:
    user = _resolve_user(db, auth)
    p = _own_profile(db, user, profile_id)
    if payload.name is not None:
        p.name = payload.name.strip()
    if payload.swaps is not None:
        p.swaps = [s.model_dump(mode="json") for s in payload.swaps]
    p.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(p)
    return _to_out(db, p)


@router.delete("/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_profile(
    profile_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    user = _resolve_user(db, auth)
    p = _own_profile(db, user, profile_id)
    db.delete(p)
    db.commit()


@router.post(
    "/{profile_id}/duplicate",
    response_model=ColorProfileOut,
    status_code=status.HTTP_201_CREATED,
)
def duplicate_profile(
    profile_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ColorProfileOut:
    """Create a copy with " (copy)" appended. Useful for tweaking a
    second-machine variant without disturbing the original."""
    user = _resolve_user(db, auth)
    src = _own_profile(db, user, profile_id)
    _enforce_profile_quota(db, user)
    copy = ColorProfile(
        user_id=user.id,
        name=f"{src.name} (copy)",
        swaps=list(src.swaps or []),
    )
    db.add(copy)
    db.commit()
    db.refresh(copy)
    return _to_out(db, copy)
