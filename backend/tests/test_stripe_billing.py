"""Tests for the Stripe billing service + webhook router.

We exercise the boundaries:
  - apply_subscription_to_user: idempotent state transitions, founder
    coupon detection, trial clearing.
  - clear_subscription_on_user: keeps customer ID, clears sub fields.
  - find_user_for_event: metadata > customer_id fallback.

Webhook signature verification + idempotent dispatch are exercised by
patching `stripe.Webhook.construct_event` so we don't need real keys.
The end-to-end webhook test uses an in-memory SQLite DB to verify the
de-dup table actually de-dupes.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
import stripe
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.database import get_db
from backend.main import app
from backend.models import Base, StripeEvent, User
from backend.services import stripe_billing


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

def _fake_sub(
    *,
    sub_id: str = "sub_test_1",
    status: str = "active",
    price_id: str = "price_pro_monthly",
    current_period_end: int | None = None,
    coupon_id: str | None = None,
) -> dict:
    """Build a minimal Subscription-shaped dict that quacks like the real
    Stripe object for our purposes (supports `.id`, `.status`, dict
    indexing, and `.get`)."""
    if current_period_end is None:
        current_period_end = int(
            (datetime.now(timezone.utc) + timedelta(days=30)).timestamp()
        )
    payload = {
        "id": sub_id,
        "status": status,
        "items": {
            "data": [
                {
                    "price": {"id": price_id},
                    "current_period_end": current_period_end,
                }
            ]
        },
        "current_period_end": current_period_end,
        "discounts": [],
        "discount": None,
        "metadata": {},
    }
    if coupon_id:
        payload["discount"] = {"coupon": {"id": coupon_id}}
    return _AttrDict(payload)


class _AttrDict(dict):
    """Tiny helper: gives StripeObject-like attr+key access."""
    def __getattr__(self, item):
        v = self.get(item)
        if isinstance(v, dict) and not isinstance(v, _AttrDict):
            return _AttrDict(v)
        return v


def _make_user(
    *,
    trial_ends_at: datetime | None = None,
    stripe_customer_id: str | None = None,
    stripe_subscription_status: str | None = None,
    founder_member: bool = False,
) -> User:
    u = User(email="x@example.com", auth_id=uuid.uuid4())
    u.id = uuid.uuid4()
    u.trial_ends_at = trial_ends_at
    u.stripe_customer_id = stripe_customer_id
    u.stripe_subscription_status = stripe_subscription_status
    u.founder_member = founder_member
    return u


# ---------------------------------------------------------------------------
# apply_subscription_to_user
# ---------------------------------------------------------------------------

def test_apply_subscription_writes_id_status_price_and_period():
    user = _make_user(trial_ends_at=datetime.now(timezone.utc) + timedelta(days=5))
    sub = _fake_sub(sub_id="sub_xyz", status="active", price_id="price_pro_monthly")

    db = MagicMock()  # no commit happens — service is transaction-passive
    stripe_billing.apply_subscription_to_user(db, user, sub)

    assert user.stripe_subscription_id == "sub_xyz"
    assert user.stripe_subscription_status == "active"
    assert user.stripe_price_id == "price_pro_monthly"
    assert user.stripe_current_period_end is not None
    assert user.trial_ends_at is None  # cleared on active
    db.commit.assert_not_called()


def test_apply_subscription_does_not_clear_trial_when_past_due():
    trial_end = datetime.now(timezone.utc) + timedelta(days=5)
    user = _make_user(trial_ends_at=trial_end)
    sub = _fake_sub(status="past_due")

    stripe_billing.apply_subscription_to_user(MagicMock(), user, sub)
    assert user.trial_ends_at == trial_end


def test_apply_subscription_sets_founder_badge_on_founders50_coupon():
    user = _make_user()
    sub = _fake_sub(coupon_id="FOUNDERS50")

    stripe_billing.apply_subscription_to_user(MagicMock(), user, sub)
    assert user.founder_member is True


def test_founder_badge_is_sticky_once_set():
    user = _make_user(founder_member=True)
    # Resub later without coupon — badge stays.
    sub = _fake_sub(coupon_id=None)

    stripe_billing.apply_subscription_to_user(MagicMock(), user, sub)
    assert user.founder_member is True


def test_apply_subscription_is_idempotent():
    """Running apply twice with the same payload yields the same final state."""
    user = _make_user()
    sub = _fake_sub(sub_id="sub_dup", status="active", price_id="price_pro_monthly")

    stripe_billing.apply_subscription_to_user(MagicMock(), user, sub)
    snapshot = (
        user.stripe_subscription_id,
        user.stripe_subscription_status,
        user.stripe_price_id,
        user.stripe_current_period_end,
    )
    stripe_billing.apply_subscription_to_user(MagicMock(), user, sub)
    assert (
        user.stripe_subscription_id,
        user.stripe_subscription_status,
        user.stripe_price_id,
        user.stripe_current_period_end,
    ) == snapshot


# ---------------------------------------------------------------------------
# clear_subscription_on_user
# ---------------------------------------------------------------------------

def test_clear_subscription_keeps_customer_id():
    user = _make_user(
        stripe_customer_id="cus_keep_me",
        stripe_subscription_status="active",
    )
    user.stripe_subscription_id = "sub_to_drop"
    user.stripe_price_id = "price_pro_monthly"

    stripe_billing.clear_subscription_on_user(MagicMock(), user)

    assert user.stripe_customer_id == "cus_keep_me"  # preserved!
    assert user.stripe_subscription_status == "canceled"
    assert user.stripe_subscription_id is None
    assert user.stripe_price_id is None


# ---------------------------------------------------------------------------
# find_user_for_event
# ---------------------------------------------------------------------------

def test_find_user_prefers_metadata_user_id_over_customer_id():
    """Metadata is set by us at checkout creation and is the most
    trustworthy attribution path."""
    db = MagicMock()
    target = _make_user(stripe_customer_id="cus_decoy")
    db.query.return_value.filter.return_value.one_or_none.return_value = target

    found = stripe_billing.find_user_for_event(
        db,
        customer_id="cus_decoy",
        user_id_meta=str(target.id),
    )
    assert found is target


def test_find_user_falls_back_to_customer_id_when_no_metadata():
    db = MagicMock()
    target = _make_user(stripe_customer_id="cus_abc")

    # First .one_or_none() (metadata path) is not invoked when no metadata.
    db.query.return_value.filter.return_value.one_or_none.return_value = target
    found = stripe_billing.find_user_for_event(
        db, customer_id="cus_abc", user_id_meta=None
    )
    assert found is target


def test_find_user_returns_none_when_nothing_matches():
    db = MagicMock()
    db.query.return_value.filter.return_value.one_or_none.return_value = None
    assert stripe_billing.find_user_for_event(
        db, customer_id=None, user_id_meta=None
    ) is None


# ---------------------------------------------------------------------------
# create_subscription_update_session — the "switch plan" portal deep link
# ---------------------------------------------------------------------------

def _patch_stripe_for_update_session(
    monkeypatch,
    *,
    portal_url: str = "https://stripe.test/portal/abc",
    confirm_raises: Exception | None = None,
    sub_items: list[dict] | None = None,
):
    """Wire up the Stripe SDK calls that create_subscription_update_session
    makes, so the test can assert on what we sent and control the response.

    Returns (portal_create_mock, sub_retrieve_mock) for assertions.
    """
    monkeypatch.setattr(stripe_billing, "_ensure_configured", lambda: None)
    monkeypatch.setattr(
        stripe_billing,
        "get_or_create_customer",
        lambda db, user: "cus_fake_123",
    )

    if sub_items is None:
        sub_items = [{"id": "si_existing_item", "price": {"id": "price_old"}}]
    sub_obj = _AttrDict({
        "id": "sub_live",
        "items": {"data": sub_items},
    })
    sub_retrieve = MagicMock(return_value=sub_obj)
    monkeypatch.setattr(
        stripe_billing.stripe.Subscription, "retrieve", sub_retrieve
    )

    portal_url_obj = SimpleNamespace(url=portal_url)
    if confirm_raises is None:
        portal_create = MagicMock(return_value=portal_url_obj)
    else:
        # First call (confirm flow) raises; second call (fallback picker)
        # returns the URL.
        portal_create = MagicMock(
            side_effect=[confirm_raises, portal_url_obj]
        )
    monkeypatch.setattr(
        stripe_billing.stripe.billing_portal.Session, "create", portal_create
    )

    return portal_create, sub_retrieve


def test_create_subscription_update_session_uses_confirm_flow(monkeypatch):
    user = _make_user(stripe_customer_id="cus_existing")
    user.stripe_subscription_id = "sub_live"

    portal_create, sub_retrieve = _patch_stripe_for_update_session(monkeypatch)

    url = stripe_billing.create_subscription_update_session(
        MagicMock(),
        user,
        new_price_id="price_pro_annual",
        return_url="https://printlay.fly.dev/app/settings?plan_changed=1",
    )

    assert url == "https://stripe.test/portal/abc"
    sub_retrieve.assert_called_once_with("sub_live")
    portal_create.assert_called_once()
    kwargs = portal_create.call_args.kwargs
    assert kwargs["customer"] == "cus_fake_123"
    assert kwargs["return_url"].endswith("plan_changed=1")
    flow = kwargs["flow_data"]
    assert flow["type"] == "subscription_update_confirm"
    assert flow["subscription_update_confirm"]["subscription"] == "sub_live"
    items = flow["subscription_update_confirm"]["items"]
    assert items == [
        {"id": "si_existing_item", "price": "price_pro_annual", "quantity": 1}
    ]
    # Ensure we redirect back to our own return_url after the change is
    # confirmed in the portal.
    assert flow["after_completion"]["redirect"]["return_url"].endswith(
        "plan_changed=1"
    )


def test_create_subscription_update_session_falls_back_to_picker(monkeypatch):
    """If Stripe rejects the confirm preset (e.g. portal config doesn't
    list the target price as switchable), we should still get a usable
    portal URL via the generic plan-picker flow."""
    user = _make_user(stripe_customer_id="cus_existing")
    user.stripe_subscription_id = "sub_live"

    err = stripe.InvalidRequestError(
        "price not allowed by portal config",
        param="flow_data",
    )
    portal_create, _ = _patch_stripe_for_update_session(
        monkeypatch,
        portal_url="https://stripe.test/portal/picker",
        confirm_raises=err,
    )

    url = stripe_billing.create_subscription_update_session(
        MagicMock(),
        user,
        new_price_id="price_studio_annual",
        return_url="https://printlay.fly.dev/app/settings",
    )

    assert url == "https://stripe.test/portal/picker"
    assert portal_create.call_count == 2
    # Second call uses the bare subscription_update flow.
    fallback_kwargs = portal_create.call_args_list[1].kwargs
    assert fallback_kwargs["flow_data"]["type"] == "subscription_update"
    assert (
        fallback_kwargs["flow_data"]["subscription_update"]["subscription"]
        == "sub_live"
    )


def test_create_subscription_update_session_raises_when_no_subscription(monkeypatch):
    """Misuse: caller forgot to validate the user has a live sub.
    Should be a loud ValueError, not a misleading portal URL."""
    monkeypatch.setattr(stripe_billing, "_ensure_configured", lambda: None)
    user = _make_user()
    assert user.stripe_subscription_id is None

    with pytest.raises(ValueError, match="no live Stripe subscription"):
        stripe_billing.create_subscription_update_session(
            MagicMock(),
            user,
            new_price_id="price_pro_monthly",
            return_url="https://printlay.fly.dev/app/settings",
        )


def test_create_subscription_update_session_falls_back_when_no_items(monkeypatch):
    """If the retrieved subscription somehow has no items[0].id (Stripe
    weirdness, partial state), we degrade to the plain Customer Portal
    rather than crashing."""
    user = _make_user(stripe_customer_id="cus_existing")
    user.stripe_subscription_id = "sub_live"

    monkeypatch.setattr(stripe_billing, "_ensure_configured", lambda: None)
    monkeypatch.setattr(
        stripe_billing,
        "get_or_create_customer",
        lambda db, user: "cus_fake_123",
    )
    monkeypatch.setattr(
        stripe_billing.stripe.Subscription,
        "retrieve",
        MagicMock(return_value=_AttrDict({"id": "sub_live", "items": {"data": []}})),
    )
    fallback_url = "https://stripe.test/portal/plain"
    # create_portal_session already returns a URL string (it does the
    # `.url` dereference internally), so the patch must mirror that —
    # not return a wrapper object.
    plain_portal = MagicMock(return_value=fallback_url)
    monkeypatch.setattr(
        stripe_billing,
        "create_portal_session",
        plain_portal,
    )

    url = stripe_billing.create_subscription_update_session(
        MagicMock(),
        user,
        new_price_id="price_pro_monthly",
        return_url="https://printlay.fly.dev/app/settings",
    )
    assert url == fallback_url
    plain_portal.assert_called_once()


# ---------------------------------------------------------------------------
# Router: POST /api/billing/change-plan + /checkout 409 guard
# ---------------------------------------------------------------------------

def _make_persistent_user(
    *,
    sub_id: str | None = None,
    sub_status: str | None = None,
    price_id: str | None = None,
) -> User:
    """Build a User suitable for being returned by an overridden
    `_resolve_user`. The router doesn't need to read it from the DB —
    we patch _resolve_user to return this object directly."""
    u = User(email="seat@example.com", auth_id=uuid.uuid4())
    u.id = uuid.uuid4()
    u.stripe_customer_id = "cus_seat"
    u.stripe_subscription_id = sub_id
    u.stripe_subscription_status = sub_status
    u.stripe_price_id = price_id
    return u


def _override_auth_returning(user: User):
    """Replace get_current_user with a stub that returns a synthetic auth
    for `user`. Caller must pop the override afterwards."""
    from backend.auth.jwt import AuthenticatedUser, get_current_user

    fake_auth = AuthenticatedUser(
        auth_id=str(user.auth_id),
        email=user.email,
        raw={"sub": str(user.auth_id), "email": user.email},
    )

    def _override():
        return fake_auth

    app.dependency_overrides[get_current_user] = _override


def _teardown_auth_override():
    from backend.auth.jwt import get_current_user
    app.dependency_overrides.pop(get_current_user, None)


def test_change_plan_endpoint_returns_portal_url(db_session, monkeypatch):
    """Happy path: an active subscriber switching from monthly Pro to
    annual Pro gets a Stripe portal URL back."""
    from backend.routers import billing as billing_router

    settings = get_settings_for_test()
    user = _make_persistent_user(
        sub_id="sub_live_42",
        sub_status="active",
        price_id=settings.stripe_price_pro_monthly or "price_pro_monthly",
    )
    new_price = settings.stripe_price_pro_annual or "price_pro_annual"

    _setup_dependency_overrides(db_session)
    _override_auth_returning(user)
    monkeypatch.setattr(billing_router, "_resolve_user", lambda db, auth: user)
    # Make the settings see the prices we're using as "known".
    monkeypatch.setattr(
        billing_router, "_is_known_price", lambda pid: pid == new_price
    )
    monkeypatch.setattr(
        billing_router.stripe_billing,
        "create_subscription_update_session",
        lambda db, u, *, new_price_id, return_url: "https://stripe.test/portal/changed",
    )
    # The audit hook would otherwise try to insert into a table that
    # doesn't exist in our SQLite-only test fixture. Patch the reference
    # bound inside billing.py (it was `from backend.audit import record`,
    # so the module-level reference is what the route handler calls).
    monkeypatch.setattr(billing_router, "record", lambda *a, **kw: None)

    try:
        client = TestClient(app)
        r = client.post(
            "/api/billing/change-plan",
            json={
                "price_id": new_price,
                "return_url": "https://printlay.fly.dev/app/settings?plan_changed=1",
            },
            headers={"Authorization": "Bearer fake"},
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"url": "https://stripe.test/portal/changed"}
    finally:
        _teardown_auth_override()
        _teardown_dependency_overrides()


def test_change_plan_rejects_users_without_live_subscription(db_session, monkeypatch):
    """A user on trial-only / locked / canceled cannot use change-plan —
    they must go through Checkout to create a subscription first."""
    from backend.routers import billing as billing_router

    user = _make_persistent_user(sub_id=None, sub_status=None, price_id=None)

    _setup_dependency_overrides(db_session)
    _override_auth_returning(user)
    monkeypatch.setattr(billing_router, "_resolve_user", lambda db, auth: user)
    monkeypatch.setattr(billing_router, "_is_known_price", lambda pid: True)
    try:
        client = TestClient(app)
        r = client.post(
            "/api/billing/change-plan",
            json={
                "price_id": "price_pro_monthly",
                "return_url": "https://printlay.fly.dev/app/settings",
            },
            headers={"Authorization": "Bearer fake"},
        )
        assert r.status_code == 400
        assert "live subscription" in r.json()["detail"].lower()
    finally:
        _teardown_auth_override()
        _teardown_dependency_overrides()


def test_change_plan_rejects_same_plan(db_session, monkeypatch):
    """No-op switches shouldn't open the portal — they're a UX bug."""
    from backend.routers import billing as billing_router

    same_price = "price_pro_monthly"
    user = _make_persistent_user(
        sub_id="sub_live", sub_status="active", price_id=same_price
    )

    _setup_dependency_overrides(db_session)
    _override_auth_returning(user)
    monkeypatch.setattr(billing_router, "_resolve_user", lambda db, auth: user)
    monkeypatch.setattr(billing_router, "_is_known_price", lambda pid: True)
    try:
        client = TestClient(app)
        r = client.post(
            "/api/billing/change-plan",
            json={
                "price_id": same_price,
                "return_url": "https://printlay.fly.dev/app/settings",
            },
            headers={"Authorization": "Bearer fake"},
        )
        assert r.status_code == 400
        assert "already on this plan" in r.json()["detail"].lower()
    finally:
        _teardown_auth_override()
        _teardown_dependency_overrides()


def test_checkout_refuses_when_already_subscribed(db_session, monkeypatch):
    """Defence in depth: if the frontend forgets to route through
    /change-plan and tries to start a brand-new Checkout for a user who
    already has a live sub, the backend must refuse with 409 — otherwise
    we'd be one click away from billing the same card twice."""
    from backend.routers import billing as billing_router

    user = _make_persistent_user(
        sub_id="sub_live",
        sub_status="active",
        price_id="price_pro_monthly",
    )

    _setup_dependency_overrides(db_session)
    _override_auth_returning(user)
    monkeypatch.setattr(billing_router, "_resolve_user", lambda db, auth: user)
    monkeypatch.setattr(billing_router, "_is_known_price", lambda pid: True)
    # Fail loudly if the guard is bypassed and the service is invoked.
    monkeypatch.setattr(
        billing_router.stripe_billing,
        "create_checkout_session",
        MagicMock(side_effect=AssertionError("guard bypassed")),
    )
    try:
        client = TestClient(app)
        r = client.post(
            "/api/billing/checkout",
            json={
                "price_id": "price_studio_annual",
                "success_url": "https://printlay.fly.dev/billing/success",
                "cancel_url": "https://printlay.fly.dev/pricing",
            },
            headers={"Authorization": "Bearer fake"},
        )
        assert r.status_code == 409
        assert "live subscription" in r.json()["detail"].lower()
    finally:
        _teardown_auth_override()
        _teardown_dependency_overrides()


