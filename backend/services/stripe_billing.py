"""Stripe integration — the only module that talks to Stripe directly.

Two responsibilities:
    1. Outbound: create Checkout sessions, create Customer Portal sessions,
       create/lookup Customers. Called by the billing router from the
       authenticated SPA.
    2. Inbound: verify webhook signatures and apply `subscription` →
       `users` row updates. Called by the public webhook endpoint.

Design rules:
    - Single source of truth for `users.stripe_*` columns lives in
      `apply_subscription_to_user` / `clear_subscription_on_user`. Webhook
      handlers delegate to those — they never touch the columns directly.
    - Plan tier is *derived* in the entitlements layer from `stripe_price_id`,
      not stored. That keeps the price→tier table in one place
      (`entitlements._plan_from_stripe_price`).
    - Founder badge is detected once (on first sub creation) by sniffing the
      coupon. Once set, it's permanent.
    - All API calls accept `idempotency_key` where Stripe supports it.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import stripe
from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.models import User

log = logging.getLogger(__name__)

# Coupon codes that flag the user as a Founder (badge + lifetime mark).
FOUNDER_COUPON_IDS = {"FOUNDERS50", "founders50"}


# ---------------------------------------------------------------------------
# Lazy SDK init
# ---------------------------------------------------------------------------

def _ensure_configured() -> None:
    """Set the Stripe API key on the global module if it isn't already.
    Raises a clean error if the key is missing, so the router can return
    a useful 503 instead of a generic 500."""
    s = get_settings()
    if not s.stripe_secret_key:
        raise StripeNotConfigured(
            "Stripe is not configured. Set STRIPE_SECRET_KEY in env."
        )
    if stripe.api_key != s.stripe_secret_key:
        stripe.api_key = s.stripe_secret_key
        # Pin API version so changes in Stripe's defaults don't surprise us.
        # Older versions of the SDK expose this on the module; newer ones
        # accept it per-request. We set the module-level for robustness.
        stripe.api_version = "2024-06-20"


class StripeNotConfigured(RuntimeError):
    """Raised when Stripe API credentials are not present in env. The
    router maps this to a 503 with a helpful message."""


def configuration_status() -> dict:
    """Snapshot of which Stripe-related env vars are present.

    Used by the admin diagnostics panel to verify wiring without ever
    revealing the actual secret values. Each key is `True` when the
    corresponding env var is non-empty.

    Note: this only confirms the values are *present*. A live ping to
    Stripe would tell us if they're *valid* — we deliberately don't do
    that on every dashboard load; an invalid key shows itself the moment
    a real Checkout session is attempted.
    """
    s = get_settings()
    return {
        "secret_key": bool(s.stripe_secret_key),
        "webhook_secret": bool(s.stripe_webhook_secret),
        "price_starter_monthly": bool(s.stripe_price_starter_monthly),
        "price_starter_annual": bool(s.stripe_price_starter_annual),
        "price_pro_monthly": bool(s.stripe_price_pro_monthly),
        "price_pro_annual": bool(s.stripe_price_pro_annual),
        "price_studio_monthly": bool(s.stripe_price_studio_monthly),
        "price_studio_annual": bool(s.stripe_price_studio_annual),
    }


def is_fully_configured() -> bool:
    """True iff every Stripe env var required for end-to-end checkout
    + webhook handling is present."""
    return all(configuration_status().values())


# ---------------------------------------------------------------------------
# Customer + Checkout + Portal
# ---------------------------------------------------------------------------

def get_or_create_customer(db: Session, user: User) -> str:
    """Ensure the user has a Stripe Customer object, returning the ID.

    Persists `stripe_customer_id` back to the `users` row on first
    creation. Subsequent calls are a single DB read.

    Idempotent: calling this twice for the same user returns the same
    customer ID and never creates a duplicate Customer."""
    _ensure_configured()
    if user.stripe_customer_id:
        return user.stripe_customer_id

    customer = stripe.Customer.create(
        email=user.email,
        name=user.company_name or None,
        metadata={"user_id": str(user.id), "auth_id": str(user.auth_id)},
        # Idempotency: if Stripe retries, return the same Customer.
        idempotency_key=f"customer-create-{user.id}",
    )
    user.stripe_customer_id = customer.id
    db.commit()
    db.refresh(user)
    log.info("created stripe customer %s for user %s", customer.id, user.id)
    return customer.id


def create_checkout_session(
    db: Session,
    user: User,
    *,
    price_id: str,
    success_url: str,
    cancel_url: str,
    coupon: str | None = None,
) -> str:
    """Open a Stripe Checkout session for the given price. Returns the
    redirect URL for the client.

    Sets `client_reference_id` and `subscription_data.metadata.user_id` so
    the webhook can reliably attribute the resulting subscription back to
    our internal user, even if the Customer object is somehow recreated."""
    _ensure_configured()
    customer_id = get_or_create_customer(db, user)

    params: dict[str, Any] = {
        "mode": "subscription",
        "customer": customer_id,
        "client_reference_id": str(user.id),
        "line_items": [{"price": price_id, "quantity": 1}],
        "success_url": success_url,
        "cancel_url": cancel_url,
        "allow_promotion_codes": True,
        "billing_address_collection": "auto",
        "subscription_data": {
            "metadata": {
                "user_id": str(user.id),
                "auth_id": str(user.auth_id),
            },
        },
        # Lets the user use a saved card / Link without re-entering it.
        "customer_update": {"name": "auto", "address": "auto"},
    }
    if coupon:
        # Apply a coupon directly (no user input needed). Used for the
        # FOUNDERS50 launch promotion.
        params["discounts"] = [{"coupon": coupon}]
        # Promotion codes and coupons are mutually exclusive in Stripe.
        params.pop("allow_promotion_codes", None)

    session = stripe.checkout.Session.create(**params)
    log.info(
        "created checkout session %s for user %s price %s coupon %s",
        session.id, user.id, price_id, coupon,
    )
    return session.url


def create_portal_session(
    db: Session, user: User, *, return_url: str
) -> str:
    """Open the Stripe Customer Portal where the user can change plan,
    update card, view invoices, or cancel. Returns the redirect URL."""
    _ensure_configured()
    customer_id = get_or_create_customer(db, user)
    portal = stripe.billing_portal.Session.create(
        customer=customer_id,
        return_url=return_url,
    )
    return portal.url


def create_subscription_update_session(
    db: Session,
    user: User,
    *,
    new_price_id: str,
    return_url: str,
) -> str:
    """Open a Customer Portal session pre-filled to confirm switching the
    user's existing subscription to `new_price_id`.

    Uses Stripe's `flow_data: subscription_update_confirm` so the user
    lands on a single 'Confirm change' screen with the proration
    breakdown already calculated. One click and they're on the new plan;
    a `customer.subscription.updated` webhook then mirrors the new
    price onto the users row via `apply_subscription_to_user`.

    Falls back to a generic `subscription_update` flow (Stripe's plan
    picker screen) if the confirm preset is rejected — usually because
    the Customer Portal config doesn't list the new price as
    switchable. The user still gets a useful screen, just one extra
    click.

    Caller MUST validate the user has a live Stripe subscription before
    invoking. ValueError is raised on misuse so it surfaces loudly
    rather than silently producing a useless portal screen.
    """
    _ensure_configured()
    if not user.stripe_subscription_id:
        raise ValueError("User has no live Stripe subscription to update")

    customer_id = get_or_create_customer(db, user)
    sub = stripe.Subscription.retrieve(user.stripe_subscription_id)

    # Find the existing subscription item ID. We need to point the update
    # at it (not just dump a new price in, which would *add* an item
    # rather than replace one — same customer, two charges).
    item_id: str | None = None
    try:
        item_id = sub["items"]["data"][0]["id"]
    except (KeyError, IndexError, TypeError):
        log.warning(
            "subscription %s has no items[0].id; falling back to plain portal",
            user.stripe_subscription_id,
        )
        return create_portal_session(db, user, return_url=return_url)

    # Try the deep-linked confirm flow first — best UX (one click).
    try:
        portal = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=return_url,
            flow_data={
                "type": "subscription_update_confirm",
                "after_completion": {
                    "type": "redirect",
                    "redirect": {"return_url": return_url},
                },
                "subscription_update_confirm": {
                    "subscription": user.stripe_subscription_id,
                    "items": [
                        {
                            "id": item_id,
                            "price": new_price_id,
                            "quantity": 1,
                        }
                    ],
                },
            },
        )
        log.info(
            "portal-confirm session for user %s sub %s -> price %s",
            user.id, user.stripe_subscription_id, new_price_id,
        )
        return portal.url
    except stripe.InvalidRequestError as e:
        # Most likely cause: the Customer Portal configuration in Stripe
        # doesn't allow switching to that specific price. Degrade to the
        # generic plan-picker so the user can still get there manually.
        log.warning(
            "subscription_update_confirm rejected (%s); falling back to picker",
            e,
        )
        portal = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=return_url,
            flow_data={
                "type": "subscription_update",
                "subscription_update": {
                    "subscription": user.stripe_subscription_id,
                },
            },
        )
        return portal.url


# ---------------------------------------------------------------------------
# Webhook handling
# ---------------------------------------------------------------------------

def verify_webhook(payload: bytes, sig_header: str | None) -> stripe.Event:
    """Verify the Stripe-Signature header against the configured webhook
    secret and return the parsed Event. Raises if invalid."""
    _ensure_configured()
    s = get_settings()
    if not s.stripe_webhook_secret:
        raise StripeNotConfigured(
            "STRIPE_WEBHOOK_SECRET is not set; refusing to accept webhooks."
        )
    if not sig_header:
        raise stripe.SignatureVerificationError(
            "Missing Stripe-Signature header", sig_header
        )
    return stripe.Webhook.construct_event(
        payload, sig_header, s.stripe_webhook_secret
    )


# ---------------------------------------------------------------------------
# Subscription → User row sync
# These are the *only* places that mutate user.stripe_* columns. Webhook
# event handlers must delegate here.
# ---------------------------------------------------------------------------

def apply_subscription_to_user(
    db: Session, user: User, sub: stripe.Subscription
) -> None:
    """Mirror Stripe's subscription state onto the `users` row. Does NOT
    commit — the caller is expected to manage the transaction. The
    webhook router relies on this so that a handler crash rolls back the
    idempotency claim along with the partial state.

    Active sub → also clear `trial_ends_at` so the trial banner stops
    showing. Past_due / canceled subs leave `trial_ends_at` alone so the
    Settings page can still show the trial history.

    Founder coupon detection: if any discount on the sub uses the
    FOUNDERS50 coupon, set the badge once. Never unset (badges are
    forever, even if the user later cancels and resubscribes)."""
    user.stripe_subscription_id = sub.id
    user.stripe_subscription_status = sub.status
    # Stripe v2024-06-20 puts the price on items.data[0].price.id
    price_id = None
    try:
        price_id = sub["items"]["data"][0]["price"]["id"]
    except (KeyError, IndexError, TypeError):
        log.warning("subscription %s has no items[0].price.id", sub.id)
    if price_id:
        user.stripe_price_id = price_id

    # current_period_end is on the subscription items, not the sub itself,
    # in newer API versions. Fall back to the legacy field for safety.
    period_end_ts = None
    try:
        period_end_ts = sub["items"]["data"][0].get("current_period_end")
    except (KeyError, IndexError, TypeError):
        pass
    if period_end_ts is None:
        period_end_ts = sub.get("current_period_end")
    if period_end_ts:
        user.stripe_current_period_end = datetime.fromtimestamp(
            period_end_ts, tz=timezone.utc
        )

    # Once subscribed, the trial is moot. Clear it so the locked/trial
    # banners disappear immediately.
    if sub.status == "active" and user.trial_ends_at is not None:
        user.trial_ends_at = None

    # Founder badge detection (set once, never cleared)
    if not user.founder_member:
        coupon_id = _coupon_id_from_subscription(sub)
        if coupon_id and coupon_id in FOUNDER_COUPON_IDS:
            user.founder_member = True
            log.info("user %s flagged as founder member", user.id)


def clear_subscription_on_user(db: Session, user: User) -> None:
    """Mark the user's subscription as canceled. Keep `stripe_customer_id`
    so they can resubscribe through the portal without creating a new
    customer object (which would lose payment-method history). Does NOT
    commit (see `apply_subscription_to_user`)."""
    user.stripe_subscription_status = "canceled"
    user.stripe_subscription_id = None
    user.stripe_price_id = None
    user.stripe_current_period_end = None


def _coupon_id_from_subscription(sub: stripe.Subscription) -> str | None:
    """Best-effort extraction of the active coupon ID from a sub. Stripe
    moved this around between API versions: discount → discounts[]."""
    # Older shape
    discount = sub.get("discount")
    if discount and discount.get("coupon", {}).get("id"):
        return discount["coupon"]["id"]
    # Newer shape (multi-discount support)
    discounts = sub.get("discounts") or []
    for d in discounts:
        if isinstance(d, dict):
            cid = d.get("coupon", {}).get("id")
            if cid:
                return cid
        elif isinstance(d, str):
            # Just an ID string with no inline coupon; skip — we'd need an
            # extra round-trip to look it up. Founder coupon detection is a
            # nice-to-have, not critical.
            continue
    return None


# ---------------------------------------------------------------------------
# Lookup helper for webhooks
# ---------------------------------------------------------------------------

def find_user_for_event(
    db: Session, *, customer_id: str | None, user_id_meta: str | None
) -> User | None:
    """Locate the app-side user a Stripe event refers to. Tries the
    metadata user_id first (most reliable — set by us at checkout
    creation), then falls back to the customer_id index."""
    if user_id_meta:
        try:
            import uuid as _uuid
            row = db.query(User).filter(User.id == _uuid.UUID(user_id_meta)).one_or_none()
            if row:
                return row
        except (ValueError, TypeError):
            pass
    if customer_id:
        return (
            db.query(User)
            .filter(User.stripe_customer_id == customer_id)
            .one_or_none()
        )
    return None
