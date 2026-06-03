"""Stripe Connect — Express account management for affiliate payouts.

Responsibilities:
    1. Create Express connected accounts for affiliates.
    2. Generate onboarding links (Account Links).
    3. Create transfers from platform to connected account.
    4. Check onboarding completion status.
"""
from __future__ import annotations

import logging
from typing import Optional

import stripe

from backend.config import get_settings

log = logging.getLogger(__name__)


class StripeConnectError(Exception):
    pass


def _ensure_configured() -> None:
    s = get_settings()
    if not s.stripe_secret_key:
        raise StripeConnectError("Stripe is not configured. Set STRIPE_SECRET_KEY.")
    if stripe.api_key != s.stripe_secret_key:
        stripe.api_key = s.stripe_secret_key
        stripe.api_version = "2024-06-20"


def create_express_account(email: str, country: str = "GB") -> str:
    """Create a Stripe Connect Express account. Returns the account ID."""
    _ensure_configured()
    account = stripe.Account.create(
        type="express",
        country=country,
        email=email,
        capabilities={"transfers": {"requested": True}},
    )
    log.info("Created Stripe Express account %s for %s", account.id, email)
    return account.id


def create_onboarding_link(
    account_id: str,
    refresh_url: str,
    return_url: str,
) -> str:
    """Generate an Account Link for Express onboarding. Returns the URL."""
    _ensure_configured()
    link = stripe.AccountLink.create(
        account=account_id,
        refresh_url=refresh_url,
        return_url=return_url,
        type="account_onboarding",
    )
    return link.url


def create_login_link(account_id: str) -> str:
    """Generate a login link so the affiliate can view their Stripe dashboard."""
    _ensure_configured()
    link = stripe.Account.create_login_link(account_id)
    return link.url


def check_onboarding_complete(account_id: str) -> bool:
    """Return True if the account has completed onboarding (charges_enabled)."""
    _ensure_configured()
    account = stripe.Account.retrieve(account_id)
    return bool(account.charges_enabled)


def create_transfer(
    account_id: str,
    amount_pence: int,
    description: Optional[str] = None,
    idempotency_key: Optional[str] = None,
) -> str:
    """Transfer funds from platform to connected account. Returns transfer ID."""
    _ensure_configured()
    kwargs: dict = {
        "amount": amount_pence,
        "currency": "gbp",
        "destination": account_id,
    }
    if description:
        kwargs["description"] = description
    if idempotency_key:
        kwargs["idempotency_key"] = idempotency_key

    transfer = stripe.Transfer.create(**kwargs)
    log.info(
        "Transfer %s: %d pence → %s",
        transfer.id,
        amount_pence,
        account_id,
    )
    return transfer.id


def get_account_balance(account_id: str) -> dict:
    """Retrieve balance for a connected account (for admin display)."""
    _ensure_configured()
    balance = stripe.Balance.retrieve(stripe_account=account_id)
    available = sum(b.amount for b in balance.available) if balance.available else 0
    pending = sum(b.amount for b in balance.pending) if balance.pending else 0
    return {"available_pence": available, "pending_pence": pending}