def get_settings_for_test():
    from backend.config import get_settings
    return get_settings()


# ---------------------------------------------------------------------------
# Webhook end-to-end (signature + idempotency)
# ---------------------------------------------------------------------------

@pytest.fixture
def db_session():
    """An in-memory SQLite DB just for the StripeEvent table.
    SQLite supports `INSERT ... ON CONFLICT DO NOTHING` since 3.24."""
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,  # share one connection across all sessions
    )
    # Only create the stripe_events table — the rest pull in psycopg-only
    # features (UUID / JSONB) we don't care about for this test.
    StripeEvent.__table__.create(engine)

    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _setup_dependency_overrides(db_session):
    def _override():
        try:
            yield db_session
        finally:
            pass
    app.dependency_overrides[get_db] = _override


def _teardown_dependency_overrides():
    app.dependency_overrides.pop(get_db, None)


def test_webhook_rejects_bad_signature(db_session, monkeypatch):
    _setup_dependency_overrides(db_session)
    try:
        monkeypatch.setattr(
            stripe_billing, "_ensure_configured", lambda: None
        )
        # Pretend webhook secret is set.
        from backend.config import get_settings
        s = get_settings()
        monkeypatch.setattr(s, "stripe_webhook_secret", "whsec_test")
        # Force signature verification to fail.
        import stripe as stripe_mod
        monkeypatch.setattr(
            stripe_mod.Webhook, "construct_event",
            MagicMock(side_effect=stripe_mod.SignatureVerificationError(
                "bad sig", "header"
            )),
        )

        client = TestClient(app)
        r = client.post(
            "/api/billing/webhook",
            content=json.dumps({"id": "evt_x"}),
            headers={"Stripe-Signature": "t=1,v1=bad"},
        )
        assert r.status_code == 400
    finally:
        _teardown_dependency_overrides()


