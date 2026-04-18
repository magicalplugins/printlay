"""Auth-adjacent endpoints. Sign-up / sign-in happen against Supabase directly
from the frontend; this router only:

- Exposes the public bootstrap config (Supabase URL + anon key) to the SPA.
- Returns the calling user's profile (`/me`), provisioning a `users` row on
  first call (effectively a JIT mirror of `auth.users`).
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from backend.auth import AuthenticatedUser, get_current_user
from backend.config import get_settings
from backend.database import get_db
from backend.models import User
from backend.schemas.auth import PublicConfig, UserOut
from backend.services import telemetry

router = APIRouter(prefix="/api", tags=["auth"])


@router.get("/config", response_model=PublicConfig)
def public_config() -> PublicConfig:
    settings = get_settings()
    return PublicConfig(
        supabase_url=settings.supabase_url,
        supabase_anon_key=settings.supabase_anon_key,
        environment=settings.environment,
    )


@router.get("/auth/me", response_model=UserOut)
def me(
    user: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    if not user.email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="JWT missing email claim",
        )

    row = db.query(User).filter(User.auth_id == user.auth_id).one_or_none()
    if row is None:
        row = User(auth_id=user.auth_id, email=user.email)
        db.add(row)
        db.commit()
        db.refresh(row)
        telemetry.emit(row, "install", {"email_domain": user.email.split("@", 1)[-1]})
    elif row.email != user.email:
        # Email change in Supabase - keep our copy in sync.
        row.email = user.email
        db.commit()
        db.refresh(row)
    return row
