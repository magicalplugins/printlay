"""Support-access endpoints for admin impersonation.

Two routers are defined here:
  - ``admin_router`` (prefix ``/api/admin/support-access``) — admin-only
    endpoints for requesting access, checking status, ending sessions.
  - ``user_router`` (prefix ``/api/support-access``) — user-facing endpoints
    for polling pending requests, responding, and revoking.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from backend.auth import AuthenticatedUser, get_current_user, require_admin
from backend.database import get_db
from backend.models import AuditEvent, User
from backend.models.support_grant import SupportGrant

GRANT_DURATION = timedelta(hours=1)

admin_router = APIRouter(
    prefix="/api/admin/support-access",
    tags=["support-access-admin"],
)
user_router = APIRouter(
    prefix="/api/support-access",
    tags=["support-access"],
)


def _resolve_user(db: Session, auth: AuthenticatedUser) -> User:
    if not auth.email:
        raise HTTPException(400, "JWT missing email claim")
    from backend.services import user_provisioning
    return user_provisioning.get_or_provision(
        db, auth_id=auth.auth_id, email=auth.email,
    )


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _expire_stale(db: Session) -> None:
    """Mark overdue grants as expired in-place."""
    now = _now()
    stale = (
        db.query(SupportGrant)
        .filter(
            SupportGrant.status.in_(["pending", "active"]),
            SupportGrant.expires_at <= now,
        )
        .all()
    )
    for g in stale:
        g.status = "expired"
        g.ended_at = now
        g.ended_reason = "expired"


def _audit(db: Session, action: str, admin_id: uuid.UUID, target_id: uuid.UUID, grant_id: uuid.UUID) -> None:
    db.add(AuditEvent(
        user_id=admin_id,
        action=action,
        target_type="support_grant",
        target_id=grant_id,
        payload={"target_user_id": str(target_id)},
    ))


# ---------------------------------------------------------------------------
# Admin endpoints
# ---------------------------------------------------------------------------

class GrantOut(BaseModel):
    id: str
    admin_user_id: str
    target_user_id: str
    admin_email: str | None = None
    target_email: str | None = None
    status: str
    requested_at: str
    accepted_at: str | None = None
    expires_at: str
    ended_at: str | None = None
    ended_reason: str | None = None


def _grant_to_out(g: SupportGrant, admin: User | None = None, target: User | None = None) -> GrantOut:
    return GrantOut(
        id=str(g.id),
        admin_user_id=str(g.admin_user_id),
        target_user_id=str(g.target_user_id),
        admin_email=admin.email if admin else None,
        target_email=target.email if target else None,
        status=g.status,
        requested_at=g.requested_at.isoformat(),
        accepted_at=g.accepted_at.isoformat() if g.accepted_at else None,
        expires_at=g.expires_at.isoformat(),
        ended_at=g.ended_at.isoformat() if g.ended_at else None,
        ended_reason=g.ended_reason,
    )


@admin_router.post("/{user_id}/request", response_model=GrantOut, status_code=201)
def request_access(
    user_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Create a pending support-access grant for a user."""
    target = db.query(User).filter(User.id == user_id).first()
    if not target:
        raise HTTPException(404, "User not found")

    _expire_stale(db)

    existing = (
        db.query(SupportGrant)
        .filter(
            SupportGrant.target_user_id == user_id,
            SupportGrant.status.in_(["pending", "active"]),
        )
        .all()
    )
    now = _now()
    for g in existing:
        g.status = "revoked"
        g.ended_at = now
        g.ended_reason = "superseded"

    grant = SupportGrant(
        admin_user_id=admin.id,
        target_user_id=user_id,
        status="pending",
        expires_at=now + GRANT_DURATION,
    )
    db.add(grant)
    _audit(db, "support_access.requested", admin.id, user_id, grant.id)
    db.commit()
    db.refresh(grant)
    return _grant_to_out(grant, admin=admin, target=target)


