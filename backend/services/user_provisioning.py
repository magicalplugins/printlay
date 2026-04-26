"""Single source of truth for creating an application-side `users` row from a
Supabase `auth.users` UUID.

Multiple endpoints can be a user's first contact with the API (e.g. the SPA
calls `/api/auth/me` first, but a stale tab might hit `/api/templates`
first). All of those must end up provisioning the user the same way —
same trial, same defaults — so we centralise it here.

Trial policy:
    new user → trial_ends_at = now() + 14 days, full Pro features.
    Existing users without a trial are not retroactively granted one (we
    don't want to give locked-out customers free time by accident); use
    the admin tools for that.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from backend.audit import record
from backend.models import User
from backend.services import telemetry

TRIAL_DAYS = 14


def get_or_provision(db: Session, *, auth_id: uuid.UUID, email: str) -> User:
    """Return the existing app-side user row, or create one with a fresh
    14-day Pro trial. Idempotent + safe to call from any router.

    Email is updated in-place if the Supabase email has changed since last
    sync (users do change email addresses)."""
    row = db.query(User).filter(User.auth_id == auth_id).one_or_none()
    if row is not None:
        if row.email != email:
            row.email = email
            db.commit()
            db.refresh(row)
        return row

    row = User(
        auth_id=auth_id,
        email=email,
        trial_ends_at=datetime.now(timezone.utc) + timedelta(days=TRIAL_DAYS),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    record(db, row, "trial.started", payload={"trial_days": TRIAL_DAYS})
    telemetry.emit(row, "install", {"email_domain": email.split("@", 1)[-1]})
    return row
