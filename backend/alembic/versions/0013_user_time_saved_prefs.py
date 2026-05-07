"""Add per-user "time saved vs manual imposition" preferences.

Revision ID: 0013
Revises: 0012
Create Date: 2026-05-07

These three columns drive the optional "Time saved" surface on the
Dashboard (this-month banner) and the Outputs page (per-row line).

The number is deliberately *derived*, never invented:
    minutes_saved = setup_minutes + (slots_filled * per_slot_seconds / 60)

Defaults reflect a typical manual InDesign/Illustrator imposition:
~10 minutes of artboard/bleed/cut-mark setup + ~40 seconds per slot
(place artwork, scale, align, verify). Both per-unit values are
user-editable in Settings, so anyone whose real manual workflow is
faster or slower can dial the multiplier to match their reality.

The toggle (`time_saved_show_enabled`) lets users opt out entirely
without losing their bespoke per-unit values - flip it back on and
the previously-tuned numbers are still there.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "time_saved_show_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "time_saved_setup_minutes",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("10"),
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "time_saved_per_slot_seconds",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("40"),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "time_saved_per_slot_seconds")
    op.drop_column("users", "time_saved_setup_minutes")
    op.drop_column("users", "time_saved_show_enabled")
