"""Admin affiliate endpoints — list affiliates, analytics, overrides, payouts."""
from __future__ import annotations

import uuid as _uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, EmailStr
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.auth import require_admin
from backend.config import get_settings
from backend.database import get_db
from backend.models.affiliate import (
    AffiliateClick,
    AffiliateConversion,
    AffiliateEvent,
    AffiliatePayout,
    AffiliateProfile,
)
from backend.models.trial_invite import TrialInvite
from backend.models.user import User
from backend.services import affiliate_service, affiliate_welcome_email

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
    total_signups: int
    total_leads: int
    is_ghost: bool
    vanity_slug: Optional[str]
    share_link: str
    has_account: bool
    created_at: str


class CreateGhostRequest(BaseModel):
    email: EmailStr
    name: Optional[str] = None
    vanity_slug: str
    commission_rate: float = 0.20


class GhostCreatedResponse(BaseModel):
    id: str
    ref_code: str
    vanity_slug: str
    share_link: str
    welcome_email_sent: bool
    welcome_email_error: Optional[str] = None


class ReferralOut(BaseModel):
    user_id: Optional[str]
    email: str
    signed_up_at: Optional[str]
    trial_ends_at: Optional[str]
    is_trialing: bool
    subscription_status: Optional[str]
    has_paid: bool
    commission_pence: int
    status: str  # invited | trial | expired | customer


class AffiliateDetailResponse(BaseModel):
    id: str
    email: str
    name: Optional[str]
    referrals: list[ReferralOut]


class AdminOverviewResponse(BaseModel):
    total_affiliates: int
    active_affiliates: int
    total_clicks: int
    total_conversions: int
    total_commission_pence: int
    total_paid_pence: int
    pending_balance_pence: int
    total_signups: int
    total_leads: int


class UpdateAffiliateRequest(BaseModel):
    status: Optional[str] = None
    commission_rate: Optional[float] = None
    min_payout_threshold_pence: Optional[int] = None
    vanity_slug: Optional[str] = None


class PayoutRunResult(BaseModel):
    results: list[dict]
    conversions_approved: int


class ConversionOverrideRequest(BaseModel):
    status: str  # 'approved' or 'reversed'


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

def _base_url(request: Request) -> str:
    """Prefer the configured public base URL (correct scheme/host behind a
    proxy); fall back to the request's own base URL in dev."""
    configured = (get_settings().public_base_url or "").strip()
    if configured:
        return configured.rstrip("/")
    return str(request.base_url).rstrip("/")


@router.get("/overview", response_model=AdminOverviewResponse)
def admin_overview(db: Session = Depends(get_db)):
    """High-level programme statistics."""
    data = affiliate_service.get_admin_overview(db)
    return AdminOverviewResponse(**data)


@router.get("/list", response_model=list[AffiliateListItem])
def list_affiliates(
    request: Request,
    db: Session = Depends(get_db),
    status_filter: Optional[str] = Query(default=None, alias="status"),
):
    """List all affiliates with stats."""
    base_url = _base_url(request)
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
        signups = db.query(func.count(AffiliateEvent.id)).filter(
            AffiliateEvent.affiliate_id == p.id,
            AffiliateEvent.event_type == affiliate_service.EVENT_SIGNUP,
        ).scalar() or 0
        leads = db.query(func.count(AffiliateEvent.id)).filter(
            AffiliateEvent.affiliate_id == p.id,
            AffiliateEvent.event_type == affiliate_service.EVENT_LEAD,
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
            total_signups=signups,
            total_leads=leads,
            is_ghost=p.is_ghost,
            vanity_slug=p.vanity_slug,
            share_link=affiliate_service.share_link(p, base_url),
            has_account=p.user_id is not None,
            created_at=p.created_at.isoformat(),
        ))

    return results


