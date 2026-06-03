"""Affiliate system models: profiles, clicks, conversions, payouts."""

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class AffiliateProfile(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "affiliate_profiles"

    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        unique=True,
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    ref_code: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="active"
    )
    stripe_connect_account_id: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True
    )
    stripe_connect_onboarding_complete: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    commission_rate: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.20
    )
    min_payout_threshold_pence: Mapped[int] = mapped_column(
        Integer, nullable=False, default=5000
    )
    payout_day_of_month: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1
    )
    pending_balance_pence: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    total_earned_pence: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    total_paid_pence: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )

    clicks = relationship("AffiliateClick", back_populates="affiliate", lazy="dynamic")
    conversions = relationship("AffiliateConversion", back_populates="affiliate", lazy="dynamic")
    payouts = relationship("AffiliatePayout", back_populates="affiliate", lazy="dynamic")


class AffiliateClick(Base, UUIDPrimaryKeyMixin):
    __tablename__ = "affiliate_clicks"

    affiliate_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("affiliate_profiles.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    ip_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    user_agent_snippet: Mapped[Optional[str]] = mapped_column(
        String(200), nullable=True
    )
    landing_path: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    clicked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    converted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    affiliate = relationship("AffiliateProfile", back_populates="clicks")


class AffiliateConversion(Base, UUIDPrimaryKeyMixin):
    __tablename__ = "affiliate_conversions"

    affiliate_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("affiliate_profiles.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    click_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("affiliate_clicks.id", ondelete="SET NULL"),
        nullable=True,
    )
    referred_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    stripe_invoice_id: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True
    )
    stripe_charge_amount_pence: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    commission_pence: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    commission_type: Mapped[str] = mapped_column(
        String(20), nullable=False, default="first_payment"
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending"
    )
    approved_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    converted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    affiliate = relationship("AffiliateProfile", back_populates="conversions")


class AffiliatePayout(Base, UUIDPrimaryKeyMixin):
    __tablename__ = "affiliate_payouts"

    affiliate_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("affiliate_profiles.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    stripe_transfer_id: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True
    )
    amount_pence: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending"
    )
    period_start: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    period_end: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    paid_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    affiliate = relationship("AffiliateProfile", back_populates="payouts")
