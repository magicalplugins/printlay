"""Billing endpoints — Stripe-only.

Public surface:
    GET  /api/billing/status        Current entitlement (cheap, in-process).
    GET  /api/billing/plans         Catalogue of plans + price IDs for the
                                    pricing page.
    POST /api/billing/checkout      Open a Stripe Checkout session and
                                    return its redirect URL.
    POST /api/billing/portal        Open the Stripe Customer Portal for
                                    plan changes / cancellation.
    POST /api/billing/webhook       Public — Stripe → us. Idempotent.
                                    Signature-verified.

The entitlements layer (`services/entitlements.py`) is the single source
of truth for what the user is *allowed* to do. It only ever reads the
`users` row — webhooks keep it in sync.

Why an idempotency table:
    Stripe retries failed deliveries (and occasionally double-delivers
    successful ones). We `INSERT ... ON CONFLICT DO NOTHING` on each
    event ID *before* applying side effects. If the insert is a no-op,
    we return 200 immediately — the event has already been processed.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

import stripe
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from backend.audit import record
from backend.auth import AuthenticatedUser, get_current_user
from backend.config import get_settings
from backend.database import get_db
from backend.models import (
    Asset,
    AssetCategory,
    ColorProfile,
    Job,
    Output,
    StripeEvent,
    Template,
    User,
)
from backend.routers.templates import _resolve_user
from backend.services import entitlements, storage_usage, stripe_billing

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/billing", tags=["billing"])


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

class StatusOut(BaseModel):
    plan: str
    is_trialing: bool
    limits: dict
    features: list[str]
    trial_ends_at: str | None = None
    stripe_subscription_status: str | None = None
    stripe_current_period_end: str | None = None
    founder_member: bool = False


def _status_payload(user: User) -> dict:
    ent = entitlements.for_user(user)
    payload = entitlements.to_public_dict(ent)
    payload["trial_ends_at"] = (
        user.trial_ends_at.isoformat() if user.trial_ends_at else None
    )
    payload["stripe_subscription_status"] = user.stripe_subscription_status
    payload["stripe_current_period_end"] = (
        user.stripe_current_period_end.isoformat()
        if user.stripe_current_period_end
        else None
    )
    payload["founder_member"] = user.founder_member
    return payload


@router.get("/status", response_model=StatusOut)
def get_status(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    user = _resolve_user(db, auth)
    return _status_payload(user)


# ---------------------------------------------------------------------------
# Usage — current period counts vs caps for the dashboard
# ---------------------------------------------------------------------------

class UsageOut(BaseModel):
    """Snapshot of the user's current consumption.

    `*_cap` values are mirrored from Entitlement so the frontend can render
    a progress bar without a second round-trip. `None` = unlimited.
    The frontend should show "Unlimited" for None caps.
    """
    templates_used: int
    templates_cap: int | None

    exports_this_month: int
    exports_cap_per_month: int | None

    jobs_total: int

    asset_count: int
    asset_size_mb_max: int | None  # per-file upload cap (not total)

    # Total stored artwork — catalogue + job uploads, excluding generated
    # outputs. `cap` is the plan's storage_mb_max (None = unlimited).
    storage_mb_used: float
    storage_mb_cap: int | None

    categories_used: int
    categories_cap: int | None

    color_profiles_used: int
    color_profiles_cap: int | None

    last_export_at: str | None
    period_start: str  # start of the current month (used for "exports this month")


@router.get("/usage", response_model=UsageOut)
def get_usage(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Return the user's current resource consumption.

    Cheap — five COUNT queries scoped to the user. Designed to be called
    from the Dashboard on mount, not on every keystroke.
    """
    user = _resolve_user(db, auth)
    ent = entitlements.for_user(user)

    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    templates_used = (
        db.query(func.count(Template.id))
        .filter(Template.user_id == user.id)
        .scalar()
        or 0
    )
    exports_this_month = (
        db.query(func.count(Output.id))
        .filter(Output.user_id == user.id, Output.created_at >= month_start)
        .scalar()
        or 0
    )
    jobs_total = (
        db.query(func.count(Job.id)).filter(Job.user_id == user.id).scalar() or 0
    )
    asset_count = (
        db.query(func.count(Asset.id)).filter(Asset.user_id == user.id).scalar() or 0
    )
    # Categories the user OWNS (not subscribed officials — those don't
    # count toward the cap because the user can't mutate them).
    categories_used = (
        db.query(func.count(AssetCategory.id))
        .filter(AssetCategory.user_id == user.id)
        .scalar()
        or 0
    )
    color_profiles_used = (
        db.query(func.count(ColorProfile.id))
        .filter(ColorProfile.user_id == user.id)
        .scalar()
        or 0
    )
    last_export = (
        db.query(func.max(Output.created_at))
        .filter(Output.user_id == user.id)
        .scalar()
    )
    storage_mb_used = round(storage_usage.current_storage_mb(db, user.id), 1)

    return {
        "templates_used": templates_used,
        "templates_cap": ent.quota("templates_max"),
        "exports_this_month": exports_this_month,
        "exports_cap_per_month": ent.quota("exports_per_month"),
        "jobs_total": jobs_total,
        "asset_count": asset_count,
        "asset_size_mb_max": ent.quota("asset_size_mb_max"),
        "storage_mb_used": storage_mb_used,
        "storage_mb_cap": ent.quota("storage_mb_max"),
        "categories_used": categories_used,
        "categories_cap": ent.quota("categories_max"),
        "color_profiles_used": color_profiles_used,
        "color_profiles_cap": ent.quota("color_profiles_max"),
        "last_export_at": last_export.isoformat() if last_export else None,
        "period_start": month_start.isoformat(),
    }


