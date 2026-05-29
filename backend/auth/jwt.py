"""Supabase JWT verification.

Supports both signing schemes Supabase issues:

- **Asymmetric (current default for new projects).** ES256/RS256 keys
  exposed at `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`. We verify
  using the matching JWK selected by the token's `kid` header. Keys are
  cached in-process for an hour and refreshed on demand if a token's
  `kid` isn't in the cache (e.g. just after a key rotation).

- **Legacy (HS256 with a shared `SUPABASE_JWT_SECRET`).** Used by older
  projects. We fall back to this when the token has no `kid` *and* a
  `SUPABASE_JWT_SECRET` is configured.

Either way, verification happens entirely in-process - we never round-trip
to Supabase per request.
"""

from dataclasses import dataclass
from threading import Lock
from time import monotonic
from typing import Any

import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from backend.config import get_settings


@dataclass
class AuthenticatedUser:
    auth_id: str
    email: str | None
    raw: dict[str, Any]


_bearer = HTTPBearer(auto_error=False)

_JWKS_TTL_S = 3600.0
_jwks_cache: dict[str, Any] = {}
_jwks_fetched_at: float = 0.0
_jwks_lock = Lock()


def _jwks_url() -> str:
    base = get_settings().supabase_url
    if not base:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Auth not configured: SUPABASE_URL missing",
        )
    return f"{base.rstrip('/')}/auth/v1/.well-known/jwks.json"


def _fetch_jwks() -> dict[str, Any]:
    """Hit Supabase for the current JWKS document. Caller holds the lock."""
    try:
        r = httpx.get(_jwks_url(), timeout=10.0)
        r.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Failed to fetch JWKS: {exc}",
        ) from exc
    body = r.json()
    if not isinstance(body, dict) or "keys" not in body:
        raise HTTPException(503, "JWKS endpoint returned malformed response")
    return body


def _get_jwks(force_refresh: bool = False) -> dict[str, Any]:
    global _jwks_cache, _jwks_fetched_at
    with _jwks_lock:
        if (
            not force_refresh
            and _jwks_cache
            and monotonic() - _jwks_fetched_at < _JWKS_TTL_S
        ):
            return _jwks_cache
        _jwks_cache = _fetch_jwks()
        _jwks_fetched_at = monotonic()
        return _jwks_cache


def _key_for_kid(kid: str) -> dict[str, Any]:
    for entry in _get_jwks().get("keys", []):
        if entry.get("kid") == kid:
            return entry
    # Possible rotation - bypass the cache once.
    for entry in _get_jwks(force_refresh=True).get("keys", []):
        if entry.get("kid") == kid:
            return entry
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=f"Unknown token signing key: {kid}",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _verify(token: str) -> dict[str, Any]:
    settings = get_settings()
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token header: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    kid = header.get("kid")

    if kid:
        # Asymmetric path (ES256/RS256 against JWKS)
        jwk_entry = _key_for_kid(kid)
        algo = header.get("alg") or jwk_entry.get("alg") or "ES256"
        try:
            return jwt.decode(
                token,
                jwk_entry,
                algorithms=[algo],
                audience="authenticated",
            )
        except JWTError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"Invalid token: {exc}",
                headers={"WWW-Authenticate": "Bearer"},
            ) from exc

    # Legacy HS256 fallback - only if a secret is configured.
    if not settings.supabase_jwt_secret:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has no kid and no legacy SUPABASE_JWT_SECRET is configured",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        return jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> AuthenticatedUser:
    if creds is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = _verify(creds.credentials)
    return AuthenticatedUser(
        auth_id=payload["sub"],
        email=payload.get("email"),
        raw=payload,
    )


def get_current_user_optional(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> AuthenticatedUser | None:
    if creds is None:
        return None
    try:
        return get_current_user(creds)
    except HTTPException:
        return None


# ---------------------------------------------------------------------------
# Impersonation-aware user resolution
# ---------------------------------------------------------------------------

from fastapi import Request  # noqa: E402


def get_effective_user(
    request: Request,
    auth: AuthenticatedUser = Depends(get_current_user),
) -> AuthenticatedUser:
    """Return *auth* unless an ``X-Impersonate`` header is present AND the
    caller has an active, unexpired support grant for the target user.

    When impersonation is active the returned ``AuthenticatedUser`` has its
    ``auth_id`` and ``email`` swapped to the target user's values, and a
    private ``_impersonated_by`` dict attached for audit purposes.

    Billing routes should keep using ``get_current_user`` directly so
    impersonation can never trigger payment-changing actions.
    """
    impersonate_id = request.headers.get("X-Impersonate")
    if not impersonate_id:
        return auth

    from backend.auth.admin import is_admin_email
    if not is_admin_email(auth.email):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins may impersonate",
        )

    import uuid as _uuid
    try:
        target_uuid = _uuid.UUID(impersonate_id)
    except ValueError:
        raise HTTPException(400, "X-Impersonate must be a valid UUID")

    from backend.database import get_db as _get_db_fn
    from backend.models import User
    from backend.models.support_grant import SupportGrant

    db_session = next(_get_db_fn())
    try:
        from backend.routers.templates import _resolve_user
        admin_user = _resolve_user(db_session, auth)

        from datetime import datetime, timezone as _tz
        now = datetime.now(_tz.utc)
        grant = (
            db_session.query(SupportGrant)
            .filter(
                SupportGrant.admin_user_id == admin_user.id,
                SupportGrant.target_user_id == target_uuid,
                SupportGrant.status == "active",
                SupportGrant.expires_at > now,
            )
            .first()
        )
        if not grant:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="No active support-access grant for this user",
            )

        target_user = db_session.query(User).filter(User.id == target_uuid).first()
        if not target_user:
            raise HTTPException(404, "Target user not found")
    finally:
        db_session.close()

    return AuthenticatedUser(
        auth_id=target_user.auth_id,
        email=target_user.email,
        raw={**auth.raw, "_impersonated_by": {
            "admin_auth_id": auth.auth_id,
            "admin_email": auth.email,
            "admin_user_id": str(admin_user.id),
            "grant_id": str(grant.id),
        }},
    )
