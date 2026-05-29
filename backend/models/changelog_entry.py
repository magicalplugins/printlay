"""Changelog entries for the user-facing "What's New" section.

Each entry has a title, body, and tag (feature / improvement / fix).
Admins create entries from the admin panel; they appear on /app/help
for all users once published.
"""

from sqlalchemy import Boolean, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class ChangelogEntry(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "changelog_entries"

    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    tag: Mapped[str] = mapped_column(
        String(30), nullable=False, server_default="feature"
    )
    published: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="true"
    )
