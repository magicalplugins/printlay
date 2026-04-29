"""Spot colour library, per-user.

A spot colour here is a named PDF Separation colour that print/cut RIPs
(Roland VersaWorks, Mimaki RasterLink, Summa GoSign, etc.) recognise to
trigger non-printing actions - typically driving the cutter on a print-
and-cut machine. The de-facto Roland convention is a Separation named
``CutContour`` rendered in 100 % magenta; Mimaki uses ``Through-cut``;
shops often add their own (``Score``, ``Crease``, ``PerfCut``).

The user maintains a personal library of these definitions. When they
enable "include cut lines" on a job, the compositor draws the slot
outlines using the chosen library entry's name (so the RIP routes the
geometry to the cutter) and preview RGB (so the operator can see the
cut path on screen before sending to print).

A user has at most one entry flagged as ``is_cut_line_default``. That
entry is applied automatically when the operator ticks "Include cut
lines" without picking a specific spot colour from the dropdown.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class SpotColor(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "spot_colors"
    __table_args__ = (
        # Partial unique index: at most one default-cut-line entry per
        # user. Postgres-only; the migration creates the same constraint.
        Index(
            "uq_spot_colors_user_default_cut_line",
            "user_id",
            unique=True,
            postgresql_where="is_cut_line_default",
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    """The PDF Separation colour name. RIPs match this exactly so it
    must be the name the customer's machine expects (e.g. ``CutContour``
    for Roland VersaWorks, ``Through-cut`` for Mimaki). Spaces are
    allowed but case matters - mirror the RIP's docs verbatim."""

    rgb: Mapped[list[int]] = mapped_column(JSONB, nullable=False)
    """Preview RGB triple ``[r, g, b]`` (0-255) used as the Separation's
    DeviceRGB alternate. Pure magenta ``[255, 0, 255]`` is the
    industry-standard "this is a cut line" tint."""

    is_cut_line_default: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default="false",
    )

    # The migration adds this column; we declare it here so SQLAlchemy
    # actually loads it back from rows and `SpotColorOut` (which lists
    # `updated_at` as required) doesn't 500. Mirrors `ColorProfile` -
    # both server_default and onupdate fire so the value is correct
    # whether the row was written by Alembic, raw SQL, or the ORM.
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return f"<SpotColor {self.name!r} rgb={self.rgb} default={self.is_cut_line_default}>"
