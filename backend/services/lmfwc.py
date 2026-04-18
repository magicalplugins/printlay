"""License Manager for WooCommerce (LMFWC) client.

Speaks to the LMFWC REST API hosted on `magicalplugins.com`. Mirrors the
TypeScript client used by the Murphy's Magic Connector but with PrintLay's own
key prefix (`PL-`), telemetry namespace (`/wp-json/printlay/v1/`) and product
name ("PrintLay") so the two apps never cross-validate or cross-report.

Three core endpoints:
    GET  /wp-json/lmfwc/v2/licenses/validate/{key}
    GET  /wp-json/lmfwc/v2/licenses/activate/{key}?location=...
    GET  /wp-json/lmfwc/v2/licenses/deactivate/{key}?location=...

Plus an optional product-install ping so PrintLay appears under "Products
Installed On" in the LMFWC admin:
    POST /wp-json/lmfwc/v2/products/ping/

This module is *pure* - it does no DB writes, no caching, no grace logic. Those
live in `entitlements.py` so the wire layer stays trivially mockable in tests.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

import httpx

from backend.config import get_settings

log = logging.getLogger(__name__)

LMFWC_PATH = "/wp-json/lmfwc/v2"
TIMEOUT_S = 10.0

Plan = Literal["starter", "professional", "expert", "internal_beta"]


@dataclass(slots=True)
class ValidationResult:
    valid: bool
    plan: Plan = "internal_beta"
    expires_at: datetime | None = None
    activations_used: int | None = None
    activations_max: int | None = None
    message: str | None = None


@dataclass(slots=True)
class MutationResult:
    """Return type for activate / deactivate."""
    ok: bool
    already_done: bool = False
    message: str | None = None


def tier_from_license_key(license_key: str | None) -> Plan:
    """Derive the plan tier from the key prefix.

    PrintLay generators on magicalplugins.com are configured with these
    prefixes, deliberately distinct from the Murphy's connector's
    `STR-` / `PRO-` / `EXPERT-` so the two never cross-match.
    """
    if not license_key:
        return "internal_beta"
    upper = license_key.upper().strip()
    if upper.startswith("PL-EXPERT"):
        return "expert"
    if upper.startswith("PL-PRO"):
        return "professional"
    if upper.startswith("PL-STR"):
        return "starter"
    return "internal_beta"


def location_for_user(user_id: str) -> str:
    """Per-install identifier used for LMFWC activation tracking. Must be
    stable per user so deactivate() can match the right slot."""
    return f"printlay-user-{user_id}"


def _auth() -> httpx.BasicAuth | None:
    s = get_settings()
    if s.lmfwc_consumer_key and s.lmfwc_consumer_secret:
        return httpx.BasicAuth(s.lmfwc_consumer_key, s.lmfwc_consumer_secret)
    return None


def _base() -> str | None:
    url = get_settings().license_server_url
    return url.rstrip("/") if url else None


def is_configured() -> bool:
    s = get_settings()
    return bool(s.license_server_url and s.lmfwc_consumer_key and s.lmfwc_consumer_secret)


def _parse_expires_at(value: str | None) -> datetime | None:
    if not value:
        return None
    # LMFWC returns "2027-04-12 23:59:59" (UTC, naive).
    try:
        return datetime.fromisoformat(value.replace(" ", "T"))
    except ValueError:
        return None


def validate_license(license_key: str) -> ValidationResult:
    """Hit LMFWC's validate endpoint. Pure HTTP - no caching, no DB."""
    base = _base()
    if not base:
        return ValidationResult(valid=False, message="License server not configured")
    if not license_key:
        return ValidationResult(valid=False, message="License key required")

    url = f"{base}{LMFWC_PATH}/licenses/validate/{license_key}"
    try:
        r = httpx.get(url, auth=_auth(), timeout=TIMEOUT_S, headers={"Accept": "application/json"})
        data = _safe_json(r)
        if r.status_code == 200 and data.get("success") is True:
            d = data.get("data") or {}
            return ValidationResult(
                valid=True,
                plan=tier_from_license_key(license_key),
                expires_at=_parse_expires_at(d.get("expiresAt")),
                activations_used=d.get("timesActivated"),
                activations_max=d.get("timesActivatedMax"),
            )
        return ValidationResult(valid=False, message=str(data.get("message") or "License invalid or expired"))
    except httpx.TimeoutException:
        return ValidationResult(valid=False, message="License server timeout")
    except httpx.HTTPError as exc:
        log.warning("LMFWC validate transport error: %s", exc)
        return ValidationResult(valid=False, message=str(exc))


def activate_license(license_key: str, user_id: str) -> MutationResult:
    base = _base()
    if not base or not license_key:
        return MutationResult(ok=False, message="License server not configured")

    location = location_for_user(user_id)
    url = f"{base}{LMFWC_PATH}/licenses/activate/{license_key}"
    try:
        r = httpx.get(
            url,
            auth=_auth(),
            params={"location": location},
            timeout=TIMEOUT_S,
            headers={"Accept": "application/json"},
        )
        data = _safe_json(r)
        if r.status_code == 200 and data.get("success") is True:
            ping_product_install(license_key, user_id)
            return MutationResult(ok=True)
        msg = str(data.get("message") or "Activation failed")
        if "already activated" in msg.lower():
            return MutationResult(ok=True, already_done=True, message=msg)
        return MutationResult(ok=False, message=msg)
    except httpx.HTTPError as exc:
        return MutationResult(ok=False, message=str(exc))


def deactivate_license(license_key: str, user_id: str) -> MutationResult:
    base = _base()
    if not base or not license_key:
        return MutationResult(ok=True)

    location = location_for_user(user_id)
    url = f"{base}{LMFWC_PATH}/licenses/deactivate/{license_key}"
    try:
        r = httpx.get(
            url,
            auth=_auth(),
            params={"location": location},
            timeout=TIMEOUT_S,
            headers={"Accept": "application/json"},
        )
        data = _safe_json(r)
        if r.status_code == 200 and data.get("success") is True:
            return MutationResult(ok=True)
        msg = str(data.get("message") or "Deactivate failed")
        # "License key has not been activated for the given location" is
        # benign - treat as already-done so the UI doesn't trip on a no-op.
        if "not been activated" in msg.lower():
            return MutationResult(ok=True, already_done=True, message=msg)
        return MutationResult(ok=False, message=msg)
    except httpx.HTTPError as exc:
        return MutationResult(ok=False, message=str(exc))


def ping_product_install(license_key: str, user_id: str) -> None:
    """Best-effort POST so PrintLay shows under 'Products Installed On' in the
    LMFWC admin. Failure is silently ignored."""
    base = _base()
    if not base:
        return
    url = f"{base}{LMFWC_PATH}/products/ping/"
    try:
        httpx.post(
            url,
            auth=_auth(),
            json={
                "license_key": license_key,
                "product_name": get_settings().printlay_product_name,
                "host": location_for_user(user_id),
            },
            timeout=TIMEOUT_S,
            headers={"Accept": "application/json"},
        )
    except httpx.HTTPError:
        pass


def _safe_json(response: httpx.Response) -> dict:
    try:
        body = response.json()
        return body if isinstance(body, dict) else {}
    except ValueError:
        return {}
