"""Entitlements - the single source of truth for "what is this user allowed
to do, right now?"

Resolves a user's effective plan from:
  1. Their stored `tier` column (set by a successful licence activation), AND
  2. The 72-hour grace period if LMFWC is currently unreachable.

For now the per-tier limits are placeholders - the actual numbers depend on
pricing decisions that haven't been made yet. Update `PLAN_LIMITS` once the
tiers are finalised; nothing else needs to change.

Routers should *only* read from `Entitlement.allows(...)` / `Entitlement.quota(...)`
- they should never branch on tier strings directly. That keeps the swap from
"internal beta = unlimited" to "real tiers" a one-file change.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from backend.models import User
from backend.services.lmfwc import Plan

GRACE_PERIOD = timedelta(hours=72)

# Placeholders. Replace once tiers are finalised. `None` = unlimited.
PLAN_LIMITS: dict[Plan, dict[str, int | None]] = {
    "internal_beta": {
        "templates_max": None,
        "exports_per_month": None,
        "categories_max": None,
        "asset_size_mb_max": 50,
    },
    "starter": {
        "templates_max": 5,
        "exports_per_month": 20,
        "categories_max": 3,
        "asset_size_mb_max": 25,
    },
    "professional": {
        "templates_max": None,
        "exports_per_month": None,
        "categories_max": None,
        "asset_size_mb_max": 100,
    },
    "expert": {
        "templates_max": None,
        "exports_per_month": None,
        "categories_max": None,
        "asset_size_mb_max": 250,
    },
}

# Feature flags per tier. Same caveat as above - placeholders.
PLAN_FEATURES: dict[Plan, set[str]] = {
    "internal_beta": {"all"},  # no gating during beta
    "starter": {"basic_templates", "pdf_export_single", "manual_positioning"},
    "professional": {
        "basic_templates", "pdf_export_single", "manual_positioning",
        "unlimited_templates", "pdf_export_batch", "custom_templates", "artwork_library",
    },
    "expert": {
        "basic_templates", "pdf_export_single", "manual_positioning",
        "unlimited_templates", "pdf_export_batch", "custom_templates", "artwork_library",
        "team_collaboration", "advanced_layouts", "api_access", "white_label",
    },
}


@dataclass(slots=True)
class Entitlement:
    plan: Plan
    license_key: str | None = None
    license_status: str | None = None
    license_expires_at: datetime | None = None
    in_grace_period: bool = False
    """True when LMFWC declared the licence invalid/unreachable but we're
    still inside the 72h window since the last successful validation."""
    limits: dict[str, int | None] = field(default_factory=dict)
    features: set[str] = field(default_factory=set)

    def allows(self, feature: str) -> bool:
        return "all" in self.features or feature in self.features

    def quota(self, key: str) -> int | None:
        """Return the cap for `key`. None means unlimited."""
        return self.limits.get(key)


def for_user(user: User) -> Entitlement:
    """Compute the effective entitlement for a user. Always cheap - reads only
    columns already on the `users` row; never makes a network call."""
    plan: Plan = (user.tier or "internal_beta")  # type: ignore[assignment]

    in_grace = False
    # If the licence has lapsed but we're still inside the grace window, keep
    # the user on their last known plan. Avoids locking real customers out
    # because magicalplugins.com is briefly down.
    if user.license_status and user.license_status != "active":
        if user.license_validated_at:
            now = datetime.now(timezone.utc)
            last = user.license_validated_at
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            if now - last <= GRACE_PERIOD:
                in_grace = True

    return Entitlement(
        plan=plan,
        license_key=user.license_key,
        license_status=user.license_status,
        license_expires_at=user.license_expires_at,
        in_grace_period=in_grace,
        limits=dict(PLAN_LIMITS.get(plan, PLAN_LIMITS["internal_beta"])),
        features=set(PLAN_FEATURES.get(plan, PLAN_FEATURES["internal_beta"])),
    )


def to_public_dict(ent: Entitlement) -> dict[str, Any]:
    """Trim representation safe to ship to the SPA."""
    return {
        "plan": ent.plan,
        "license_key_masked": _mask(ent.license_key),
        "license_status": ent.license_status,
        "license_expires_at": ent.license_expires_at.isoformat() if ent.license_expires_at else None,
        "in_grace_period": ent.in_grace_period,
        "limits": ent.limits,
        "features": sorted(ent.features),
    }


def _mask(key: str | None) -> str | None:
    if not key:
        return None
    if len(key) <= 8:
        return "***"
    return f"{key[:6]}...{key[-4:]}"