# ---------------------------------------------------------------------------
# Plans catalogue (used by the pricing page)
# ---------------------------------------------------------------------------

class PlanItem(BaseModel):
    id: str  # 'starter' | 'pro' | 'studio'
    name: str
    monthly_price_id: str | None
    annual_price_id: str | None
    monthly_price_display: str  # human-readable, e.g. "£25"
    annual_price_display: str
    annual_save_pct: int        # marketing copy ("Save 17%")
    tagline: str
    features: list[str]
    most_popular: bool = False


class PlansOut(BaseModel):
    plans: list[PlanItem]
    enterprise_contact_email: str
    founder_seats_remaining: int | None = None  # null when unknown / disabled


# Display prices live here, not in Stripe. Keeping them server-side means
# the frontend can't drift, and we get a single edit point if we change
# headline pricing. The actual amount charged is whatever the Stripe price
# object is configured for — these are presentation only.
_PLAN_DISPLAY: dict[str, dict] = {
    "starter": {
        "name": "Starter",
        "monthly": "£25",
        "annual": "£250",
        "save_pct": 17,
        "tagline": "For solo print operators getting started.",
        "features": [
            "5 templates",
            "200 PDF exports / month",
            "10 catalogue categories",
            "2 colour profiles",
            "Up to 50 MB per artwork",
            "5 GB total storage",
            "Email support",
        ],
        "most_popular": False,
    },
    "pro": {
        "name": "Pro",
        "monthly": "£49",
        "annual": "£490",
        "save_pct": 17,
        "tagline": "For working print shops. Most popular.",
        "features": [
            "Unlimited templates",
            "Unlimited PDF exports",
            "Unlimited categories & colour profiles",
            "Up to 100 MB per artwork",
            "50 GB total storage",
            "Catalogue sharing",
            "Priority support",
        ],
        "most_popular": True,
    },
    "studio": {
        "name": "Studio",
        "monthly": "£99",
        "annual": "£990",
        "save_pct": 17,
        "tagline": "For high-volume production with custom workflows.",
        "features": [
            "Everything in Pro",
            "Up to 500 MB per artwork",
            "250 GB total storage",
            "API access",
            "White-label PDF output",
            "Advanced layouts",
        ],
        "most_popular": False,
    },
}


