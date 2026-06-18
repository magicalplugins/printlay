"""Per-product fixed sizes, custom-size toggle and corner radius.

Adds three columns to ``products`` so each sticker product is fully
configurable in the admin:

  - ``size_presets``     — JSON list of fixed sizes [{width_mm, height_mm}, ...]
    the customer can pick (e.g. 10 mm, 20 mm, 30 mm). Null/empty = none.
  - ``allow_custom_size`` — whether the customer may also type a custom size.
  - ``corner_radius``    — default rounded-corner radius (0..1) for
    square/rectangle artboards; the customer can adjust it.

Revision ID: 0041
Revises: 0040
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0041"
down_revision = "0040"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "products",
        sa.Column("size_presets", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "products",
        sa.Column(
            "allow_custom_size",
            sa.Boolean(),
            nullable=False,
            server_default="true",
        ),
    )
    op.add_column(
        "products",
        sa.Column(
            "corner_radius",
            sa.Float(),
            nullable=False,
            server_default="0.2",
        ),
    )


def downgrade() -> None:
    op.drop_column("products", "corner_radius")
    op.drop_column("products", "allow_custom_size")
    op.drop_column("products", "size_presets")
