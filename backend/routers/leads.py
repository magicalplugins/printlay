"""Public lead capture endpoint — the floating chat widget posts here.

Anonymous-by-default. If the caller happens to have a valid Supabase
session (i.e. they're an existing user opening the widget from inside
the app) we attach their user_id to the lead so the admin inbox can
deep-link to their user detail page.

Rate-limited by IP to keep a single bored visitor from filling the
inbox with junk.
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from backend.auth import AuthenticatedUser, get_current_user_optional
from backend.database import get_db
from backend.models import Lead, User
from backend.rate_limit import limiter

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/leads", tags=["leads"])


class LeadIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    email: EmailStr
    message: str = Field(..., min_length=1, max_length=5000)
    page_url: Optional[str] = Field(default=None, max_length=512)


class LeadOut(BaseModel):
    ok: bool = True


@router.post("", response_model=LeadOut)
@limiter.limit("10/hour")
def submit_lead(
    request: Request,
    payload: LeadIn,
    auth: Optional[AuthenticatedUser] = Depends(get_current_user_optional),
    db: Session = Depends(get_db),
) -> LeadOut:
    """Create a new lead. Always returns 200 on success — the widget shows
    a generic "we'll get back to you" message regardless of who you are,
    so we don't leak any signal about whether the email matches a real
    account."""
    # Trim defensively — the widget already trims client-side but a
    # raw API call might not.
    name = payload.name.strip()[:120]
    email = str(payload.email).strip().lower()[:320]
    message = payload.message.strip()[:5000]

    if not name or not message:
        raise HTTPException(400, "Name and message are required.")

    user_id = None
    if auth is not None:
        # Best-effort attribution — silently skip if the user row doesn't
        # exist yet (shouldn't happen post-provisioning, but defensive).
        user = (
            db.query(User).filter(User.auth_id == auth.auth_id).one_or_none()
        )
        if user is not None:
            user_id = user.id

    lead = Lead(
        name=name,
        email=email,
        message=message,
        page_url=(payload.page_url or "")[:512] or None,
        user_id=user_id,
        source="widget",
        status="new",
    )
    db.add(lead)
    db.commit()
    log.info("lead captured id=%s email=%s", lead.id, email)
    return LeadOut(ok=True)
