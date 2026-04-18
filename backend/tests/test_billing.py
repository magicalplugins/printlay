"""Tests for the LMFWC client + entitlements layer.

We mock httpx so no network calls happen in CI. The client is also tested for
its degenerate "not configured" path so dev environments without LMFWC creds
behave deterministically.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
import pytest

from backend.config import get_settings
from backend.models import User
from backend.services import entitlements, lmfwc


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("LICENSE_SERVER_URL", "https://magicalplugins.test")
    monkeypatch.setenv("LMFWC_CONSUMER_KEY", "ck_test")
    monkeypatch.setenv("LMFWC_CONSUMER_SECRET", "cs_test")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


# -------- tier_from_license_key --------

@pytest.mark.parametrize(
    "key,expected",
    [
        ("PL-STR-AAAA-BBBB", "starter"),
        ("PL-PRO-AAAA-BBBB", "professional"),
        ("PL-EXPERT-AAAA-BBBB", "expert"),
        ("pl-pro-lower-case", "professional"),
        ("STR-NO-PREFIX", "internal_beta"),
        ("", "internal_beta"),
        (None, "internal_beta"),
    ],
)
def test_tier_from_license_key(key, expected):
    assert lmfwc.tier_from_license_key(key) == expected


# -------- is_configured --------

def test_is_configured_false_by_default():
    assert lmfwc.is_configured() is False


def test_is_configured_true_with_creds(configured):
    assert lmfwc.is_configured() is True


# -------- validate_license --------

def test_validate_unconfigured_returns_invalid():
    result = lmfwc.validate_license("PL-PRO-XXXX")
    assert result.valid is False
    assert "not configured" in (result.message or "").lower()


def test_validate_success_parses_response(configured):
    fake = httpx.Response(
        200,
        json={
            "success": True,
            "data": {
                "id": 42,
                "licenseKey": "PL-PRO-AAAA-BBBB",
                "expiresAt": "2027-04-12 23:59:59",
                "status": 2,
                "timesActivated": 1,
                "timesActivatedMax": 3,
            },
        },
        request=httpx.Request("GET", "https://magicalplugins.test/x"),
    )
    with patch("backend.services.lmfwc.httpx.get", return_value=fake):
        result = lmfwc.validate_license("PL-PRO-AAAA-BBBB")
    assert result.valid is True
    assert result.plan == "professional"
    assert result.activations_used == 1
    assert result.activations_max == 3
    assert result.expires_at == datetime(2027, 4, 12, 23, 59, 59)


def test_validate_failure_returns_message(configured):
    fake = httpx.Response(
        404,
        json={"message": "License key invalid"},
        request=httpx.Request("GET", "https://magicalplugins.test/x"),
    )
    with patch("backend.services.lmfwc.httpx.get", return_value=fake):
        result = lmfwc.validate_license("PL-PRO-AAAA-BBBB")
    assert result.valid is False
    assert result.message == "License key invalid"


def test_validate_timeout_returns_invalid(configured):
    with patch(
        "backend.services.lmfwc.httpx.get",
        side_effect=httpx.TimeoutException("boom"),
    ):
        result = lmfwc.validate_license("PL-PRO-AAAA-BBBB")
    assert result.valid is False
    assert "timeout" in (result.message or "").lower()


# -------- activate_license --------

def test_activate_success_calls_ping(configured):
    success = httpx.Response(
        200,
        json={"success": True, "data": {}},
        request=httpx.Request("GET", "https://magicalplugins.test/x"),
    )
    with patch("backend.services.lmfwc.httpx.get", return_value=success), patch(
        "backend.services.lmfwc.ping_product_install"
    ) as ping:
        result = lmfwc.activate_license("PL-PRO-XXXX", "user-1")
    assert result.ok is True
    assert result.already_done is False
    ping.assert_called_once_with("PL-PRO-XXXX", "user-1")


def test_activate_already_used_is_idempotent_ok(configured):
    fake = httpx.Response(
        400,
        json={"message": "License key already activated for the maximum number of times"},
        request=httpx.Request("GET", "https://magicalplugins.test/x"),
    )
    with patch("backend.services.lmfwc.httpx.get", return_value=fake):
        result = lmfwc.activate_license("PL-PRO-XXXX", "user-1")
    assert result.ok is True
    assert result.already_done is True


# -------- entitlements --------

def _make_user(**overrides) -> User:
    u = User(email="x@example.com", auth_id=uuid.uuid4())
    u.id = uuid.uuid4()
    u.tier = overrides.get("tier", "internal_beta")
    u.license_key = overrides.get("license_key")
    u.license_status = overrides.get("license_status")
    u.license_validated_at = overrides.get("license_validated_at")
    u.license_expires_at = overrides.get("license_expires_at")
    return u


def test_entitlement_default_user_is_internal_beta_unlimited():
    ent = entitlements.for_user(_make_user())
    assert ent.plan == "internal_beta"
    assert ent.allows("anything")  # 'all' feature flag
    assert ent.quota("templates_max") is None


def test_entitlement_starter_has_finite_limits():
    ent = entitlements.for_user(_make_user(tier="starter"))
    assert ent.plan == "starter"
    assert ent.quota("templates_max") == 5
    assert ent.allows("basic_templates")
    assert not ent.allows("api_access")


def test_entitlement_in_grace_period_when_recently_validated():
    user = _make_user(
        tier="professional",
        license_status="invalid",
        license_validated_at=datetime.now(timezone.utc) - timedelta(hours=1),
    )
    ent = entitlements.for_user(user)
    assert ent.in_grace_period is True


def test_entitlement_grace_period_expires_after_72h():
    user = _make_user(
        tier="professional",
        license_status="invalid",
        license_validated_at=datetime.now(timezone.utc) - timedelta(hours=80),
    )
    ent = entitlements.for_user(user)
    assert ent.in_grace_period is False


def test_to_public_dict_masks_license_key():
    user = _make_user(license_key="PL-PRO-AAAA-BBBB-CCCC-DDDD")
    public = entitlements.to_public_dict(entitlements.for_user(user))
    assert "AAAA" not in (public["license_key_masked"] or "")
    assert public["license_key_masked"] is not None
    assert public["license_key_masked"].startswith("PL-PRO")
