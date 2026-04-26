"""Tests for the Founder Offer logic in /api/billing/plans.

The offer is the conversion lever for the launch. We validate three
things:
  1. The discount math is correct (and rounds prettily).
  2. While the offer window is open, the API returns `effective_*`
     prices that match the math, plus `founder_offer.active = True`.
  3. After the offer expires, `effective_*` prices disappear and
     `founder_offer.active = False` — so the strike-through UI turns
     off automatically with no code change.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from backend.routers import billing as billing_router


# ---- Pure helper ----------------------------------------------------------

@pytest.mark.parametrize(
    "display, pct, expected",
    [
        ("£25", 50, "£12.50"),
        ("£250", 50, "£125"),
        ("£49", 50, "£24.50"),
        ("£490", 50, "£245"),
        ("£99", 50, "£49.50"),
        ("£990", 50, "£495"),
        ("£100", 25, "£75"),
        ("$200", 30, "$140"),
    ],
)
def test_apply_pct_off_formats_cleanly(display, pct, expected):
    assert billing_router._apply_pct_off(display, pct) == expected


def test_apply_pct_off_falls_back_for_unparseable_input():
    # No digits — should return the input unchanged rather than crash.
    assert billing_router._apply_pct_off("free", 50) == "free"


# ---- Offer activation -----------------------------------------------------

def test_offer_active_before_end_date(monkeypatch):
    monkeypatch.setitem(
        billing_router.FOUNDER_OFFER,
        "ends_at",
        datetime.now(timezone.utc) + timedelta(days=1),
    )
    assert billing_router._founder_offer_active() is True


def test_offer_inactive_after_end_date(monkeypatch):
    monkeypatch.setitem(
        billing_router.FOUNDER_OFFER,
        "ends_at",
        datetime.now(timezone.utc) - timedelta(seconds=1),
    )
    assert billing_router._founder_offer_active() is False


# ---- Full /api/billing/plans response ------------------------------------

def test_get_plans_includes_effective_prices_during_offer(monkeypatch):
    monkeypatch.setitem(
        billing_router.FOUNDER_OFFER,
        "ends_at",
        datetime.now(timezone.utc) + timedelta(days=30),
    )

    out = billing_router.get_plans()

    assert out.founder_offer.active is True
    assert out.founder_offer.discount_pct == 50
    assert out.founder_offer.code == "FOUNDERS50"

    # Sanity: each plan exposes a discounted price that is (very nearly)
    # half the list price. We compare on the integer pence value to
    # avoid float jitter.
    for plan in out.plans:
        assert plan.effective_monthly_display is not None
        assert plan.effective_annual_display is not None
        list_m = float(plan.monthly_price_display.replace("£", ""))
        eff_m = float(plan.effective_monthly_display.replace("£", ""))
        assert eff_m == pytest.approx(list_m / 2)


def test_get_plans_omits_effective_prices_when_offer_expired(monkeypatch):
    monkeypatch.setitem(
        billing_router.FOUNDER_OFFER,
        "ends_at",
        datetime.now(timezone.utc) - timedelta(seconds=1),
    )

    out = billing_router.get_plans()

    assert out.founder_offer.active is False
    for plan in out.plans:
        assert plan.effective_monthly_display is None
        assert plan.effective_annual_display is None
        # List prices are still present.
        assert plan.monthly_price_display.startswith("£")
