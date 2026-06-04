"""Hard-delete of accounts and affiliate records (admin-only, irreversible).

Two entry points:
  - delete_affiliate_records: remove an affiliate profile + its clicks /
    conversions / payouts / events (DB cascade). Leaves any linked user
    account untouched.
  - delete_user_completely: wipe a user and ALL their data — templates,
    jobs, assets, outputs, colour profiles, sticker data, their affiliate
    profile, and (best-effort) their Supabase auth login so the email
    can't sign back in.

SAFETY: a *paying* account (active Stripe subscription or admin-set
enterprise tier) is never deleted by these helpers — callers must check
is_paying() first and refuse. We protect real customers from accidental
nukes; use deactivation for those instead.
"""
from __future__ import annotations

import logging

import httpx
from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.models.affiliate import AffiliateProfile
from backend.models.user import User
from backend.services import affiliate_service

log = logging.getLogger(__name__)


def is_paying(user: User) -> bool:
    """True for accounts we refuse to hard-delete: an active Stripe
    subscription, or a manually-set enterprise (invoiced) account."""
    return user.stripe_subscription_status == "active" or user.tier == "enterprise"


def supabase_delete_auth_user(auth_id) -> tuple[bool, str | None]:
    """Best-effort delete of the Supabase (GoTrue) auth user via the admin
    API. Requires the service-role key. Returns (ok, error)."""
    s = get_settings()
    base = (s.supabase_url or "").rstrip("/")
    key = s.supabase_service_role_key
    if not base or not key:
        return False, "Supabase service-role key not configured"
    url = f"{base}/auth/v1/admin/users/{auth_id}"
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    try:
        resp = httpx.delete(url, headers=headers, timeout=20.0)
    except httpx.HTTPError as e:
        return False, f"Supabase request failed: {e}"
    if resp.status_code in (200, 204):
        return True, None
    if resp.status_code == 404:
        # Already gone — treat as success so the wipe is idempotent.
        return True, None
    return False, f"Supabase returned HTTP {resp.status_code}: {resp.text[:160]}"


def delete_affiliate_records(db: Session, profile: AffiliateProfile) -> None:
    """Delete an affiliate profile and everything that cascades from it
    (clicks, conversions, payouts, events). Invites the affiliate sent have
    their affiliate_id set NULL (kept for invite history). Caller commits."""
    db.delete(profile)
    db.flush()


def delete_user_completely(
    db: Session, user: User, *, delete_supabase: bool = True
) -> dict:
    """Permanently delete a user and all their data. Assumes the caller has
    already confirmed the user is not a paying customer. Returns a summary.

    Content tables (templates, jobs, assets, outputs, colour profiles,
    sticker sheets/usage, cutter presets, support grants, spot colours) all
    have ON DELETE CASCADE on user_id, so a single user delete cascades them
    at the DB level. The affiliate profile uses SET NULL, so we delete it
    explicitly to avoid leaving an orphan."""
    auth_id = user.auth_id
    email = user.email

    profile = affiliate_service.get_profile_by_user_id(db, user.id)
    had_affiliate = profile is not None
    if profile is not None:
        db.delete(profile)
        db.flush()

    db.delete(user)
    db.commit()

    supabase_ok = None
    supabase_error = None
    if delete_supabase:
        supabase_ok, supabase_error = supabase_delete_auth_user(auth_id)
        if not supabase_ok:
            log.warning(
                "App data for %s deleted but Supabase auth delete failed: %s",
                email, supabase_error,
            )

    return {
        "email": email,
        "deleted_affiliate_profile": had_affiliate,
        "supabase_auth_deleted": supabase_ok,
        "supabase_error": supabase_error,
    }
