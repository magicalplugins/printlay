"""Affiliate business logic — ref code generation, click/conversion tracking, payout runner.

Pure domain logic — no HTTP concerns. Called by routers and webhook handlers.
"""
from __future__ import annotations

import hashlib
import logging
import re
import secrets
import string
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from backend.models.affiliate import (
    AffiliateClick,
    AffiliateConversion,
    AffiliateEvent,
    AffiliatePayout,
    AffiliateProfile,
)
from backend.models.user import User
from backend.services import stripe_connect

log = logging.getLogger(__name__)

HOLD_DAYS = 14
REF_CODE_LENGTH = 8


# ---------------------------------------------------------------------------
# Ref code generation
# ---------------------------------------------------------------------------

def generate_ref_code() -> str:
    """Generate a short alphanumeric ref code (lowercase, URL-safe)."""
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(REF_CODE_LENGTH))


def ensure_unique_ref_code(db: Session) -> str:
    """Generate a ref code that doesn't collide with existing ones."""
    for _ in range(10):
        code = generate_ref_code()
        exists = db.execute(
            select(AffiliateProfile.id).where(AffiliateProfile.ref_code == code)
        ).scalar_one_or_none()
        if not exists:
            return code
    raise RuntimeError("Failed to generate unique ref code after 10 attempts")


# ---------------------------------------------------------------------------
# Profile management
# ---------------------------------------------------------------------------

def create_profile(
    db: Session,
    email: str,
    user_id: Optional[UUID] = None,
    name: Optional[str] = None,
    commission_rate: float = 0.20,
    is_ghost: bool = False,
    vanity_slug: Optional[str] = None,
) -> AffiliateProfile:
    """Create a new affiliate profile with a unique ref code."""
    ref_code = ensure_unique_ref_code(db)
    profile = AffiliateProfile(
        email=email.lower(),
        user_id=user_id,
        name=name,
        ref_code=ref_code,
        commission_rate=commission_rate,
        status="active",
        is_ghost=is_ghost,
        vanity_slug=vanity_slug,
    )
    db.add(profile)
    db.flush()
    log.info(
        "Created affiliate profile %s (ref=%s, ghost=%s, slug=%s) for %s",
        profile.id, ref_code, is_ghost, vanity_slug, email,
    )
    return profile


def share_link(profile: AffiliateProfile, base_url: str) -> str:
    """The natural-looking link an affiliate shares. Ghost affiliates get a
    vanity URL (base/<slug>); everyone else gets the short /r/<ref_code>."""
    base = base_url.rstrip("/")
    if profile.vanity_slug:
        return f"{base}/{profile.vanity_slug}"
    return f"{base}/r/{profile.ref_code}"


def get_profile_by_ref_code(db: Session, ref_code: str) -> Optional[AffiliateProfile]:
    return db.execute(
        select(AffiliateProfile).where(AffiliateProfile.ref_code == ref_code)
    ).scalar_one_or_none()


def get_profile_by_user_id(db: Session, user_id: UUID) -> Optional[AffiliateProfile]:
    return db.execute(
        select(AffiliateProfile).where(AffiliateProfile.user_id == user_id)
    ).scalar_one_or_none()


def get_profile_by_email(db: Session, email: str) -> Optional[AffiliateProfile]:
    return db.execute(
        select(AffiliateProfile).where(AffiliateProfile.email == email.lower())
    ).scalar_one_or_none()


def get_profile_by_vanity_slug(db: Session, slug: str) -> Optional[AffiliateProfile]:
    return db.execute(
        select(AffiliateProfile).where(AffiliateProfile.vanity_slug == slug.lower())
    ).scalar_one_or_none()


# ---------------------------------------------------------------------------
# Vanity slug validation
# ---------------------------------------------------------------------------

# Single-segment paths the frontend/router already own. A vanity slug can
# never be one of these, otherwise printlay.co.uk/<slug> would hijack a real
# page. Keep this in sync with top-level SPA routes + static file names.
RESERVED_SLUGS: frozenset[str] = frozenset({
    "api", "app", "assets", "r", "affiliate", "register", "login", "logout",
    "signup", "signin", "sign-up", "sign-in", "pricing", "terms", "privacy",
    "about", "contact", "support", "help", "docs", "blog", "dashboard",
    "admin", "account", "settings", "profile", "billing", "checkout",
    "invite", "invites", "favicon.ico", "robots.txt", "sitemap.xml",
    "manifest.webmanifest", "index.html", "static", "public", "health",
    "build", "auth", "home", "templates", "jobs", "sheets", "outputs",
    "catalogue", "catalog", "stickers", "sticker", "ghost", "trial",
    "join", "connect", "click", "go", "ref", "u", "s",
})

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$")


