"""Tests for the entitlements layer (Stripe-only, no LMFWC)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from backend.models import User
from backend.services import entitlements
from backend.services.entitlements import Plan


def _make_user(**overrides) -> User:
    u = User(email="x@example.com", auth_id=uuid.uuid4())
    u.id = uuid.uuid4()
    u.tier = overrides.get("tier", "locked")
    u.trial_ends_at = overrides.get("trial_ends_at")
    u.stripe_subscription_status = overrides.get("stripe_subscription_status")
    u.stripe_price_id = overrides.get("stripe_price_id")
    u.stripe_current_period_end = overrides.get("stripe_current_period_end")
    u.founder_member = overrides.get("founder_member", False)
    return u


# ---- Locked state (expired trial, no sub, new user) ----

def test_new_user_with_no_trial_is_locked():
    ent = entitlements.for_user(_make_user())
    assert ent.plan == "locked"
    assert not ent.allows("pdf_export")
    assert ent.quota("exports_per_month") == 0


# ---- Active trial ----

def test_active_trial_gets_pro_entitlements():
    user = _make_user(trial_ends_at=datetime.now(timezone.utc) + timedelta(days=7))
    ent = entitlements.for_user(user)
    assert ent.plan == "pro"
    assert ent.is_trialing is True
    assert ent.allows("pdf_export")
    assert ent.allows("colour_swap")
    assert ent.quota("templates_max") is None  # unlimited on pro


def test_expired_trial_drops_to_locked():
    user = _make_user(trial_ends_at=datetime.now(timezone.utc) - timedelta(seconds=1))
    ent = entitlements.for_user(user)
    assert ent.plan == "locked"
    assert not ent.allows("pdf_export")


# ---- Stripe active subscription (mocked price IDs) ----

def test_active_stripe_subscription_resolves_plan(monkeypatch):
    """When stripe_subscription_status is active, plan comes from the price ID."""
    import backend.services.entitlements as ent_mod

    def fake_plan(price_id: str | None) -> Plan:
        if price_id == "price_pro_monthly":
            return "pro"
        if price_id == "price_starter_monthly":
            return "starter"
        if price_id == "price_studio_annual":
            return "studio"
        return "locked"

    monkeypatch.setattr(ent_mod, "_plan_from_stripe_price", fake_plan)

    for price_id, expected_plan in [
        ("price_starter_monthly", "starter"),
        ("price_pro_monthly", "pro"),
        ("price_studio_annual", "studio"),
    ]:
        user = _make_user(
            stripe_subscription_status="active",
            stripe_price_id=price_id,
        )
        ent = entitlements.for_user(user)
        assert ent.plan == expected_plan
        assert ent.is_trialing is False


def test_cancelled_stripe_subscription_drops_to_locked_after_trial(monkeypatch):
    """Cancelled (status != active) + no active trial => locked."""
    user = _make_user(
        stripe_subscription_status="canceled",
        trial_ends_at=datetime.now(timezone.utc) - timedelta(days=1),
    )
    ent = entitlements.for_user(user)
    assert ent.plan == "locked"


# ---- Enterprise (admin-set) ----

def test_enterprise_tier_bypasses_stripe_and_trial():
    user = _make_user(tier="enterprise")
    ent = entitlements.for_user(user)
    assert ent.plan == "enterprise"
    assert ent.allows("all") or ent.allows("api_access")
    assert ent.quota("templates_max") is None


# ---- Starter limits ----

def test_starter_has_correct_limits(monkeypatch):
    import backend.services.entitlements as ent_mod
    monkeypatch.setattr(ent_mod, "_plan_from_stripe_price", lambda _: "starter")
    user = _make_user(stripe_subscription_status="active", stripe_price_id="price_starter_monthly")
    ent = entitlements.for_user(user)
    assert ent.plan == "starter"
    assert ent.quota("templates_max") == 5
    assert ent.quota("exports_per_month") == 200
    assert ent.quota("color_profiles_max") == 2
    assert ent.quota("categories_max") == 10
    assert ent.quota("asset_size_mb_max") == 50
    assert ent.quota("storage_mb_max") == 5 * 1024
    assert ent.allows("pdf_export")
    assert not ent.allows("api_access")
    assert not ent.allows("white_label_pdf")


def test_pro_has_correct_storage_and_asset_caps(monkeypatch):
    import backend.services.entitlements as ent_mod
    monkeypatch.setattr(ent_mod, "_plan_from_stripe_price", lambda _: "pro")
    user = _make_user(stripe_subscription_status="active", stripe_price_id="price_pro_monthly")
    ent = entitlements.for_user(user)
    assert ent.plan == "pro"
    assert ent.quota("templates_max") is None
    assert ent.quota("exports_per_month") is None
    assert ent.quota("asset_size_mb_max") == 100
    assert ent.quota("storage_mb_max") == 50 * 1024


def test_studio_has_correct_storage_and_asset_caps(monkeypatch):
    import backend.services.entitlements as ent_mod
    monkeypatch.setattr(ent_mod, "_plan_from_stripe_price", lambda _: "studio")
    user = _make_user(stripe_subscription_status="active", stripe_price_id="price_studio_monthly")
    ent = entitlements.for_user(user)
    assert ent.plan == "studio"
    assert ent.quota("asset_size_mb_max") == 500
    assert ent.quota("storage_mb_max") == 250 * 1024
    assert ent.allows("api_access")
    assert ent.allows("white_label_pdf")


def test_enterprise_storage_is_unlimited():
    user = _make_user(tier="enterprise")
    ent = entitlements.for_user(user)
    assert ent.plan == "enterprise"
    assert ent.quota("storage_mb_max") is None
    assert ent.quota("asset_size_mb_max") == 1024


def test_trial_storage_is_capped_to_1gb_even_though_features_are_pro():
    """Trial users get the full Pro feature set, but only 1 GB of storage."""
    user = _make_user(trial_ends_at=datetime.now(timezone.utc) + timedelta(days=7))
    ent = entitlements.for_user(user)
    assert ent.plan == "pro"
    assert ent.is_trialing is True
    assert ent.quota("storage_mb_max") == 1024
    assert ent.quota("templates_max") is None
    assert ent.allows("priority_support")


# ---- under_quota helper ----

def test_under_quota_returns_true_when_unlimited():
    user = _make_user(trial_ends_at=datetime.now(timezone.utc) + timedelta(days=1))
    ent = entitlements.for_user(user)
    assert ent.under_quota("templates_max", 9999) is True


def test_under_quota_returns_false_when_at_cap(monkeypatch):
    import backend.services.entitlements as ent_mod
    monkeypatch.setattr(ent_mod, "_plan_from_stripe_price", lambda _: "starter")
    user = _make_user(stripe_subscription_status="active", stripe_price_id="x")
    ent = entitlements.for_user(user)
    assert ent.quota("templates_max") == 5
    assert ent.under_quota("templates_max", 5) is False
    assert ent.under_quota("templates_max", 4) is True


# ---- to_public_dict ----

def test_to_public_dict_shape():
    user = _make_user(trial_ends_at=datetime.now(timezone.utc) + timedelta(days=3))
    pub = entitlements.to_public_dict(entitlements.for_user(user))
    assert pub["plan"] == "pro"
    assert pub["is_trialing"] is True
    assert "limits" in pub
    assert "features" in pub
    assert isinstance(pub["features"], list)
