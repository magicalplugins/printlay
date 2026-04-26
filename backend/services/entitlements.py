"""Entitlements — the single source of truth for 'what is this user allowed
to do, right now?'

Billing is Stripe-only. Resolution order (first match wins):
  1. Active Stripe subscription  → tier derived from stripe_price_id
  2. tier == 'enterprise'        → set manually by admin for invoiced deals
  3. trial_ends_at > now()       → 'pro' (full Pro experience during trial)
  4. otherwise                   → 'locked' (expired trial / cancelled)

The `for_user` function is always cheap — it reads only columns already on
the `users` row and never makes a network call. Routers should only branch
on `Entitlement.allows(...)` / `Entitlement.quota(...)`, never on the tier
string directly. That makes a tier rename a one-file change.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

from backend.models import User

Plan = Literal["starter", "pro", "studio", "enterprise", "locked"]

# ---------------------------------------------------------------------------
# Tier limits
# None = unlimited
#
# Keys:
#   templates_max         total templates the user can own
#   exports_per_month     PDFs generated this calendar month (resets on the 1st)
#   categories_max        catalogue categories they can create
#   color_profiles_max    saved colour swap profiles
#   asset_size_mb_max     per-file ceiling on a single artwork upload
#   storage_mb_max        total stored artwork (catalogue + job uploads)
#                         — generated PDF outputs are NOT counted toward this
# ---------------------------------------------------------------------------
PLAN_LIMITS: dict[Plan, dict[str, int | None]] = {
    "locked": {
        "templates_max": 0,
        "exports_per_month": 0,
        "categories_max": 0,
        "color_profiles_max": 0,
        "asset_size_mb_max": 0,
        "storage_mb_max": 0,
    },
    "starter": {
        "templates_max": 5,
        "exports_per_month": 200,
        "categories_max": 10,
        "color_profiles_max": 2,
        "asset_size_mb_max": 50,
        "storage_mb_max": 5 * 1024,        # 5 GB
    },
    "pro": {
        "templates_max": None,
        "exports_per_month": None,
        "categories_max": None,
        "color_profiles_max": None,
        "asset_size_mb_max": 100,
        "storage_mb_max": 50 * 1024,       # 50 GB
    },
    "studio": {
        "templates_max": None,
        "exports_per_month": None,
        "categories_max": None,
        "color_profiles_max": None,
        "asset_size_mb_max": 500,
        "storage_mb_max": 250 * 1024,      # 250 GB
    },
    "enterprise": {
        "templates_max": None,
        "exports_per_month": None,
        "categories_max": None,
        "color_profiles_max": None,
        "asset_size_mb_max": 1024,         # 1 GB per asset
        "storage_mb_max": None,            # unlimited
    },
}

# Trial users get the Pro feature set, but a tighter storage cap so a
# brand-new account can't dump a huge library we have to host forever
# if they bounce. 14 days × 1 GB is plenty for a real evaluation.
_TRIAL_STORAGE_MB_MAX = 1024  # 1 GB

# Feature flags per tier.
# 'all' is a wildcard that satisfies every allows() check.
PLAN_FEATURES: dict[Plan, set[str]] = {
    "locked": set(),
    "starter": {
        "pdf_export",
        "colour_swap",
        "catalogue",
        "manual_positioning",
    },
    "pro": {
        "pdf_export",
        "colour_swap",
        "catalogue",
        "manual_positioning",
        "catalogue_sharing",
        "priority_support",
    },
    "studio": {
        "pdf_export",
        "colour_swap",
        "catalogue",
        "manual_positioning",
        "catalogue_sharing",
        "priority_support",
        "white_label_pdf",
        "api_access",
        "advanced_layouts",
    },
    "enterprise": {"all"},
}


@dataclass(slots=True)
class Entitlement:
    plan: Plan
    is_trialing: bool = False
    limits: dict[str, int | None] = field(default_factory=dict)
    features: set[str] = field(default_factory=set)

    def allows(self, feature: str) -> bool:
        return "all" in self.features or feature in self.features

    def quota(self, key: str) -> int | None:
        """Return the cap for `key`. None means unlimited."""
        return self.limits.get(key)

    def under_quota(self, key: str, current_count: int) -> bool:
        """True when the user has headroom left (or the limit is None)."""
        cap = self.quota(key)
        return cap is None or current_count < cap


def _plan_from_stripe_price(price_id: str | None) -> Plan:
    """Map a Stripe price ID to a Plan tier.

    Price IDs are stored in Settings (STRIPE_PRICE_*). We do a lazy import
    to avoid a circular dep and so this module stays testable without config.
    """
    if not price_id:
        return "locked"
    try:
        from backend.config import get_settings
        s = get_settings()
        starter_ids = {s.stripe_price_starter_monthly, s.stripe_price_starter_annual}
        pro_ids = {s.stripe_price_pro_monthly, s.stripe_price_pro_annual}
        studio_ids = {s.stripe_price_studio_monthly, s.stripe_price_studio_annual}
        if price_id in starter_ids:
            return "starter"
        if price_id in pro_ids:
            return "pro"
        if price_id in studio_ids:
            return "studio"
    except Exception:
        pass
    return "locked"


def for_user(user: User) -> Entitlement:
    """Compute the effective entitlement for a user.

    Always cheap — reads only columns on the `users` row, no network calls.
    Trial expiry is evaluated lazily here so no cron is needed.
    """
    now = datetime.now(timezone.utc)

    # 0. Admin — full enterprise access, no subscription required
    try:
        from backend.auth import is_admin_email
        if is_admin_email(user.email):
            return Entitlement(
                plan="enterprise",
                is_trialing=False,
                limits=dict(PLAN_LIMITS["enterprise"]),
                features=set(PLAN_FEATURES["enterprise"]),
            )
    except Exception:
        pass

    # 1. Active Stripe subscription — primary billing path
    if user.stripe_subscription_status == "active":
        plan: Plan = _plan_from_stripe_price(user.stripe_price_id)
        return Entitlement(
            plan=plan,
            is_trialing=False,
            limits=dict(PLAN_LIMITS[plan]),
            features=set(PLAN_FEATURES[plan]),
        )

    # 2. Enterprise — set manually by admin for invoiced/enterprise deals
    if user.tier == "enterprise":
        return Entitlement(
            plan="enterprise",
            is_trialing=False,
            limits=dict(PLAN_LIMITS["enterprise"]),
            features=set(PLAN_FEATURES["enterprise"]),
        )

    # 3. Active trial — full Pro experience, no card required.
    #    Storage is squeezed down to 1 GB during the trial (see comment
    #    on _TRIAL_STORAGE_MB_MAX). Everything else is Pro-equivalent so
    #    the user evaluates the actual product, not a stripped-down demo.
    if user.trial_ends_at is not None:
        trial_end = user.trial_ends_at
        if trial_end.tzinfo is None:
            trial_end = trial_end.replace(tzinfo=timezone.utc)
        if trial_end > now:
            trial_limits = dict(PLAN_LIMITS["pro"])
            trial_limits["storage_mb_max"] = _TRIAL_STORAGE_MB_MAX
            return Entitlement(
                plan="pro",
                is_trialing=True,
                limits=trial_limits,
                features=set(PLAN_FEATURES["pro"]),
            )

    # 4. Locked — expired trial, cancelled subscription, or brand-new user
    #    with no trial set yet (shouldn't happen after auth flow is wired)
    return Entitlement(
        plan="locked",
        is_trialing=False,
        limits=dict(PLAN_LIMITS["locked"]),
        features=set(PLAN_FEATURES["locked"]),
    )


def to_public_dict(ent: Entitlement) -> dict[str, Any]:
    """Trim representation safe to ship to the SPA."""
    return {
        "plan": ent.plan,
        "is_trialing": ent.is_trialing,
        "limits": ent.limits,
        "features": sorted(ent.features),
    }
