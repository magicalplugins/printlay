"""Add show_filters, show_ai_styles, show_hand_edit columns to products table.

Revision ID: 0047
Revises: 0046
"""

from alembic import op
import sqlalchemy as sa

revision = "0047"
down_revision = "0046"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "products",
        sa.Column("show_filters", sa.Boolean(), nullable=False, server_default="true"),
    )
    op.add_column(
        "products",
        sa.Column("show_ai_styles", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.add_column(
        "products",
        sa.Column("show_hand_edit", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("products", "show_hand_edit")
    op.drop_column("products", "show_ai_styles")
    op.drop_column("products", "show_filters")
