"""Auth-adjacent endpoints. Sign-up / sign-in happen against Supabase directly
from the frontend; this router only:

- Exposes the public bootstrap config (Supabase URL + anon key) to the SPA.
- Returns the calling user's profile (`/me`), provisioning a `users` row on
  first call (effectively a JIT mirror of `auth.users`).
- Lets the SPA persist the post-signup profile completion gate.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from backend.audit import record
from backend.auth import AuthenticatedUser, get_current_user, is_admin_email
from backend.config import get_settings
from backend.database import get_db
from backend.models import User
from backend.schemas.auth import ProfileUpdate, PublicConfig, UserOut
from backend.services import telemetry, user_provisioning

router = APIRouter(prefix="/api", tags=["auth"])


def _to_user_out(row: User) -> UserOut:
    return UserOut(
        id=row.id,
        auth_id=row.auth_id,
        email=row.email,
        tier=row.tier,
        is_active=row.is_active,
        created_at=row.created_at,
        trial_ends_at=row.trial_ends_at,
        stripe_subscription_status=row.stripe_subscription_status,
        stripe_price_id=row.stripe_price_id,
        founder_member=row.founder_member,
        phone=row.phone,
        company_name=row.company_name,
        needs_profile=not row.has_completed_profile(),
        is_admin=is_admin_email(row.email),
    )


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
) -> UserOut:
    if not user.email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="JWT missing email claim",
        )

    row = user_provisioning.get_or_provision(
        db, auth_id=user.auth_id, email=user.email
    )
    return _to_user_out(row)


@router.put("/auth/me/profile", response_model=UserOut)
def update_profile(
    payload: ProfileUpdate,
    user: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserOut:
    """Persist the post-signup profile fields (phone + company). The SPA
    sends this from the profile-setup screen the first time a user lands
    in /app and `needs_profile` is true."""
    row = db.query(User).filter(User.auth_id == user.auth_id).one_or_none()
    if row is None:
        raise HTTPException(404, "User not provisioned yet; call /api/auth/me first")

    was_first_time = not row.has_completed_profile()
    row.phone = payload.phone
    row.company_name = payload.company_name
    db.commit()
    db.refresh(row)

    if was_first_time:
        record(db, row, "profile.completed", payload={"company_present": bool(payload.company_name)})
        telemetry.emit(row, "profile_completed", {"company_present": bool(payload.company_name)})
    return _to_user_out(row)
