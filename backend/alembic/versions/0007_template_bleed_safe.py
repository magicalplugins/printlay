"""template bleed_mm + safe_mm

Revision ID: 0007
Revises: 0006
Create Date: 2026-04-18

Per-template bleed and safe-zone settings (in millimetres). These apply
uniformly to every shape on the template:

* `bleed_mm`: artwork is allowed to extend this far past every edge of
  each slot's bounding box. Does NOT change the artboard size.
* `safe_mm`: critical artwork should stay within the slot bbox shrunk by
  this amount on every side. Used for designer guides; the compositor
  does not enforce it (cut variation is the user's call).

Default 0/0 keeps existing behaviour identical.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "templates",
        sa.Column("bleed_mm", sa.Float(), nullable=False, server_default="0"),
    )
    op.add_column(
        "templates",
        sa.Column("safe_mm", sa.Float(), nullable=False, server_default="0"),
    )
    # Drop server_default once columns are populated; ORM provides default.
    op.alter_column("templates", "bleed_mm", server_default=None)
    op.alter_column("templates", "safe_mm", server_default=None)


def downgrade() -> None:
    op.drop_column("templates", "safe_mm")
    op.drop_column("templates", "bleed_mm")
