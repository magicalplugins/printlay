"""Add proof system fields and quantity presets.

Revision ID: 0048
Revises: 0047
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0048"
down_revision = "0047"
branch_labels = None
depends_on = None

DEFAULT_QTY_PRESETS = [10, 30, 50, 100, 200, 300, 500, 750, 1000, 2500]


def upgrade() -> None:
    # PricingProfile: quantity presets
    op.add_column(
        "pricing_profiles",
        sa.Column("quantity_presets", JSONB, nullable=True, server_default=None),
    )
    op.add_column(
        "pricing_profiles",
        sa.Column(
            "allow_custom_quantity",
            sa.Boolean(),
            nullable=False,
            server_default="true",
        ),
    )

    # Product: proof settings
    op.add_column(
        "products",
        sa.Column("require_proof", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.add_column(
        "products",
        sa.Column("proof_fee", sa.Float(), nullable=False, server_default="0.0"),
    )

    # PrintOrder: proof workflow
    op.add_column(
        "print_orders",
        sa.Column("proof_status", sa.String(20), nullable=True),
    )
    op.add_column(
        "print_orders",
        sa.Column("proof_notes", sa.String(2000), nullable=True),
    )
    op.add_column(
        "print_orders",
        sa.Column("proof_history", JSONB, nullable=True),
    )
    op.add_column(
        "print_orders",
        sa.Column("customer_email", sa.String(254), nullable=True),
    )
    op.add_column(
        "print_orders",
        sa.Column("proof_token", sa.String(64), nullable=True),
    )
    op.create_index("ix_print_orders_proof_token", "print_orders", ["proof_token"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_print_orders_proof_token", table_name="print_orders")
    op.drop_column("print_orders", "proof_token")
    op.drop_column("print_orders", "customer_email")
    op.drop_column("print_orders", "proof_history")
    op.drop_column("print_orders", "proof_notes")
    op.drop_column("print_orders", "proof_status")
    op.drop_column("products", "proof_fee")
    op.drop_column("products", "require_proof")
    op.drop_column("pricing_profiles", "allow_custom_quantity")
    op.drop_column("pricing_profiles", "quantity_presets")
