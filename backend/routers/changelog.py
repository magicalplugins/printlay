"""Changelog API — public read, admin write.

Public:  GET /api/changelog          → list published entries (newest first)
Admin:   POST /api/admin/changelog   → create entry
         PUT /api/admin/changelog/:id → update entry
         DELETE /api/admin/changelog/:id → delete entry
         GET /api/admin/changelog     → list all entries (incl. unpublished)
"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.auth.admin import require_admin
from backend.database import get_db
from backend.models.changelog_entry import ChangelogEntry
from backend.models.user import User

public_router = APIRouter(prefix="/api/changelog", tags=["changelog"])
admin_router = APIRouter(prefix="/api/admin/changelog", tags=["admin-changelog"])


class ChangelogOut(BaseModel):
    id: str
    title: str
    body: str
    tag: str
    published: bool
    published_at: str

    class Config:
        from_attributes = True


class ChangelogCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    body: str = Field(..., min_length=1, max_length=5000)
    tag: str = Field(default="feature", max_length=30)
    published: bool = True


class ChangelogUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    body: str | None = Field(default=None, max_length=5000)
    tag: str | None = Field(default=None, max_length=30)
    published: bool | None = None


def _to_out(entry: ChangelogEntry) -> ChangelogOut:
    return ChangelogOut(
        id=str(entry.id),
        title=entry.title,
        body=entry.body,
        tag=entry.tag,
        published=entry.published,
        published_at=entry.created_at.isoformat(),
    )


@public_router.get("")
def list_published(db: Session = Depends(get_db)):
    stmt = (
        select(ChangelogEntry)
        .where(ChangelogEntry.published == True)  # noqa: E712
        .order_by(ChangelogEntry.created_at.desc())
        .limit(50)
    )
    entries = db.scalars(stmt).all()
    return {"items": [_to_out(e) for e in entries]}


@admin_router.get("")
def admin_list(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    stmt = (
        select(ChangelogEntry)
        .order_by(ChangelogEntry.created_at.desc())
        .limit(100)
    )
    entries = db.scalars(stmt).all()
    return {"items": [_to_out(e) for e in entries]}


@admin_router.post("", status_code=201)
def create_entry(
    payload: ChangelogCreate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    entry = ChangelogEntry(
        title=payload.title,
        body=payload.body,
        tag=payload.tag,
        published=payload.published,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return _to_out(entry)


@admin_router.put("/{entry_id}")
def update_entry(
    entry_id: UUID,
    payload: ChangelogUpdate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    entry = db.get(ChangelogEntry, entry_id)
    if not entry:
        raise HTTPException(404, "Entry not found")
    if payload.title is not None:
        entry.title = payload.title
    if payload.body is not None:
        entry.body = payload.body
    if payload.tag is not None:
        entry.tag = payload.tag
    if payload.published is not None:
        entry.published = payload.published
    db.commit()
    db.refresh(entry)
    return _to_out(entry)


@admin_router.delete("/{entry_id}", status_code=204)
def delete_entry(
    entry_id: UUID,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    entry = db.get(ChangelogEntry, entry_id)
    if not entry:
        raise HTTPException(404, "Entry not found")
    db.delete(entry)
    db.commit()
