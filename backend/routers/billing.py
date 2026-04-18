"""Billing & licensing endpoints.

The actual licence server is LMFWC on magicalplugins.com (same install used by
the Murphy's Magic Connector). This router is the small adapter that lets the
SPA paste a key, validates it, activates it for this user, and stores the
result on the `users` row so the entitlements layer can read it back without
hitting the network on every request.

Endpoints:
    GET  /api/billing/status       Current entitlement (plan, limits, features)
    POST /api/billing/license      Activate a license key
    DELETE /api/billing/license    Deactivate the current key
    POST /api/billing/license/refresh   Re-validate the stored key now
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.audit import record
from backend.auth import AuthenticatedUser, get_current_user
from backend.database import get_db
from backend.models import User
from backend.routers.templates import _resolve_user
from backend.services import entitlements, lmfwc, telemetry

router = APIRouter(prefix="/api/billing", tags=["billing"])


class LicenseActivate(BaseModel):
    license_key: str = Field(min_length=8, max_length=128)


class StatusOut(BaseModel):
    plan: str
    license_key_masked: str | None
    license_status: str | None
    license_expires_at: str | None
    in_grace_period: bool
    limits: dict
    features: list[str]
    server_configured: bool


def _status_payload(user: User) -> dict:
    ent = entitlements.for_user(user)
    payload = entitlements.to_public_dict(ent)
    payload["server_configured"] = lmfwc.is_configured()
    return payload


@router.get("/status", response_model=StatusOut)
def get_status(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    user = _resolve_user(db, auth)
    return _status_payload(user)


@router.post("/license", response_model=StatusOut)
def activate(
    payload: LicenseActivate,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    user = _resolve_user(db, auth)
    if not lmfwc.is_configured():
        raise HTTPException(503, "License server not configured on this deployment")

    key = payload.license_key.strip()

    # Don't let one user steal another user's key.
    other = (
        db.query(User)
        .filter(User.license_key == key, User.id != user.id)
        .one_or_none()
    )
    if other is not None:
        raise HTTPException(409, "License key already in use by another account")

    validation = lmfwc.validate_license(key)
    if not validation.valid:
        record(
            db, user, "license.activate.failed",
            payload={"reason": validation.message},
        )
        telemetry.emit(user, "license_invalid", {"reason": validation.message})
        raise HTTPException(400, validation.message or "License invalid")

    activation = lmfwc.activate_license(key, str(user.id))
    if not activation.ok:
        record(
            db, user, "license.activate.failed",
            payload={"reason": activation.message},
        )
        raise HTTPException(409, activation.message or "Could not activate license")

    user.license_key = key
    user.tier = validation.plan
    user.license_status = "active"
    user.license_expires_at = validation.expires_at
    user.license_activations_used = validation.activations_used
    user.license_activations_max = validation.activations_max
    user.license_validated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(user)

    record(
        db, user, "license.activated",
        payload={"plan": validation.plan, "already_done": activation.already_done},
    )
    telemetry.emit(user, "license_activated", {"tier": validation.plan})
    return _status_payload(user)


@router.delete("/license", response_model=StatusOut)
def deactivate(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    user = _resolve_user(db, auth)
    if not user.license_key:
        return _status_payload(user)

    prev_key = user.license_key
    prev_tier = user.tier

    if lmfwc.is_configured():
        result = lmfwc.deactivate_license(prev_key, str(user.id))
        if not result.ok:
            raise HTTPException(502, result.message or "Could not deactivate license upstream")

    user.license_key = None
    user.tier = "internal_beta"
    user.license_status = "inactive"
    user.license_expires_at = None
    user.license_activations_used = None
    user.license_activations_max = None
    db.commit()
    db.refresh(user)

    record(
        db, user, "license.deactivated",
        payload={"previous_tier": prev_tier},
    )
    telemetry.emit(user, "license_deactivated", {"tier": prev_tier})
    return _status_payload(user)


@router.post("/license/refresh", response_model=StatusOut)
def refresh(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Re-hit LMFWC for the stored key. Useful after upgrades / renewals on
    the WooCommerce side."""
    user = _resolve_user(db, auth)
    if not user.license_key:
        raise HTTPException(404, "No license key on file")
    if not lmfwc.is_configured():
        raise HTTPException(503, "License server not configured")

    validation = lmfwc.validate_license(user.license_key)
    if validation.valid:
        user.tier = validation.plan
        user.license_status = "active"
        user.license_expires_at = validation.expires_at
        user.license_activations_used = validation.activations_used
        user.license_activations_max = validation.activations_max
        user.license_validated_at = datetime.now(timezone.utc)
    else:
        # Don't wipe the key on transient failures - the entitlements grace
        # period will keep the user on their plan for 72h before locking out.
        user.license_status = "invalid"
    db.commit()
    db.refresh(user)
    return _status_payload(user)