@router.get("/plans", response_model=PlansOut)
def get_plans() -> PlansOut:
    """Return the marketing catalogue of plans and their Stripe price IDs.
    Public — no auth required (the pricing page is reachable when logged
    out)."""
    s = get_settings()
    plans = [
        PlanItem(
            id="starter",
            name=_PLAN_DISPLAY["starter"]["name"],
            monthly_price_id=s.stripe_price_starter_monthly,
            annual_price_id=s.stripe_price_starter_annual,
            monthly_price_display=_PLAN_DISPLAY["starter"]["monthly"],
            annual_price_display=_PLAN_DISPLAY["starter"]["annual"],
            annual_save_pct=_PLAN_DISPLAY["starter"]["save_pct"],
            tagline=_PLAN_DISPLAY["starter"]["tagline"],
            features=_PLAN_DISPLAY["starter"]["features"],
            most_popular=_PLAN_DISPLAY["starter"]["most_popular"],
        ),
        PlanItem(
            id="pro",
            name=_PLAN_DISPLAY["pro"]["name"],
            monthly_price_id=s.stripe_price_pro_monthly,
            annual_price_id=s.stripe_price_pro_annual,
            monthly_price_display=_PLAN_DISPLAY["pro"]["monthly"],
            annual_price_display=_PLAN_DISPLAY["pro"]["annual"],
            annual_save_pct=_PLAN_DISPLAY["pro"]["save_pct"],
            tagline=_PLAN_DISPLAY["pro"]["tagline"],
            features=_PLAN_DISPLAY["pro"]["features"],
            most_popular=_PLAN_DISPLAY["pro"]["most_popular"],
        ),
        PlanItem(
            id="studio",
            name=_PLAN_DISPLAY["studio"]["name"],
            monthly_price_id=s.stripe_price_studio_monthly,
            annual_price_id=s.stripe_price_studio_annual,
            monthly_price_display=_PLAN_DISPLAY["studio"]["monthly"],
            annual_price_display=_PLAN_DISPLAY["studio"]["annual"],
            annual_save_pct=_PLAN_DISPLAY["studio"]["save_pct"],
            tagline=_PLAN_DISPLAY["studio"]["tagline"],
            features=_PLAN_DISPLAY["studio"]["features"],
            most_popular=_PLAN_DISPLAY["studio"]["most_popular"],
        ),
    ]
    return PlansOut(
        plans=plans,
        enterprise_contact_email="hello@printlay.io",
        founder_seats_remaining=None,
    )


# ---------------------------------------------------------------------------
# Checkout
# ---------------------------------------------------------------------------

class CheckoutIn(BaseModel):
    price_id: str = Field(..., min_length=4, max_length=64)
    success_url: str = Field(..., max_length=512)
    cancel_url: str = Field(..., max_length=512)
    coupon: str | None = Field(default=None, max_length=64)


class CheckoutOut(BaseModel):
    url: str