@admin_router.get("/{user_id}/status", response_model=GrantOut | None)
def get_access_status(
    user_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Check the current support-access grant status for a user."""
    _expire_stale(db)
    db.commit()

    grant = (
        db.query(SupportGrant)
        .filter(
            SupportGrant.target_user_id == user_id,
            SupportGrant.status.in_(["pending", "active"]),
        )
        .order_by(SupportGrant.requested_at.desc())
        .first()
    )
    if not grant:
        return None

    target = db.query(User).filter(User.id == user_id).first()
    return _grant_to_out(grant, admin=admin, target=target)


@admin_router.get("/active", response_model=list[GrantOut])
def list_active_grants(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """List all active/pending support grants."""
    _expire_stale(db)
    db.commit()

    grants = (
        db.query(SupportGrant)
        .filter(SupportGrant.status.in_(["pending", "active"]))
        .order_by(SupportGrant.requested_at.desc())
        .all()
    )
    result = []
    for g in grants:
        a = db.query(User).filter(User.id == g.admin_user_id).first()
        t = db.query(User).filter(User.id == g.target_user_id).first()
        result.append(_grant_to_out(g, admin=a, target=t))
    return result


@admin_router.post("/{grant_id}/end", response_model=GrantOut)
def end_access(
    grant_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Admin ends an active or pending support session early."""
    grant = db.query(SupportGrant).filter(SupportGrant.id == grant_id).first()
    if not grant:
        raise HTTPException(404, "Grant not found")
    if grant.status not in ("pending", "active"):
        raise HTTPException(400, f"Grant is already {grant.status}")

    now = _now()
    grant.status = "revoked"
    grant.ended_at = now
    grant.ended_reason = "admin_ended"
    _audit(db, "support_access.admin_ended", admin.id, grant.target_user_id, grant.id)
    db.commit()
    db.refresh(grant)
    return _grant_to_out(grant, admin=admin)


# ---------------------------------------------------------------------------
# User endpoints
# ---------------------------------------------------------------------------

class PendingGrantOut(BaseModel):
    id: str
    admin_email: str
    requested_at: str
    expires_at: str


class ActiveGrantOut(BaseModel):
    id: str
    admin_email: str
    accepted_at: str
    expires_at: str


class RespondBody(BaseModel):
    accept: bool


@user_router.get("/pending", response_model=PendingGrantOut | None)
def get_pending(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Poll for a pending support-access request (called every 15s)."""
    user = _resolve_user(db, auth)
    _expire_stale(db)
    db.commit()

    grant = (
        db.query(SupportGrant)
        .filter(
            SupportGrant.target_user_id == user.id,
            SupportGrant.status == "pending",
        )
        .order_by(SupportGrant.requested_at.desc())
        .first()
    )
    if not grant:
        return None

    admin = db.query(User).filter(User.id == grant.admin_user_id).first()
    return PendingGrantOut(
        id=str(grant.id),
        admin_email=admin.email if admin else "support",
        requested_at=grant.requested_at.isoformat(),
        expires_at=grant.expires_at.isoformat(),
    )


@user_router.post("/{grant_id}/respond", response_model=dict)
def respond_to_grant(
    grant_id: uuid.UUID,
    body: RespondBody,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """User accepts or rejects a support-access request."""
    user = _resolve_user(db, auth)
    grant = db.query(SupportGrant).filter(SupportGrant.id == grant_id).first()
    if not grant:
        raise HTTPException(404, "Grant not found")
    if grant.target_user_id != user.id:
        raise HTTPException(403, "Not your grant")
    if grant.status != "pending":
        raise HTTPException(400, f"Grant is already {grant.status}")

    now = _now()
    if body.accept:
        grant.status = "active"
        grant.accepted_at = now
        _audit(db, "support_access.accepted", grant.admin_user_id, user.id, grant.id)
    else:
        grant.status = "rejected"
        grant.ended_at = now
        grant.ended_reason = "user_rejected"
        _audit(db, "support_access.rejected", grant.admin_user_id, user.id, grant.id)

    db.commit()
    return {"ok": True, "status": grant.status}


@user_router.get("/active", response_model=ActiveGrantOut | None)
def get_active(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Check if there's an active support session on this account."""
    user = _resolve_user(db, auth)
    _expire_stale(db)
    db.commit()

    grant = (
        db.query(SupportGrant)
        .filter(
            SupportGrant.target_user_id == user.id,
            SupportGrant.status == "active",
        )
        .order_by(SupportGrant.requested_at.desc())
        .first()
    )
    if not grant:
        return None

    admin = db.query(User).filter(User.id == grant.admin_user_id).first()
    return ActiveGrantOut(
        id=str(grant.id),
        admin_email=admin.email if admin else "support",
        accepted_at=grant.accepted_at.isoformat() if grant.accepted_at else "",
        expires_at=grant.expires_at.isoformat(),
    )


@user_router.post("/{grant_id}/revoke", response_model=dict)
def revoke_grant(
    grant_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """User revokes an active support-access grant immediately."""
    user = _resolve_user(db, auth)
    grant = db.query(SupportGrant).filter(SupportGrant.id == grant_id).first()
    if not grant:
        raise HTTPException(404, "Grant not found")
    if grant.target_user_id != user.id:
        raise HTTPException(403, "Not your grant")
    if grant.status != "active":
        raise HTTPException(400, f"Grant is not active (currently {grant.status})")

    now = _now()
    grant.status = "revoked"
    grant.ended_at = now
    grant.ended_reason = "user_revoked"
    _audit(db, "support_access.user_revoked", grant.admin_user_id, user.id, grant.id)
    db.commit()
    return {"ok": True}
