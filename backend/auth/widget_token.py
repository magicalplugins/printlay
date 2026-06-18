"""Short-lived signed tokens for the embeddable widget.

Printlay signs its own tokens here with HS256 — these are entirely separate
from Supabase auth. Two uses:

- **Session token** — minted server-side from a merchant API key + product, and
  handed to the iframe. The end customer authenticates widget API calls with
  this, never with the merchant key.
- **Price quote** — a signed payload (price + design ref + options + expiry) the
  widget passes to the store plugin so the line-item price can't be tampered
  with; the order-paid webhook re-verifies it.

The signing secret resolves from WIDGET_SIGNING_SECRET, then
APP_SECRETS_MASTER_KEY, then SUPABASE_JWT_SECRET — so it works in dev without
extra config but should be set explicitly in production.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status
from jose import JWTError, jwt

from backend.config import get_settings

_ALG = "HS256"


def _secret() -> str:
    s = get_settings()
    secret = s.widget_signing_secret or s.app_secrets_master_key or s.supabase_jwt_secret
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Widget signing not configured (set WIDGET_SIGNING_SECRET).",
        )
    return secret


def sign(claims: dict[str, Any], ttl_seconds: int, *, kind: str) -> str:
    """Sign a claims dict with an expiry and a `kind` discriminator so a session
    token can never be replayed as a quote token (or vice versa)."""
    now = datetime.now(timezone.utc)
    payload = {
        **claims,
        "kind": kind,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl_seconds)).timestamp()),
    }
    return jwt.encode(payload, _secret(), algorithm=_ALG)


def verify(token: str, *, kind: str) -> dict[str, Any]:
    """Verify signature + expiry and assert the `kind` matches. Raises 401 on
    any failure."""
    try:
        payload = jwt.decode(token, _secret(), algorithms=[_ALG])
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid or expired token: {exc}",
        ) from exc
    if payload.get("kind") != kind:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token used in the wrong context",
        )
    return payload


# ---- Named wrappers ---------------------------------------------------------

SESSION_TTL_S = 60 * 60 * 2  # 2 hours to design + check out
QUOTE_TTL_S = 60 * 60 * 24  # quote stays valid through a normal checkout


def make_session_token(
    *, session_id: str, merchant_id: str, product_id: str
) -> str:
    return sign(
        {"sid": session_id, "mid": merchant_id, "pid": product_id},
        SESSION_TTL_S,
        kind="widget_session",
    )


def read_session_token(token: str) -> dict[str, Any]:
    return verify(token, kind="widget_session")


def sign_quote(payload: dict[str, Any]) -> str:
    return sign(payload, QUOTE_TTL_S, kind="widget_quote")


def read_quote(token: str) -> dict[str, Any]:
    return verify(token, kind="widget_quote")