@router.post("/checkout", response_model=CheckoutOut)
def create_checkout(
    payload: CheckoutIn,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CheckoutOut:
    """Open a Stripe Checkout session for the chosen price ID.

    The frontend should call this from the pricing page, get the URL back,
    and `window.location.href = url` to redirect into Stripe's hosted
    checkout. On success, Stripe redirects back to `success_url` and our
    webhook fires shortly after to flip the user to active."""
    user = _resolve_user(db, auth)

    # Validate the price ID is one we know about. Prevents a mischievous
    # client from sending a Stripe price ID for some other product.
    if not _is_known_price(payload.price_id):
        raise HTTPException(400, "Unknown price ID")

    # Defence in depth: refuse to start a brand-new Checkout session for a
    # user who already has a live subscription. The frontend should route
    # them through /change-plan instead, but if it doesn't, we'd be one
    # click away from charging the same card twice for two parallel subs.
    if user.stripe_subscription_id and user.stripe_subscription_status in (
        "active", "trialing", "past_due"
    ):
        raise HTTPException(
            409,
            "You already have a live subscription. Use /api/billing/change-plan to switch plans.",
        )

    try:
        url = stripe_billing.create_checkout_session(
            db, user,
            price_id=payload.price_id,
            success_url=payload.success_url,
            cancel_url=payload.cancel_url,
            coupon=payload.coupon,
        )
    except stripe_billing.StripeNotConfigured as e:
        raise HTTPException(503, str(e))
    except stripe.StripeError as e:
        log.exception("checkout creation failed for user %s", user.id)
        raise HTTPException(502, f"Stripe error: {e.user_message or str(e)}")

    record(
        db, user, "billing.checkout_started",
        payload={"price_id": payload.price_id, "coupon": payload.coupon},
    )
    return CheckoutOut(url=url)


# ---------------------------------------------------------------------------
# Change plan — modify an existing subscription (upgrade/downgrade/cycle)
# ---------------------------------------------------------------------------

class ChangePlanIn(BaseModel):
    price_id: str = Field(..., min_length=4, max_length=64)
    return_url: str = Field(..., max_length=512)


class ChangePlanOut(BaseModel):
    url: str


@router.post("/change-plan", response_model=ChangePlanOut)
def change_plan(
    payload: ChangePlanIn,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ChangePlanOut:
    """Switch an existing subscription to a different price (upgrade,
    downgrade, or monthly/annual swap). Returns a Stripe Customer Portal
    URL pre-filled with the new price; one click on the resulting screen
    confirms the change with proration and the webhook updates the user
    row.

    For brand-new subscribers (no live subscription), use
    /api/billing/checkout instead — that path creates the subscription
    rather than modifying one."""
    user = _resolve_user(db, auth)

    if not _is_known_price(payload.price_id):
        raise HTTPException(400, "Unknown price ID")

    # Must have a live subscription to modify. We treat trialing and
    # past_due as live too — both have a Stripe sub object that can be
    # updated; the user just hasn't been billed yet (trialing) or the
    # last bill failed (past_due, where switching plans + updating the
    # card via the portal is exactly the recovery path).
    if not user.stripe_subscription_id or user.stripe_subscription_status not in (
        "active", "trialing", "past_due"
    ):
        raise HTTPException(
            400,
            "No live subscription to update. Start a checkout instead.",
        )

    if user.stripe_price_id == payload.price_id:
        raise HTTPException(400, "Already on this plan.")

    try:
        url = stripe_billing.create_subscription_update_session(
            db, user,
            new_price_id=payload.price_id,
            return_url=payload.return_url,
        )
    except stripe_billing.StripeNotConfigured as e:
        raise HTTPException(503, str(e))
    except stripe.StripeError as e:
        log.exception("change-plan failed for user %s", user.id)
        raise HTTPException(502, f"Stripe error: {e.user_message or str(e)}")

    record(
        db, user, "billing.change_plan_started",
        payload={
            "from_price": user.stripe_price_id,
            "to_price": payload.price_id,
        },
    )
    return ChangePlanOut(url=url)


def _is_known_price(price_id: str) -> bool:
    s = get_settings()
    known = {
        s.stripe_price_starter_monthly,
        s.stripe_price_starter_annual,
        s.stripe_price_pro_monthly,
        s.stripe_price_pro_annual,
        s.stripe_price_studio_monthly,
        s.stripe_price_studio_annual,
    }
    return price_id in known and price_id is not None


# ---------------------------------------------------------------------------
# Customer Portal
# ---------------------------------------------------------------------------

class PortalIn(BaseModel):
    return_url: str = Field(..., max_length=512)


class PortalOut(BaseModel):
    url: str


@router.post("/portal", response_model=PortalOut)
def open_portal(
    payload: PortalIn,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PortalOut:
    """Redirect the user into the Stripe Customer Portal where they can
    update card, change plan, view invoices, or cancel."""
    user = _resolve_user(db, auth)
    if not user.stripe_customer_id:
        raise HTTPException(
            400,
            "No Stripe customer linked to this account. Subscribe first.",
        )
    try:
        url = stripe_billing.create_portal_session(
            db, user, return_url=payload.return_url
        )
    except stripe_billing.StripeNotConfigured as e:
        raise HTTPException(503, str(e))
    except stripe.StripeError as e:
        log.exception("portal session failed for user %s", user.id)
        raise HTTPException(502, f"Stripe error: {e.user_message or str(e)}")
    return PortalOut(url=url)


# ---------------------------------------------------------------------------
# Webhook
# ---------------------------------------------------------------------------

@router.post("/webhook", include_in_schema=False)
async def stripe_webhook(
    request: Request,
    stripe_signature: str | None = Header(default=None, alias="Stripe-Signature"),
    db: Session = Depends(get_db),
):
    """Public endpoint — Stripe → us. Verified by signature, idempotent
    by event ID. Returns 200 on success or duplicate, 400 on bad
    signature, 500 on processing error (Stripe will retry).

    Be careful: never raise mid-handler after committing the idempotency
    row, or Stripe will retry and we'll skip the side effect."""
    payload = await request.body()
    try:
        event = stripe_billing.verify_webhook(payload, stripe_signature)
    except stripe_billing.StripeNotConfigured as e:
        log.error("webhook received but Stripe not configured: %s", e)
        raise HTTPException(503, str(e))
    except stripe.SignatureVerificationError:
        log.warning("rejected webhook with bad signature")
        raise HTTPException(400, "Bad signature")
    except Exception as e:  # malformed payload, etc.
        log.exception("webhook verification failed")
        raise HTTPException(400, f"Bad payload: {e}")

    # ---- Idempotency claim + dispatch in one transaction ----
    # `INSERT ... ON CONFLICT DO NOTHING ... RETURNING id` either claims
    # the event ID or returns no row if a previous request already did.
    # Concurrent duplicate deliveries serialize on the unique constraint:
    # the second one blocks until the first commits, then sees no row and
    # returns 200. Any handler failure rolls back the claim too, so
    # Stripe's retry will re-process cleanly.
    stmt = (
        pg_insert(StripeEvent)
        .values(id=event.id, type=event.type)
        .on_conflict_do_nothing(index_elements=["id"])
        .returning(StripeEvent.id)
    )
    claimed = db.execute(stmt).scalar_one_or_none()
    if claimed is None:
        log.info("webhook %s already processed; skipping", event.id)
        # No-op transaction; commit to release locks.
        db.commit()
        return {"received": True, "duplicate": True}

    try:
        _dispatch_event(db, event)
        db.commit()
    except Exception:
        log.exception("webhook handler crashed for event %s", event.id)
        db.rollback()  # Drops the idempotency claim too — Stripe will retry.
        raise HTTPException(500, "Handler error; will be retried")

    return {"received": True, "duplicate": False}


def _dispatch_event(db: Session, event: stripe.Event) -> None:
    """Route a verified Stripe Event to its handler. Keep this small —
    every handler should be a few lines that delegate to the
    `stripe_billing` service.

    Events we care about:
        checkout.session.completed         attribute customer ↔ user, sync sub
        customer.subscription.created      sync (also fires after checkout)
        customer.subscription.updated      sync (plan change, status change)
        customer.subscription.deleted      mark canceled
        invoice.payment_failed             status → past_due
        invoice.payment_succeeded          no-op (sub.updated covers it)
    """
    obj = event.data.object
    etype = event.type

    if etype == "checkout.session.completed":
        _handle_checkout_completed(db, obj)
    elif etype in (
        "customer.subscription.created",
        "customer.subscription.updated",
    ):
        _handle_subscription_change(db, obj)
    elif etype == "customer.subscription.deleted":
        _handle_subscription_deleted(db, obj)
    elif etype == "invoice.payment_failed":
        _handle_invoice_failed(db, obj)
    else:
        log.debug("ignoring stripe event type %s", etype)


def _handle_checkout_completed(db: Session, session_obj: dict) -> None:
    customer_id = session_obj.get("customer")
    sub_id = session_obj.get("subscription")
    user_id_meta = (session_obj.get("metadata") or {}).get("user_id")
    client_ref = session_obj.get("client_reference_id")
    user = stripe_billing.find_user_for_event(
        db,
        customer_id=customer_id,
        user_id_meta=user_id_meta or client_ref,
    )
    if not user:
        log.warning(
            "checkout.session.completed for unknown user (customer=%s)",
            customer_id,
        )
        return
    # Make sure the customer ID is recorded if this is the first time.
    if not user.stripe_customer_id and customer_id:
        user.stripe_customer_id = customer_id
        db.commit()
    if sub_id:
        sub = stripe.Subscription.retrieve(sub_id)
        stripe_billing.apply_subscription_to_user(db, user, sub)
        log.info(
            "subscription %s started for user %s price=%s",
            sub_id, user.id, user.stripe_price_id,
        )


def _handle_subscription_change(db: Session, sub_obj: dict) -> None:
    customer_id = sub_obj.get("customer")
    user_id_meta = (sub_obj.get("metadata") or {}).get("user_id")
    user = stripe_billing.find_user_for_event(
        db, customer_id=customer_id, user_id_meta=user_id_meta
    )
    if not user:
        log.warning(
            "subscription.updated for unknown user (customer=%s)", customer_id
        )
        return
    # The dict-shaped event payload supports the same indexing as a real
    # Subscription object for our purposes.
    stripe_billing.apply_subscription_to_user(db, user, sub_obj)


def _handle_subscription_deleted(db: Session, sub_obj: dict) -> None:
    customer_id = sub_obj.get("customer")
    user_id_meta = (sub_obj.get("metadata") or {}).get("user_id")
    user = stripe_billing.find_user_for_event(
        db, customer_id=customer_id, user_id_meta=user_id_meta
    )
    if not user:
        return
    stripe_billing.clear_subscription_on_user(db, user)
    log.info("subscription canceled for user %s", user.id)


def _handle_invoice_failed(db: Session, invoice_obj: dict) -> None:
    customer_id = invoice_obj.get("customer")
    user = stripe_billing.find_user_for_event(
        db, customer_id=customer_id, user_id_meta=None
    )
    if not user:
        return
    # Don't yank features immediately — Stripe will retry the charge a
    # few times before marking the sub past_due → unpaid → canceled.
    # We just surface the state in the UI.
    user.stripe_subscription_status = "past_due"
    log.warning("payment failed for user %s; status -> past_due", user.id)
