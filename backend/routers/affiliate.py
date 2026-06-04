"""Affiliate router — public click tracking, authenticated dashboard, Connect onboarding."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from backend.auth import AuthenticatedUser, get_current_user
from backend.config import get_settings
from backend.database import get_db
from backend.models.affiliate import (
    AffiliateClick,
    AffiliateConversion,
    AffiliateEvent,
    AffiliateProfile,
)
from backend.models.trial_invite import TrialInvite, generate_token
from backend.models.user import User
from backend.services import affiliate_service, invite_email, stripe_connect

router = APIRouter(prefix="/api/affiliate", tags=["affiliate"])

# Affiliates hand out a fixed 30-day trial. The link itself also lives 30 days.
AFFILIATE_TRIAL_DAYS = 30
_INVITE_LINK_LIFETIME = timedelta(days=30)


def _base_url(request: Request) -> str:
    configured = (get_settings().public_base_url or "").strip()
    if configured:
        return configured.rstrip("/")
    return str(request.base_url).rstrip("/")


def _invite_status(invite: TrialInvite, now: datetime) -> str:
    if invite.revoked_at is not None:
        return "revoked"
    if invite.accepted_at is not None:
        return "accepted"
    expires = invite.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= now:
        return "expired"
    return "pending"


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class AffiliateSignupRequest(BaseModel):
    email: EmailStr
    name: Optional[str] = None


class AffiliateSignupResponse(BaseModel):
    ref_code: str
    message: str


class AffiliateDashboardResponse(BaseModel):
    ref_code: str
    status: str
    commission_rate: float
    pending_balance_pence: int
    total_earned_pence: int
    total_paid_pence: int
    min_payout_threshold_pence: int
    stripe_connect_onboarding_complete: bool
    total_clicks: int
    total_conversions: int
    recent_clicks_30d: int
    conversion_rate: float
    total_signups: int
    total_leads: int
    signups_30d: int
    signup_to_sale_rate: float
    is_ghost: bool
    vanity_slug: Optional[str]
    share_link: str
    can_send_invites: bool


class SendInviteRequest(BaseModel):
    email: EmailStr
    note: Optional[str] = None


class AffiliateInviteOut(BaseModel):
    email: str
    status: str  # pending | accepted | expired | revoked
    trial_days: int
    created_at: str
    sent_at: Optional[str]
    accepted_at: Optional[str]


class SendInviteResponse(BaseModel):
    invite: AffiliateInviteOut
    sent: bool
    send_error: Optional[str] = None


class ConnectOnboardingResponse(BaseModel):
    url: str


class RecentClickOut(BaseModel):
    clicked_at: str
    landing_path: Optional[str]
    converted: bool


class RecentConversionOut(BaseModel):
    converted_at: str
    commission_pence: int
    status: str
    stripe_charge_amount_pence: int


class RecentEventOut(BaseModel):
    created_at: str
    event_type: str  # signup | lead
    detail: Optional[str]


# ---------------------------------------------------------------------------
# Public — click tracking
# ---------------------------------------------------------------------------

@router.get("/click/{ref_code}")
def track_click(
    ref_code: str,
    request: Request,
    db: Session = Depends(get_db),
    next: str = Query(default="/register"),
):
    """Record a click and redirect to the registration page with ref param."""
    profile = affiliate_service.get_profile_by_ref_code(db, ref_code)
    if not profile or profile.status != "active":
        return RedirectResponse(url="/register", status_code=302)

    ip = request.client.host if request.client else "0.0.0.0"
    ua = request.headers.get("user-agent", "")
    affiliate_service.record_click(
        db, affiliate_id=profile.id, ip=ip, user_agent=ua, landing_path=next,
    )
    db.commit()

    target = f"/register?ref={ref_code}"
    return RedirectResponse(url=target, status_code=302)


# ---------------------------------------------------------------------------
# Public — affiliate signup (non-customers)
# ---------------------------------------------------------------------------

@router.post("/signup", response_model=AffiliateSignupResponse)
def affiliate_signup(
    body: AffiliateSignupRequest,
    db: Session = Depends(get_db),
):
    """Create an affiliate profile for a non-customer. No login required."""
    existing = db.query(AffiliateProfile).filter(
        AffiliateProfile.email == body.email.lower()
    ).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An affiliate account with this email already exists.",
        )

    profile = affiliate_service.create_profile(
        db, email=body.email.lower(), name=body.name
    )
    db.commit()
    return AffiliateSignupResponse(
        ref_code=profile.ref_code,
        message="Affiliate account created. Share your link to start earning!",
    )


# ---------------------------------------------------------------------------
# Authenticated — join as affiliate (existing customer)
# ---------------------------------------------------------------------------

@router.post("/join", response_model=AffiliateSignupResponse)
def join_as_affiliate(
    auth_user: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Existing PrintLay user joins the affiliate programme."""
    user = db.query(User).filter(User.auth_id == auth_user.auth_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    existing = affiliate_service.get_profile_by_user_id(db, user.id)
    if existing:
        return AffiliateSignupResponse(
            ref_code=existing.ref_code,
            message="You're already an affiliate!",
        )

    profile = affiliate_service.create_profile(
        db, email=user.email, user_id=user.id, name=user.company_name
    )
    db.commit()
    return AffiliateSignupResponse(
        ref_code=profile.ref_code,
        message="Welcome to the affiliate programme!",
    )


# ---------------------------------------------------------------------------
# Authenticated — dashboard
# ---------------------------------------------------------------------------

@router.get("/dashboard", response_model=AffiliateDashboardResponse)
def get_dashboard(
    request: Request,
    auth_user: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return affiliate dashboard data for the logged-in user."""
    user = db.query(User).filter(User.auth_id == auth_user.auth_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    profile = affiliate_service.get_profile_by_user_id(db, user.id)
    if not profile:
        raise HTTPException(status_code=404, detail="Not an affiliate")

    stats = affiliate_service.get_affiliate_stats(db, profile.id)

    return AffiliateDashboardResponse(
        ref_code=profile.ref_code,
        status=profile.status,
        commission_rate=profile.commission_rate,
        pending_balance_pence=profile.pending_balance_pence,
        total_earned_pence=profile.total_earned_pence,
        total_paid_pence=profile.total_paid_pence,
        min_payout_threshold_pence=profile.min_payout_threshold_pence,
        stripe_connect_onboarding_complete=profile.stripe_connect_onboarding_complete,
        is_ghost=profile.is_ghost,
        vanity_slug=profile.vanity_slug,
        share_link=affiliate_service.share_link(profile, _base_url(request)),
        can_send_invites=(profile.status == "active"),
        **stats,
    )


# ---------------------------------------------------------------------------
# Authenticated — affiliate-issued 30-day trial invites
# ---------------------------------------------------------------------------

def _require_active_affiliate(auth_user: AuthenticatedUser, db: Session) -> AffiliateProfile:
    user = db.query(User).filter(User.auth_id == auth_user.auth_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    profile = affiliate_service.get_profile_by_user_id(db, user.id)
    if not profile:
        raise HTTPException(status_code=404, detail="Not an affiliate")
    if profile.status != "active":
        raise HTTPException(status_code=403, detail="Your affiliate account is not active.")
    return profile


@router.post("/invites", response_model=SendInviteResponse, status_code=201)
def send_affiliate_invite(
    body: SendInviteRequest,
    auth_user: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Affiliate sends a 30-day free-trial invite to a contact. The invite is
    tagged with their affiliate id so the trial — and any eventual sale —
    attributes back to them automatically."""
    profile = _require_active_affiliate(auth_user, db)
    email_clean = body.email.strip().lower()
    now = datetime.now(timezone.utc)

    # Already a Printlay user? Nothing to invite.
    existing_user = db.query(User).filter(User.email == email_clean).first()
    if existing_user is not None:
        raise HTTPException(
            status_code=409,
            detail="That email already has a Printlay account.",
        )

    # Reuse an existing un-accepted invite for this email (resend) so we don't
    # spawn duplicate tokens; otherwise create a fresh one.
    invite = (
        db.query(TrialInvite)
        .filter(TrialInvite.email == email_clean, TrialInvite.accepted_at.is_(None))
        .order_by(TrialInvite.created_at.desc())
        .first()
    )
    if invite is not None:
        invite.affiliate_id = profile.id
        invite.trial_days = AFFILIATE_TRIAL_DAYS
        invite.expires_at = now + _INVITE_LINK_LIFETIME
        invite.revoked_at = None
        if body.note:
            invite.note = body.note[:500]
    else:
        invite = TrialInvite(
            email=email_clean,
            token=generate_token(),
            trial_days=AFFILIATE_TRIAL_DAYS,
            note=(body.note or None),
            invited_by_user_id=profile.user_id,
            affiliate_id=profile.id,
            expires_at=now + _INVITE_LINK_LIFETIME,
        )
        db.add(invite)
    db.flush()

    result = invite_email.send(
        recipient_email=email_clean,
        trial_days=AFFILIATE_TRIAL_DAYS,
        token=invite.token,
    )
    if result.ok:
        invite.sent_at = datetime.now(timezone.utc)

    # Log the invite as a funnel event for the affiliate (savepoint-safe).
    try:
        with db.begin_nested():
            affiliate_service.record_event(
                db,
                affiliate_id=profile.id,
                event_type="invite",
                detail=f"invite · {email_clean.split('@', 1)[-1]}",
            )
    except Exception:
        import logging
        logging.getLogger(__name__).exception("Failed to record affiliate invite event")

    db.commit()
    db.refresh(invite)

    return SendInviteResponse(
        invite=AffiliateInviteOut(
            email=invite.email,
            status=_invite_status(invite, datetime.now(timezone.utc)),
            trial_days=invite.trial_days,
            created_at=invite.created_at.isoformat(),
            sent_at=invite.sent_at.isoformat() if invite.sent_at else None,
            accepted_at=invite.accepted_at.isoformat() if invite.accepted_at else None,
        ),
        sent=result.ok,
        send_error=result.error,
    )


@router.get("/invites", response_model=list[AffiliateInviteOut])
def list_affiliate_invites(
    auth_user: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = Query(default=100, le=300),
):
    """List the invites this affiliate has sent, newest first."""
    profile = _require_active_affiliate(auth_user, db)
    now = datetime.now(timezone.utc)
    invites = (
        db.query(TrialInvite)
        .filter(TrialInvite.affiliate_id == profile.id)
        .order_by(TrialInvite.created_at.desc())
        .limit(limit)
        .all()
    )
    return [
        AffiliateInviteOut(
            email=i.email,
            status=_invite_status(i, now),
            trial_days=i.trial_days,
            created_at=i.created_at.isoformat(),
            sent_at=i.sent_at.isoformat() if i.sent_at else None,
            accepted_at=i.accepted_at.isoformat() if i.accepted_at else None,
        )
        for i in invites
    ]


@router.get("/clicks", response_model=list[RecentClickOut])
def get_recent_clicks(
    auth_user: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = Query(default=50, le=200),
):
    """Return recent clicks for the affiliate."""
    user = db.query(User).filter(User.auth_id == auth_user.auth_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    profile = affiliate_service.get_profile_by_user_id(db, user.id)
    if not profile:
        raise HTTPException(status_code=404, detail="Not an affiliate")

    clicks = (
        db.query(AffiliateClick)
        .filter(AffiliateClick.affiliate_id == profile.id)
        .order_by(AffiliateClick.clicked_at.desc())
        .limit(limit)
        .all()
    )
    return [
        RecentClickOut(
            clicked_at=c.clicked_at.isoformat(),
            landing_path=c.landing_path,
            converted=c.converted,
        )
        for c in clicks
    ]


@router.get("/conversions", response_model=list[RecentConversionOut])
def get_recent_conversions(
    auth_user: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = Query(default=50, le=200),
):
    """Return recent conversions for the affiliate."""
    user = db.query(User).filter(User.auth_id == auth_user.auth_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    profile = affiliate_service.get_profile_by_user_id(db, user.id)
    if not profile:
        raise HTTPException(status_code=404, detail="Not an affiliate")

    conversions = (
        db.query(AffiliateConversion)
        .filter(AffiliateConversion.affiliate_id == profile.id)
        .order_by(AffiliateConversion.converted_at.desc())
        .limit(limit)
        .all()
    )
    return [
        RecentConversionOut(
            converted_at=c.converted_at.isoformat(),
            commission_pence=c.commission_pence,
            status=c.status,
            stripe_charge_amount_pence=c.stripe_charge_amount_pence,
        )
        for c in conversions
    ]


@router.get("/events", response_model=list[RecentEventOut])
def get_recent_events(
    auth_user: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = Query(default=50, le=200),
):
    """Return recent funnel events (signups / leads) for the affiliate."""
    user = db.query(User).filter(User.auth_id == auth_user.auth_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    profile = affiliate_service.get_profile_by_user_id(db, user.id)
    if not profile:
        raise HTTPException(status_code=404, detail="Not an affiliate")

    events = (
        db.query(AffiliateEvent)
        .filter(AffiliateEvent.affiliate_id == profile.id)
        .order_by(AffiliateEvent.created_at.desc())
        .limit(limit)
        .all()
    )
    return [
        RecentEventOut(
            created_at=e.created_at.isoformat(),
            event_type=e.event_type,
            detail=e.detail,
        )
        for e in events
    ]


# ---------------------------------------------------------------------------
# Authenticated — Stripe Connect onboarding
# ---------------------------------------------------------------------------

@router.post("/connect/onboard", response_model=ConnectOnboardingResponse)
def start_connect_onboarding(
    request: Request,
    auth_user: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create or resume Stripe Connect Express onboarding."""
    user = db.query(User).filter(User.auth_id == auth_user.auth_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    profile = affiliate_service.get_profile_by_user_id(db, user.id)
    if not profile:
        raise HTTPException(status_code=404, detail="Not an affiliate")

    base_url = str(request.base_url).rstrip("/")

    if not profile.stripe_connect_account_id:
        account_id = stripe_connect.create_express_account(profile.email)
        profile.stripe_connect_account_id = account_id
        db.flush()

    url = stripe_connect.create_onboarding_link(
        account_id=profile.stripe_connect_account_id,
        refresh_url=f"{base_url}/app/affiliate?connect=refresh",
        return_url=f"{base_url}/app/affiliate?connect=complete",
    )
    db.commit()
    return ConnectOnboardingResponse(url=url)


@router.post("/connect/check")
def check_connect_status(
    auth_user: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Check and update Connect onboarding completion status."""
    user = db.query(User).filter(User.auth_id == auth_user.auth_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    profile = affiliate_service.get_profile_by_user_id(db, user.id)
    if not profile or not profile.stripe_connect_account_id:
        raise HTTPException(status_code=404, detail="No Connect account found")

    complete = stripe_connect.check_onboarding_complete(profile.stripe_connect_account_id)
    if complete and not profile.stripe_connect_onboarding_complete:
        profile.stripe_connect_onboarding_complete = True
        db.commit()

    return {"onboarding_complete": complete}


@router.get("/connect/login-link")
def get_connect_login_link(
    auth_user: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Get a login link to the affiliate's Stripe Express dashboard."""
    user = db.query(User).filter(User.auth_id == auth_user.auth_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    profile = affiliate_service.get_profile_by_user_id(db, user.id)
    if not profile or not profile.stripe_connect_account_id:
        raise HTTPException(status_code=404, detail="No Connect account found")

    if not profile.stripe_connect_onboarding_complete:
        raise HTTPException(status_code=400, detail="Onboarding not complete")

    url = stripe_connect.create_login_link(profile.stripe_connect_account_id)
    return {"url": url}