def test_webhook_idempotency_dedupes_repeat_deliveries(db_session, monkeypatch):
    """Two POSTs with the same event ID -> handler runs once, second is
    short-circuited as a duplicate."""
    _setup_dependency_overrides(db_session)
    try:
        monkeypatch.setattr(stripe_billing, "_ensure_configured", lambda: None)
        from backend.config import get_settings
        s = get_settings()
        monkeypatch.setattr(s, "stripe_webhook_secret", "whsec_test")

        # Stub construct_event to return a benign event we don't dispatch on
        # (so we can isolate the de-dup behaviour without mocking handlers).
        fake_event = SimpleNamespace(
            id="evt_dedupe_1",
            type="invoice.payment_succeeded",  # falls through to no-op
            data=SimpleNamespace(object={}),
        )
        import stripe as stripe_mod
        monkeypatch.setattr(
            stripe_mod.Webhook, "construct_event",
            MagicMock(return_value=fake_event),
        )

        client = TestClient(app)
        r1 = client.post(
            "/api/billing/webhook",
            content=b"{}",
            headers={"Stripe-Signature": "t=1,v1=ok"},
        )
        assert r1.status_code == 200, r1.text
        assert r1.json() == {"received": True, "duplicate": False}

        # Same event ID, should be marked duplicate.
        r2 = client.post(
            "/api/billing/webhook",
            content=b"{}",
            headers={"Stripe-Signature": "t=1,v1=ok"},
        )
        assert r2.status_code == 200
        assert r2.json() == {"received": True, "duplicate": True}

        # Ledger has exactly one row.
        assert db_session.query(StripeEvent).count() == 1
    finally:
        _teardown_dependency_overrides()


