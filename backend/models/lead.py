"""Inbound lead capture — chat-style contact widget on the marketing site
and inside the authenticated app.

A lead is anyone who clicked the floating chat button and submitted name
+ email + message. They may or may not have an existing PrintLay account;
when they do, `user_id` is populated so the admin can jump straight to
their user detail page. The widget collects the current page URL so the
sales reply can reference what they were looking at.

Status lifecycle (admin-driven):
    new        — fresh, unread (default)
    read       — viewed in the admin inbox
    responded  — admin has replied (manual flag, no automation)
    archived   — hidden from the default inbox view

Status is a plain string rather than an enum so adding a new state later
(spam, snoozed, etc.) is a frontend-only change.
"""

import uuid

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Lead(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "leads"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    email: Mapped[str] = mapped_column(String(320), nullable=False, index=True)
    message: Mapped[str] = mapped_column(Text, nullable=False)

    source: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="widget"
    )
    """Where the lead came from. Currently only "widget"; future values
    might be "demo_form", "pricing_enterprise", etc."""

    page_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    """The URL the user was on when they opened the widget — useful
    context for replies ('I see you were on the Pro pricing page...')."""

    phone: Mapped[str | None] = mapped_column(String(40), nullable=True)
    """Optional callback number. Offered (but not required) for
    pre-sales enquiries so we can ring back quickly when someone is
    actively shopping. Stored as the user typed it — no normalisation,
    since international formats vary too much for a reliable parse."""

    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    """Set when the submitter was logged in at the time of submission.
    Lets the admin jump straight to the user detail page."""

    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="new", index=True
    )
    """One of: new | read | responded | archived. See module docstring."""

    category: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="general", index=True
    )
    """User-selected category at submission time. One of:
        support       — existing customer needs help
        presales      — questions before buying
        bug_feature   — bug report or feature request
        general       — fallback for legacy / non-widget sources
    Lets the admin filter the inbox by request type."""

    def __repr__(self) -> str:
        return f"<Lead {self.email!r} status={self.status}>"
