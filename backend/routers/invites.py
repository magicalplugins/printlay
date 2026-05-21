"""Public endpoint for resolving an invite token.

The Register page hits this with the `?invite=<token>` from the URL to
show the recipient their name/days before they sign up — gives the
"this was personally for you" feel without leaking the entire invites
table.

The endpoint is intentionally read-only and conservative: invalid,
expired, revoked, or already-claimed tokens all return 404 (no
distinction in the public response) so attackers can't fingerprint
state by probing. The admin UI has full lifecycle visibility.
"""
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.models import TrialInvite
from backend.rate_limit import limiter

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/invites", tags=["invites"])


class InviteInfoOut(BaseModel):
    email: str
    trial_days: int


@router.get("/{token}", response_model=InviteInfoOut)
@limiter.limit("60/hour")
def get_invite_info(
    request: Request,
    token: str,
    db: Session = Depends(get_db),
) -> InviteInfoOut:
    """Resolve a token to its recipient email + trial length.

    Returns 404 for any non-claimable state (missing, revoked, expired,
    already accepted) so a probe attack can't enumerate invites. We
    expose only the two fields the Register page actually needs."""
    if not token or len(token) > 64:
        raise HTTPException(404, "Invite not found.")

    invite = (
        db.query(TrialInvite).filter(TrialInvite.token == token).one_or_none()
    )
    if invite is None:
        raise HTTPException(404, "Invite not found.")
    if invite.revoked_at is not None or invite.accepted_at is not None:
        raise HTTPException(404, "Invite not found.")

    now = datetime.now(timezone.utc)
    expires = invite.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= now:
        raise HTTPException(404, "Invite not found.")

    return InviteInfoOut(email=invite.email, trial_days=invite.trial_days)