def test_webhook_handler_failure_releases_idempotency_claim(
    db_session, monkeypatch
):
    """If the dispatched handler raises, we must rollback so Stripe's
    retry can re-process. The idempotency row should NOT survive."""
    _setup_dependency_overrides(db_session)
    try:
        monkeypatch.setattr(stripe_billing, "_ensure_configured", lambda: None)
        from backend.config import get_settings
        s = get_settings()
        monkeypatch.setattr(s, "stripe_webhook_secret", "whsec_test")

        fake_event = SimpleNamespace(
            id="evt_will_crash",
            type="customer.subscription.updated",
            data=SimpleNamespace(object={"customer": "cus_x", "metadata": {}}),
        )
        import stripe as stripe_mod
        monkeypatch.setattr(
            stripe_mod.Webhook, "construct_event",
            MagicMock(return_value=fake_event),
        )

        # Force the handler to crash by patching the dispatcher.
        from backend.routers import billing as billing_router
        monkeypatch.setattr(
            billing_router, "_handle_subscription_change",
            MagicMock(side_effect=RuntimeError("boom")),
        )

        client = TestClient(app)
        r = client.post(
            "/api/billing/webhook",
            content=b"{}",
            headers={"Stripe-Signature": "t=1,v1=ok"},
        )
        assert r.status_code == 500
        # Most importantly: the idempotency row was NOT persisted.
        assert db_session.query(StripeEvent).count() == 0
    finally:
        _teardown_dependency_overrides()
