"""Supabase JWT verification.

Supabase signs JWTs with HS256 using the project's `SUPABASE_JWT_SECRET`
(visible in Project Settings -> API -> JWT Settings). We verify the signature
locally on every request - no round-trip to Supabase.
"""

from dataclasses import dataclass
from typing import Any

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


def _verify(token: str) -> dict[str, Any]:
    settings = get_settings()
    if not settings.supabase_jwt_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Auth not configured: SUPABASE_JWT_SECRET missing",
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