def normalize_vanity_slug(raw: str) -> str:
    """Validate + normalize a desired vanity slug. Raises ValueError with a
    human message on any problem so the router can surface it as a 400."""
    slug = (raw or "").strip().lower()
    if not slug:
        raise ValueError("Vanity slug is required.")
    if not _SLUG_RE.match(slug):
        raise ValueError(
            "Use 3–40 lowercase letters, numbers or hyphens "
            "(must start and end with a letter or number)."
        )
    if slug in RESERVED_SLUGS:
        raise ValueError(f"'{slug}' is reserved — pick another handle.")
    return slug


# ---------------------------------------------------------------------------
# Referral cookie
# ---------------------------------------------------------------------------
# Share links land the visitor on the normal site (the homepage), not a
# signup page — they should just see Printlay. We drop a first-party cookie
# carrying the ref code so that whatever they do next (sign up, or submit the
# chat/ticket widget) is still credited to the affiliate for up to 30 days.

REF_COOKIE_NAME = "plref"
REF_COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30-day attribution window


def set_ref_cookie(response, ref_code: str) -> None:
    """Attach the referral-attribution cookie to a response."""
    response.set_cookie(
        REF_COOKIE_NAME,
        ref_code,
        max_age=REF_COOKIE_MAX_AGE,
        path="/",
        httponly=True,
        samesite="lax",
        secure=True,
    )


# ---------------------------------------------------------------------------
# Click tracking
# ---------------------------------------------------------------------------

def _hash_ip(ip: str) -> str:
    """One-way hash of IP for privacy. We don't need the raw IP."""
    return hashlib.sha256(ip.encode()).hexdigest()[:32]


def record_click(
    db: Session,
    affiliate_id: UUID,
    ip: str,
    user_agent: Optional[str] = None,
    landing_path: Optional[str] = None,
) -> AffiliateClick:
    """Record an affiliate link click."""
    click = AffiliateClick(
        affiliate_id=affiliate_id,
        ip_hash=_hash_ip(ip),
        user_agent_snippet=(user_agent or "")[:200] or None,
        landing_path=(landing_path or "")[:512] or None,
    )
    db.add(click)
    db.flush()
    return click


# ---------------------------------------------------------------------------
# Funnel event tracking (signups / leads)
# ---------------------------------------------------------------------------

EVENT_SIGNUP = "signup"
EVENT_LEAD = "lead"


def record_event(
    db: Session,
    affiliate_id: UUID,
    event_type: str,
    *,
    referred_user_id: Optional[UUID] = None,
    lead_id: Optional[UUID] = None,
    detail: Optional[str] = None,
) -> AffiliateEvent:
    """Record a funnel event (signup / lead) for an affiliate. Pure insert —
    the caller owns the transaction/commit."""
    event = AffiliateEvent(
        affiliate_id=affiliate_id,
        event_type=event_type,
        referred_user_id=referred_user_id,
        lead_id=lead_id,
        detail=(detail or "")[:255] or None,
    )
    db.add(event)
    db.flush()
    log.info(
        "Recorded affiliate event: affiliate=%s type=%s user=%s lead=%s",
        affiliate_id, event_type, referred_user_id, lead_id,
    )
    return event


def record_signup_event(
    db: Session,
    affiliate_id: UUID,
    referred_user_id: UUID,
    detail: Optional[str] = None,
) -> Optional[AffiliateEvent]:
    """Record a referred signup/trial once per user (idempotent)."""
    existing = db.execute(
        select(AffiliateEvent.id).where(
            AffiliateEvent.event_type == EVENT_SIGNUP,
            AffiliateEvent.referred_user_id == referred_user_id,
        )
    ).scalar_one_or_none()
    if existing is not None:
        return None
    return record_event(
        db,
        affiliate_id,
        EVENT_SIGNUP,
        referred_user_id=referred_user_id,
        detail=detail,
    )


# ---------------------------------------------------------------------------
# Conversion recording
# ---------------------------------------------------------------------------

