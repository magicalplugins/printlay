"""Single source of truth for creating an application-side `users` row from a
Supabase `auth.users` UUID.

Multiple endpoints can be a user's first contact with the API (e.g. the SPA
calls `/api/auth/me` first, but a stale tab might hit `/api/templates`
first). All of those must end up provisioning the user the same way —
same trial, same defaults — so we centralise it here.

Trial policy:
    new user → trial_ends_at = now() + 7 days, full Pro features.
    invited new user (valid invite_token) → custom trial_days from the invite.
    Existing users without a trial are not retroactively granted one (we
    don't want to give locked-out customers free time by accident); use
    the admin tools for that.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from backend.audit import record
from backend.models import TrialInvite, User
from backend.models.affiliate import AffiliateProfile
from backend.services import telemetry

TRIAL_DAYS = 7


def _consume_invite(
    db: Session, *, token: str | None, email: str
) -> TrialInvite | None:
    """Look up and validate a pending invite, returning it if it can be
    redeemed for this email. Does not commit — the caller commits along
    with the new user row so we don't partially apply the invite."""
    if not token:
        return None
    invite = db.query(TrialInvite).filter(TrialInvite.token == token).one_or_none()
    if invite is None:
        return None
    if invite.revoked_at is not None:
        return None
    if invite.accepted_at is not None:
        return None
    now = datetime.now(timezone.utc)
    expires = invite.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= now:
        return None
    # Email tying: invites are issued to a specific address. We compare
    # case-insensitively because Supabase normalises emails to lowercase
    # but humans type them however they like.
    if (invite.email or "").lower() != (email or "").lower():
        return None
    return invite


def get_or_provision(
    db: Session,
    *,
    auth_id: uuid.UUID,
    email: str,
    invite_token: str | None = None,
    affiliate_ref: str | None = None,
) -> User:
    """Return the existing app-side user row, or create one with a fresh
    Pro trial. Idempotent + safe to call from any router.

    If `invite_token` is supplied and resolves to a valid invite issued
    to this email, the trial length comes from the invite instead of
    the default 7 days. The invite is then marked accepted.

    If `affiliate_ref` is supplied and maps to a valid affiliate profile,
    the new user is attributed to that affiliate.

    Email is updated in-place if the Supabase email has changed since last
    sync (users do change email addresses)."""
    row = db.query(User).filter(User.auth_id == auth_id).one_or_none()
    if row is not None:
        if row.email != email:
            row.email = email
            db.commit()
            db.refresh(row)
        return row

    from backend.services import affiliate_service

    now = datetime.now(timezone.utc)
    invite = _consume_invite(db, token=invite_token, email=email)

    # Is this signup an affiliate claiming their OWN account? Affiliate
    # profiles are created (by admin for ghost affiliates, or via public
    # affiliate signup) with no user_id. When the matching email registers
    # we link the two — but the login must NOT hand them the product. An
    # affiliate account is created LOCKED (no trial) unless they were also
    # explicitly invited to try the product (invite present). The admin can
    # always grant a trial later from the admin tools.
    own_affiliate = affiliate_service.get_profile_by_email(db, email)
    is_unclaimed_affiliate = (
        own_affiliate is not None and own_affiliate.user_id is None
    )

    if invite is not None:
        trial_days: int | None = invite.trial_days
    elif is_unclaimed_affiliate:
        trial_days = None  # locked — affiliate dashboard only, product stays off
    else:
        trial_days = TRIAL_DAYS

    row = User(
        auth_id=auth_id,
        email=email,
        trial_ends_at=(now + timedelta(days=trial_days)) if trial_days else None,
    )

    # Who referred this new user (independent of whether they're an affiliate
    # themselves)? Priority: explicit ?ref= code, then the affiliate tagged on
    # the invite they redeemed. Never attribute an affiliate to themselves.
    referred_profile = None
    if affiliate_ref:
        p = affiliate_service.get_profile_by_ref_code(db, affiliate_ref)
        if p and p.status == "active":
            referred_profile = p
    if referred_profile is None and invite is not None and invite.affiliate_id:
        p = (
            db.query(AffiliateProfile)
            .filter(AffiliateProfile.id == invite.affiliate_id)
            .one_or_none()
        )
        if p and p.status == "active":
            referred_profile = p

    own_id = own_affiliate.id if own_affiliate is not None else None
    if referred_profile is not None and referred_profile.id != own_id:
        row.referred_by_affiliate_id = referred_profile.id
    else:
        referred_profile = None

    db.add(row)
    db.flush()

    # Link the affiliate profile to the freshly-created user account.
    if is_unclaimed_affiliate:
        own_affiliate.user_id = row.id

    # Track the trial/signup against the referring affiliate even though no
    # sale has happened yet — this is what lets affiliates see how many trials
    # they generate, not just paying conversions. Wrapped in a SAVEPOINT so a
    # tracking failure (e.g. table not migrated yet) rolls back only this
    # insert and never poisons the outer transaction that provisions the
    # user — affiliate analytics must never block login.
    if referred_profile is not None:
        try:
            with db.begin_nested():
                domain = email.split("@", 1)[-1]
                detail = (
                    f"trial {trial_days}d · {domain}"
                    if trial_days
                    else f"signup · {domain}"
                )
                affiliate_service.record_signup_event(
                    db,
                    affiliate_id=referred_profile.id,
                    referred_user_id=row.id,
                    detail=detail,
                )
        except Exception:
            import logging

            logging.getLogger(__name__).exception(
                "Failed to record affiliate signup event for user %s", row.id
            )

    if invite is not None:
        invite.accepted_at = now
        invite.accepted_user_id = row.id

    db.commit()
    db.refresh(row)
    record(
        db,
        row,
        "trial.started",
        payload={
            "trial_days": trial_days,
            "via_invite": invite is not None,
            "invite_id": str(invite.id) if invite else None,
            "affiliate_ref": affiliate_ref if row.referred_by_affiliate_id else None,
            "affiliate_account": is_unclaimed_affiliate,
        },
    )
    telemetry.emit(
        row,
        "install",
        {
            "email_domain": email.split("@", 1)[-1],
            "trial_days": trial_days,
            "via_invite": invite is not None,
        },
    )
    return row
