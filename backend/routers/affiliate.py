"""Affiliate router — public click tracking, authenticated dashboard, Connect onboarding."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from backend.auth import AuthenticatedUser, get_current_user
from backend.database import get_db
from backend.models.affiliate import AffiliateClick, AffiliateConversion, AffiliateProfile
from backend.models.user import User
from backend.services import affiliate_service, stripe_connect

router = APIRouter(prefix="/api/affiliate", tags=["affiliate"])


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
        **stats,
    )


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
