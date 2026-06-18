"""Merchant API key authentication (machine-to-machine).

The WooCommerce/Shopify plugin presents a key as ``Authorization: Bearer
pl_live_...``. We hash it, look up a non-revoked `MerchantApiKey`, resolve the
owning merchant `User`, and require the `widget_access` entitlement. This is a
*separate* dependency from Supabase `get_current_user` — the two auth schemes
never mix.

End customers never use the key directly: the plugin mints a short-lived widget
session token (see `auth.widget_token`) which the iframe uses instead.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.models import MerchantApiKey, User
from backend.services import entitlements, merchant_keys

_bearer = HTTPBearer(auto_error=False)


@dataclass(slots=True)
class MerchantContext:
    """Resolved caller for widget API endpoints."""

    user: User
    api_key: MerchantApiKey


def get_merchant_from_api_key(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> MerchantContext:
    if creds is None or not merchant_keys.looks_like_key(creds.credentials):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed API key",
            headers={"WWW-Authenticate": "Bearer"},
        )

    key_hash = merchant_keys.hash_key(creds.credentials)
    key = (
        db.query(MerchantApiKey)
        .filter(MerchantApiKey.key_hash == key_hash)
        .one_or_none()
    )
    if key is None or key.revoked_at is not None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or revoked API key",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = db.query(User).filter(User.id == key.user_id).one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key owner not found or inactive",
        )

    ent = entitlements.for_user(user)
    if not ent.allows("widget_access"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This plan does not include the embeddable widget. Upgrade to enable it.",
        )

    # Best-effort last-used stamp; never block the request on it.
    try:
        key.last_used_at = datetime.now(timezone.utc)
        db.commit()
    except Exception:
        db.rollback()

    return MerchantContext(user=user, api_key=key)