def record_conversion(
    db: Session,
    affiliate_id: UUID,
    referred_user_id: UUID,
    stripe_invoice_id: Optional[str],
    charge_amount_pence: int,
    commission_rate: float,
    click_id: Optional[UUID] = None,
) -> AffiliateConversion:
    """Record a conversion when a referred user makes their first payment.

    Creates a PENDING conversion — it will be approved after HOLD_DAYS
    (unless manually reversed by admin).
    """
    commission_pence = int(charge_amount_pence * commission_rate)

    conversion = AffiliateConversion(
        affiliate_id=affiliate_id,
        click_id=click_id,
        referred_user_id=referred_user_id,
        stripe_invoice_id=stripe_invoice_id,
        stripe_charge_amount_pence=charge_amount_pence,
        commission_pence=commission_pence,
        commission_type="first_payment",
        status="pending",
    )
    db.add(conversion)
    db.flush()

    log.info(
        "Recorded conversion: affiliate=%s user=%s amount=%d commission=%d",
        affiliate_id, referred_user_id, charge_amount_pence, commission_pence,
    )
    return conversion


def has_existing_conversion(db: Session, referred_user_id: UUID) -> bool:
    """Check if this user already generated a conversion (one-time model)."""
    exists = db.execute(
        select(AffiliateConversion.id).where(
            AffiliateConversion.referred_user_id == referred_user_id,
            AffiliateConversion.commission_type == "first_payment",
        )
    ).scalar_one_or_none()
    return exists is not None


# ---------------------------------------------------------------------------
# Approval runner (called on schedule or manually)
# ---------------------------------------------------------------------------