@router.post("/create-ghost", response_model=GhostCreatedResponse, status_code=201)
def create_ghost_affiliate(
    body: CreateGhostRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Manually create a hand-picked ('ghost') affiliate with a vanity link
    and auto-send their welcome email. The affiliate account stays locked
    (no product access) until they sign up and you choose to grant a trial."""
    email = body.email.lower()

    if not (0 < body.commission_rate <= 1.0):
        raise HTTPException(status_code=400, detail="Commission rate must be between 0 and 1.")

    try:
        slug = affiliate_service.normalize_vanity_slug(body.vanity_slug)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if affiliate_service.get_profile_by_email(db, email):
        raise HTTPException(status_code=409, detail="An affiliate with this email already exists.")
    if affiliate_service.get_profile_by_vanity_slug(db, slug):
        raise HTTPException(status_code=409, detail=f"The handle '{slug}' is already taken.")

    profile = affiliate_service.create_profile(
        db,
        email=email,
        name=body.name,
        commission_rate=body.commission_rate,
        is_ghost=True,
        vanity_slug=slug,
    )

    # If a PrintLay account already exists for this email, link it now so the
    # affiliate can reach their dashboard immediately. We do NOT touch their
    # trial/subscription — an existing customer keeps whatever access they had.
    existing_user = db.query(User).filter(User.email == email).first()
    if existing_user is not None:
        profile.user_id = existing_user.id

    db.flush()

    base_url = _base_url(request)
    link = affiliate_service.share_link(profile, base_url)

    result = affiliate_welcome_email.send(
        recipient_email=email,
        name=body.name,
        share_url=link,
        commission_rate=body.commission_rate,
    )
    if result.ok:
        profile.welcome_email_sent_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(profile)

    return GhostCreatedResponse(
        id=str(profile.id),
        ref_code=profile.ref_code,
        vanity_slug=slug,
        share_link=link,
        welcome_email_sent=result.ok,
        welcome_email_error=result.error,
    )


@router.post("/{affiliate_id}/resend-welcome")
def resend_welcome(
    affiliate_id: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """Re-send the partner welcome email."""
    profile = db.query(AffiliateProfile).filter(
        AffiliateProfile.id == _uuid.UUID(affiliate_id)
    ).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Affiliate not found")

    link = affiliate_service.share_link(profile, _base_url(request))
    result = affiliate_welcome_email.send(
        recipient_email=profile.email,
        name=profile.name,
        share_url=link,
        commission_rate=profile.commission_rate,
    )
    if result.ok:
        profile.welcome_email_sent_at = datetime.now(timezone.utc)
        db.commit()
    return {"ok": result.ok, "error": result.error}


@router.get("/{affiliate_id}/referrals", response_model=AffiliateDetailResponse)
def affiliate_referrals(
    affiliate_id: str,
    db: Session = Depends(get_db),
):
    """Per-affiliate drill-down: everyone they referred (via link or invite),
    with trial / subscription / sale status so you can see exactly who signed
    up, who's on a trial, and who became a paying customer."""
    aid = _uuid.UUID(affiliate_id)
    profile = db.query(AffiliateProfile).filter(AffiliateProfile.id == aid).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Affiliate not found")

    now = datetime.now(timezone.utc)

    # Map referred_user_id -> latest conversion (the sale, if any).
    conv_rows = (
        db.query(AffiliateConversion)
        .filter(AffiliateConversion.affiliate_id == aid)
        .all()
    )
    conv_by_user: dict[_uuid.UUID, AffiliateConversion] = {}
    for c in conv_rows:
        existing = conv_by_user.get(c.referred_user_id)
        if existing is None or c.converted_at > existing.converted_at:
            conv_by_user[c.referred_user_id] = c

    referrals: list[ReferralOut] = []

    # 1. Users attributed to this affiliate (signed up).
    users = (
        db.query(User)
        .filter(User.referred_by_affiliate_id == aid)
        .order_by(User.created_at.desc())
        .all()
    )
    referred_emails: set[str] = set()
    for u in users:
        referred_emails.add((u.email or "").lower())
        conv = conv_by_user.get(u.id)
        trial_end = u.trial_ends_at
        if trial_end is not None and trial_end.tzinfo is None:
            trial_end = trial_end.replace(tzinfo=timezone.utc)
        is_trialing = trial_end is not None and trial_end > now
        sub_active = u.stripe_subscription_status == "active"
        has_paid = conv is not None
        if has_paid:
            status_label = "customer"
        elif sub_active:
            status_label = "customer"
        elif is_trialing:
            status_label = "trial"
        else:
            status_label = "expired"
        referrals.append(ReferralOut(
            user_id=str(u.id),
            email=u.email,
            signed_up_at=u.created_at.isoformat() if u.created_at else None,
            trial_ends_at=trial_end.isoformat() if trial_end else None,
            is_trialing=is_trialing,
            subscription_status=u.stripe_subscription_status,
            has_paid=has_paid,
            commission_pence=conv.commission_pence if conv else 0,
            status=status_label,
        ))

    # 2. Invites this affiliate sent that haven't been claimed yet (still in
    #    the funnel as "invited" — no account yet).
    invites = (
        db.query(TrialInvite)
        .filter(TrialInvite.affiliate_id == aid, TrialInvite.accepted_at.is_(None))
        .order_by(TrialInvite.created_at.desc())
        .all()
    )
    for inv in invites:
        if (inv.email or "").lower() in referred_emails:
            continue
        referrals.append(ReferralOut(
            user_id=None,
            email=inv.email,
            signed_up_at=None,
            trial_ends_at=None,
            is_trialing=False,
            subscription_status=None,
            has_paid=False,
            commission_pence=0,
            status="invited",
        ))

    return AffiliateDetailResponse(
        id=str(profile.id),
        email=profile.email,
        name=profile.name,
        referrals=referrals,
    )


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
    if body.vanity_slug is not None:
        slug = body.vanity_slug.strip()
        if slug == "":
            profile.vanity_slug = None
        else:
            try:
                slug = affiliate_service.normalize_vanity_slug(slug)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            clash = affiliate_service.get_profile_by_vanity_slug(db, slug)
            if clash and clash.id != profile.id:
                raise HTTPException(status_code=409, detail=f"The handle '{slug}' is already taken.")
            profile.vanity_slug = slug

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
