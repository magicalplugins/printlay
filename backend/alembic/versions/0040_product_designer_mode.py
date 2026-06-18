"""Add the per-product designer mode.

Products can use one of two design experiences in the embeddable widget:

  - ``cutout`` — single artwork + background removal + contour/face cut line
    (die-cut, face stickers). The existing default.
  - ``canvas`` — a full multi-layer designer (text, shapes, multiple images)
    on a geometric artboard (circle/oval/square/rectangle); the shape itself
    is the cut line.

Revision ID: 0040
Revises: 0039
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0040"
down_revision = "0039"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "products",
        sa.Column(
            "designer",
            sa.String(16),
            nullable=False,
            server_default="cutout",
        ),
    )


def downgrade() -> None:
    op.drop_column("products", "designer")