def approve_held_conversions(db: Session) -> int:
    """Move pending conversions past the hold period to 'approved' and credit balances.

    Returns count of newly approved conversions.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=HOLD_DAYS)
    pending = db.execute(
        select(AffiliateConversion).where(
            AffiliateConversion.status == "pending",
            AffiliateConversion.converted_at <= cutoff,
        )
    ).scalars().all()

    count = 0
    for conv in pending:
        conv.status = "approved"
        conv.approved_at = datetime.now(timezone.utc)
        db.execute(
            update(AffiliateProfile)
            .where(AffiliateProfile.id == conv.affiliate_id)
            .values(
                pending_balance_pence=AffiliateProfile.pending_balance_pence + conv.commission_pence,
                total_earned_pence=AffiliateProfile.total_earned_pence + conv.commission_pence,
            )
        )
        count += 1

    if count:
        db.flush()
        log.info("Approved %d held conversions", count)
    return count


# ---------------------------------------------------------------------------
# Payout runner
# ---------------------------------------------------------------------------

def run_payouts(db: Session) -> list[dict]:
    """Pay out all affiliates whose approved balance exceeds their threshold.

    Returns a list of payout summaries for admin display.
    """
    now = datetime.now(timezone.utc)
    results: list[dict] = []

    profiles = db.execute(
        select(AffiliateProfile).where(
            AffiliateProfile.status == "active",
            AffiliateProfile.stripe_connect_onboarding_complete.is_(True),
            AffiliateProfile.pending_balance_pence > 0,
        )
    ).scalars().all()

    for profile in profiles:
        if profile.pending_balance_pence < profile.min_payout_threshold_pence:
            continue

        amount = profile.pending_balance_pence

        last_payout = db.execute(
            select(AffiliatePayout)
            .where(AffiliatePayout.affiliate_id == profile.id)
            .order_by(AffiliatePayout.period_end.desc())
            .limit(1)
        ).scalar_one_or_none()

        period_start = last_payout.period_end if last_payout else profile.created_at
        period_end = now

        try:
            transfer_id = stripe_connect.create_transfer(
                account_id=profile.stripe_connect_account_id,
                amount_pence=amount,
                description=f"PrintLay affiliate payout {period_start.date()} → {period_end.date()}",
                idempotency_key=f"payout-{profile.id}-{period_end.isoformat()}",
            )
        except Exception as e:
            log.error("Payout failed for affiliate %s: %s", profile.id, e)
            results.append({"affiliate_id": str(profile.id), "error": str(e)})
            continue

        payout = AffiliatePayout(
            affiliate_id=profile.id,
            stripe_transfer_id=transfer_id,
            amount_pence=amount,
            status="paid",
            period_start=period_start,
            period_end=period_end,
            paid_at=now,
        )
        db.add(payout)

        profile.pending_balance_pence = 0
        profile.total_paid_pence += amount

        results.append({
            "affiliate_id": str(profile.id),
            "amount_pence": amount,
            "transfer_id": transfer_id,
        })

    db.flush()
    log.info("Payout run complete: %d processed", len(results))
    return results


# ---------------------------------------------------------------------------
# Stats helpers (for dashboard / admin)
# ---------------------------------------------------------------------------

def get_affiliate_stats(db: Session, affiliate_id: UUID) -> dict:
    """Return summary stats for the affiliate dashboard."""
    total_clicks = db.execute(
        select(func.count(AffiliateClick.id)).where(
            AffiliateClick.affiliate_id == affiliate_id
        )
    ).scalar() or 0

    total_conversions = db.execute(
        select(func.count(AffiliateConversion.id)).where(
            AffiliateConversion.affiliate_id == affiliate_id
        )
    ).scalar() or 0

    recent_clicks_30d = db.execute(
        select(func.count(AffiliateClick.id)).where(
            AffiliateClick.affiliate_id == affiliate_id,
            AffiliateClick.clicked_at >= datetime.now(timezone.utc) - timedelta(days=30),
        )
    ).scalar() or 0

    total_signups = db.execute(
        select(func.count(AffiliateEvent.id)).where(
            AffiliateEvent.affiliate_id == affiliate_id,
            AffiliateEvent.event_type == EVENT_SIGNUP,
        )
    ).scalar() or 0

    total_leads = db.execute(
        select(func.count(AffiliateEvent.id)).where(
            AffiliateEvent.affiliate_id == affiliate_id,
            AffiliateEvent.event_type == EVENT_LEAD,
        )
    ).scalar() or 0

    signups_30d = db.execute(
        select(func.count(AffiliateEvent.id)).where(
            AffiliateEvent.affiliate_id == affiliate_id,
            AffiliateEvent.event_type == EVENT_SIGNUP,
            AffiliateEvent.created_at >= datetime.now(timezone.utc) - timedelta(days=30),
        )
    ).scalar() or 0

    return {
        "total_clicks": total_clicks,
        "total_conversions": total_conversions,
        "recent_clicks_30d": recent_clicks_30d,
        "conversion_rate": round(total_conversions / total_clicks * 100, 1) if total_clicks else 0.0,
        "total_signups": total_signups,
        "total_leads": total_leads,
        "signups_30d": signups_30d,
        # Trials that turned into paying customers — the metric affiliates
        # (and we) actually care about once trials are flowing.
        "signup_to_sale_rate": round(total_conversions / total_signups * 100, 1) if total_signups else 0.0,
    }


def get_admin_overview(db: Session) -> dict:
    """Return high-level affiliate programme stats for admin."""
    total_affiliates = db.execute(
        select(func.count(AffiliateProfile.id))
    ).scalar() or 0

    active_affiliates = db.execute(
        select(func.count(AffiliateProfile.id)).where(
            AffiliateProfile.status == "active"
        )
    ).scalar() or 0

    total_clicks = db.execute(
        select(func.count(AffiliateClick.id))
    ).scalar() or 0

    total_conversions = db.execute(
        select(func.count(AffiliateConversion.id))
    ).scalar() or 0

    total_earned = db.execute(
        select(func.coalesce(func.sum(AffiliateConversion.commission_pence), 0))
    ).scalar() or 0

    total_paid = db.execute(
        select(func.coalesce(func.sum(AffiliatePayout.amount_pence), 0)).where(
            AffiliatePayout.status == "paid"
        )
    ).scalar() or 0

    pending_balance = db.execute(
        select(func.coalesce(func.sum(AffiliateProfile.pending_balance_pence), 0))
    ).scalar() or 0

    total_signups = db.execute(
        select(func.count(AffiliateEvent.id)).where(
            AffiliateEvent.event_type == EVENT_SIGNUP
        )
    ).scalar() or 0

    total_leads = db.execute(
        select(func.count(AffiliateEvent.id)).where(
            AffiliateEvent.event_type == EVENT_LEAD
        )
    ).scalar() or 0

    return {
        "total_affiliates": total_affiliates,
        "active_affiliates": active_affiliates,
        "total_clicks": total_clicks,
        "total_conversions": total_conversions,
        "total_commission_pence": total_earned,
        "total_paid_pence": total_paid,
        "pending_balance_pence": pending_balance,
        "total_signups": total_signups,
        "total_leads": total_leads,
    }
