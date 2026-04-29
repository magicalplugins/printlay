"""Spot colour library CRUD. Lives at /api/spot-colors.

Spot colours are user-scoped, named PDF Separation colours. The library
seeds itself on first read with three industry-standard presets so the
"include cut lines" feature works out of the box for new users without
any setup.

Setting ``is_cut_line_default`` on one entry implicitly clears it on the
user's other entries, so the database invariant "at most one default per
user" is enforced both by the partial unique index and by the router's
write paths. We do the clear before the new row is updated to avoid a
transient state that would trip the unique constraint mid-transaction.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import update
from sqlalchemy.orm import Session

from backend.auth import AuthenticatedUser, get_current_user
from backend.database import get_db
from backend.models import SpotColor, User
from backend.routers.templates import _resolve_user
from backend.schemas.spot_color import (
    SpotColorCreate,
    SpotColorOut,
    SpotColorUpdate,
)
from backend.services import spot_color_seeds

router = APIRouter(prefix="/api/spot-colors", tags=["spot-colors"])


def _own(db: Session, user: User, spot_color_id: uuid.UUID) -> SpotColor:
    row = (
        db.query(SpotColor)
        .filter(SpotColor.id == spot_color_id, SpotColor.user_id == user.id)
        .one_or_none()
    )
    if row is None:
        raise HTTPException(404, "Spot colour not found")
    return row


def _clear_other_defaults(db: Session, user_id: uuid.UUID, except_id: uuid.UUID | None) -> None:
    """Set is_cut_line_default = False on every row owned by ``user_id``
    except ``except_id``. Run before flipping a new row's default flag
    on so the partial unique index doesn't see two TRUE rows mid-tx."""
    stmt = (
        update(SpotColor)
        .where(SpotColor.user_id == user_id)
        .where(SpotColor.is_cut_line_default.is_(True))
    )
    if except_id is not None:
        stmt = stmt.where(SpotColor.id != except_id)
    stmt = stmt.values(is_cut_line_default=False, updated_at=datetime.now(timezone.utc))
    db.execute(stmt)


@router.get("", response_model=list[SpotColorOut])
def list_spot_colors(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[SpotColor]:
    user = _resolve_user(db, auth)
    rows = (
        db.query(SpotColor)
        .filter(SpotColor.user_id == user.id)
        .order_by(SpotColor.is_cut_line_default.desc(), SpotColor.name.asc())
        .all()
    )
    if not rows:
        # First read for this user - seed the presets so the cut-line
        # feature works without any setup, then return the seeded rows.
        rows = spot_color_seeds.seed_for_user(db, user.id)
        rows.sort(key=lambda r: (not r.is_cut_line_default, r.name))
    return rows


@router.post("", response_model=SpotColorOut, status_code=status.HTTP_201_CREATED)
def create_spot_color(
    payload: SpotColorCreate,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SpotColor:
    user = _resolve_user(db, auth)
    if payload.is_cut_line_default:
        _clear_other_defaults(db, user.id, except_id=None)
    row = SpotColor(
        user_id=user.id,
        name=payload.name.strip(),
        rgb=list(payload.rgb),
        is_cut_line_default=payload.is_cut_line_default,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/{spot_color_id}", response_model=SpotColorOut)
def update_spot_color(
    spot_color_id: uuid.UUID,
    payload: SpotColorUpdate,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SpotColor:
    user = _resolve_user(db, auth)
    row = _own(db, user, spot_color_id)
    if payload.name is not None:
        row.name = payload.name.strip()
    if payload.rgb is not None:
        row.rgb = list(payload.rgb)
    if payload.is_cut_line_default is not None:
        if payload.is_cut_line_default:
            _clear_other_defaults(db, user.id, except_id=row.id)
            row.is_cut_line_default = True
        else:
            row.is_cut_line_default = False
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{spot_color_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_spot_color(
    spot_color_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    user = _resolve_user(db, auth)
    row = _own(db, user, spot_color_id)
    db.delete(row)
    db.commit()
