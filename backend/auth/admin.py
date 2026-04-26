"""Admin authorisation.

Admin status is governed entirely by the `ADMIN_EMAILS` env var (comma
separated, case insensitive). We deliberately don't store an `is_admin`
flag on the database - the env var is single-source-of-truth, set via
`fly secrets set`, and a leaked DB row can't grant admin access.

Use `require_admin` as a FastAPI dependency on any admin endpoint.
"""
from __future__ import annotations

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from backend.auth.jwt import AuthenticatedUser, get_current_user
from backend.config import get_settings
from backend.database import get_db
from backend.models import User


def is_admin_email(email: str | None) -> bool:
    if not email:
        return False
    return email.strip().lower() in get_settings().admin_email_set


def require_admin(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    """Resolves the calling user *and* asserts they're an admin. Returns the
    User row so the endpoint doesn't need to look it up again. Lazy-imports
    `_resolve_user` to dodge the circular import (auth -> routers.templates
    -> auth)."""
    from backend.routers.templates import _resolve_user  # noqa: PLC0415 - intentional

    user = _resolve_user(db, auth)
    if not is_admin_email(user.email):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return user
