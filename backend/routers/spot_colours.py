"""Spot colour presets CRUD. Lives at /api/spot-colours.

User-managed presets for spot colours used on the canvas. On first
creation, seeds the library with three industry-standard defaults so
the user has useful entries out of the box.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from backend.auth import AuthenticatedUser, get_current_user
from backend.database import get_db
from backend.models.spot_colour import SpotColour
from backend.routers.templates import _resolve_user

router = APIRouter(prefix="/api/spot-colours", tags=["spot-colours"])

_DEFAULTS = [
    {"name": "CutContour", "display_color": "#8B5CF6", "sort_order": 0.0},
    {"name": "Score", "display_color": "#0000FF", "sort_order": 1.0},
    {"name": "Through-cut", "display_color": "#FF00FF", "sort_order": 2.0},
]


class SpotColourOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    display_color: str
    sort_order: float


class SpotColourCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    display_color: str = Field(default="#FF00FF", max_length=20)
    sort_order: float | None = None


class SpotColourUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    display_color: str | None = Field(default=None, max_length=20)
    sort_order: float | None = None


def _seed_defaults(db: Session, user_id: uuid.UUID) -> list[SpotColour]:
    """Seed the default spot colour presets for a new user."""
    rows: list[SpotColour] = []
    for d in _DEFAULTS:
        row = SpotColour(user_id=user_id, **d)
        db.add(row)
        rows.append(row)
    db.flush()
    return rows


@router.get("", response_model=list[SpotColourOut])
def list_spot_colours(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[SpotColour]:
    user = _resolve_user(db, auth)
    return (
        db.query(SpotColour)
        .filter(SpotColour.user_id == user.id)
        .order_by(SpotColour.sort_order.asc())
        .all()
    )


@router.post("", response_model=SpotColourOut, status_code=status.HTTP_201_CREATED)
def create_spot_colour(
    payload: SpotColourCreate,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SpotColour:
    user = _resolve_user(db, auth)

    existing_count = (
        db.query(SpotColour).filter(SpotColour.user_id == user.id).count()
    )
    if existing_count == 0:
        _seed_defaults(db, user.id)

    sort_order = payload.sort_order
    if sort_order is None:
        max_order = (
            db.query(SpotColour.sort_order)
            .filter(SpotColour.user_id == user.id)
            .order_by(SpotColour.sort_order.desc())
            .limit(1)
            .scalar()
        )
        sort_order = (max_order or 0.0) + 1.0

    row = SpotColour(
        user_id=user.id,
        name=payload.name.strip(),
        display_color=payload.display_color,
        sort_order=sort_order,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.put("/{spot_colour_id}", response_model=SpotColourOut)
def update_spot_colour(
    spot_colour_id: uuid.UUID,
    payload: SpotColourUpdate,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SpotColour:
    user = _resolve_user(db, auth)
    row = (
        db.query(SpotColour)
        .filter(SpotColour.id == spot_colour_id, SpotColour.user_id == user.id)
        .one_or_none()
    )
    if row is None:
        raise HTTPException(404, "Spot colour not found")

    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        data["name"] = data["name"].strip()
    for k, v in data.items():
        setattr(row, k, v)

    db.commit()
    db.refresh(row)
    return row


@router.delete("/{spot_colour_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_spot_colour(
    spot_colour_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    user = _resolve_user(db, auth)
    row = (
        db.query(SpotColour)
        .filter(SpotColour.id == spot_colour_id, SpotColour.user_id == user.id)
        .one_or_none()
    )
    if row is None:
        raise HTTPException(404, "Spot colour not found")
    db.delete(row)
    db.commit()
