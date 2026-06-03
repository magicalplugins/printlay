"""Admin affiliate endpoints — list affiliates, analytics, overrides, payouts."""
from __future__ import annotations

import uuid as _uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.auth import require_admin
from backend.database import get_db
from backend.models.affiliate import (
    AffiliateClick,
    AffiliateConversion,
    AffiliatePayout,
    AffiliateProfile,
)
from backend.services import affiliate_service

router = APIRouter(
    prefix="/api/admin/affiliate",
    tags=["admin-affiliate"],
    dependencies=[Depends(require_admin)],
)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class AffiliateListItem(BaseModel):
    id: str
    email: str
    name: Optional[str]
    ref_code: str
    status: str
    commission_rate: float
    pending_balance_pence: int
    total_earned_pence: int
    total_paid_pence: int
    stripe_connect_onboarding_complete: bool
    total_clicks: int
    total_conversions: int
    created_at: str


class AdminOverviewResponse(BaseModel):
    total_affiliates: int
    active_affiliates: int
    total_clicks: int
    total_conversions: int
    total_commission_pence: int
    total_paid_pence: int
    pending_balance_pence: int


class UpdateAffiliateRequest(BaseModel):
    status: Optional[str] = None
    commission_rate: Optional[float] = None
    min_payout_threshold_pence: Optional[int] = None


class PayoutRunResult(BaseModel):
    results: list[dict]
    conversions_approved: int


class ConversionOverrideRequest(BaseModel):
    status: str  # 'approved' or 'reversed'


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/overview", response_model=AdminOverviewResponse)
def admin_overview(db: Session = Depends(get_db)):
    """High-level programme statistics."""
    data = affiliate_service.get_admin_overview(db)
    return AdminOverviewResponse(**data)


@router.get("/list", response_model=list[AffiliateListItem])
def list_affiliates(
    db: Session = Depends(get_db),
    status_filter: Optional[str] = Query(default=None, alias="status"),
):
    """List all affiliates with stats."""
    q = db.query(AffiliateProfile)
    if status_filter:
        q = q.filter(AffiliateProfile.status == status_filter)
    profiles = q.order_by(AffiliateProfile.created_at.desc()).all()

    results = []
    for p in profiles:
        clicks = db.query(func.count(AffiliateClick.id)).filter(
            AffiliateClick.affiliate_id == p.id
        ).scalar() or 0
        conversions = db.query(func.count(AffiliateConversion.id)).filter(
            AffiliateConversion.affiliate_id == p.id
        ).scalar() or 0

        results.append(AffiliateListItem(
            id=str(p.id),
            email=p.email,
            name=p.name,
            ref_code=p.ref_code,
            status=p.status,
            commission_rate=p.commission_rate,
            pending_balance_pence=p.pending_balance_pence,
            total_earned_pence=p.total_earned_pence,
            total_paid_pence=p.total_paid_pence,
            stripe_connect_onboarding_complete=p.stripe_connect_onboarding_complete,
            total_clicks=clicks,
            total_conversions=conversions,
            created_at=p.created_at.isoformat(),
        ))

    return results


@router.patch("/{affiliate_id}")
def update_affiliate(
    affiliate_id: str,
    body: UpdateAffiliateRequest,
    db: Session = Depends(get_db),
):
    """Admin override — change status, commission rate, or threshold."""
    profile = db.query(AffiliateProfile).filter(
        AffiliateProfile.id == _uuid.UUID(affiliate_id)
    ).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Affiliate not found")

    if body.status is not None:
        if body.status not in ("active", "paused", "banned"):
            raise HTTPException(status_code=400, detail="Invalid status")
        profile.status = body.status
    if body.commission_rate is not None:
        if not (0 < body.commission_rate <= 1.0):
            raise HTTPException(status_code=400, detail="Commission rate must be between 0 and 1")
        profile.commission_rate = body.commission_rate
    if body.min_payout_threshold_pence is not None:
        profile.min_payout_threshold_pence = body.min_payout_threshold_pence

    db.commit()
    return {"ok": True}


@router.post("/conversions/{conversion_id}/override")
def override_conversion(
    conversion_id: str,
    body: ConversionOverrideRequest,
    db: Session = Depends(get_db),
):
    """Manually approve or reverse a conversion."""
    conv = db.query(AffiliateConversion).filter(
        AffiliateConversion.id == _uuid.UUID(conversion_id)
    ).first()
    if not conv:
        raise HTTPException(status_code=404, detail="Conversion not found")

    if body.status not in ("approved", "reversed"):
        raise HTTPException(status_code=400, detail="Status must be 'approved' or 'reversed'")

    old_status = conv.status
    conv.status = body.status

    profile = db.query(AffiliateProfile).filter(
        AffiliateProfile.id == conv.affiliate_id
    ).first()

    if body.status == "approved" and old_status == "pending":
        from datetime import datetime, timezone
        conv.approved_at = datetime.now(timezone.utc)
        profile.pending_balance_pence += conv.commission_pence
        profile.total_earned_pence += conv.commission_pence
    elif body.status == "reversed" and old_status == "approved":
        profile.pending_balance_pence = max(0, profile.pending_balance_pence - conv.commission_pence)
        profile.total_earned_pence = max(0, profile.total_earned_pence - conv.commission_pence)

    db.commit()
    return {"ok": True, "new_status": conv.status}


@router.post("/payouts/run", response_model=PayoutRunResult)
def run_payouts(db: Session = Depends(get_db)):
    """Approve held conversions and run payouts for eligible affiliates."""
    approved_count = affiliate_service.approve_held_conversions(db)
    results = affiliate_service.run_payouts(db)
    db.commit()
    return PayoutRunResult(results=results, conversions_approved=approved_count)


@router.get("/payouts", response_model=list[dict])
def list_payouts(
    db: Session = Depends(get_db),
    limit: int = Query(default=50, le=200),
):
    """List recent payouts across all affiliates."""
    payouts = (
        db.query(AffiliatePayout)
        .order_by(AffiliatePayout.created_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": str(p.id),
            "affiliate_id": str(p.affiliate_id),
            "amount_pence": p.amount_pence,
            "status": p.status,
            "stripe_transfer_id": p.stripe_transfer_id,
            "period_start": p.period_start.isoformat(),
            "period_end": p.period_end.isoformat(),
            "paid_at": p.paid_at.isoformat() if p.paid_at else None,
            "created_at": p.created_at.isoformat(),
        }
        for p in payouts
    ]
