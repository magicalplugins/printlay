"""Admin endpoints. All gated by `require_admin` (which checks the caller's
email against the ADMIN_EMAILS env var).

All LMFWC columns are gone as of migration 0010. Subscription truth lives in:
    users.stripe_subscription_status   ('active', 'past_due', 'canceled', None)
    users.stripe_price_id               → plan tier via entitlements
    users.stripe_current_period_end     next renewal / cancellation date
    users.trial_ends_at                 expiry of 14-day Pro trial
    users.founder_member                lifetime badge flag
    users.tier                          'enterprise' for manually-set overrides
"""
from __future__ import annotations

import uuid as _uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from backend.audit import record
from backend.auth import require_admin
from backend.database import get_db
from backend.models import (
    Asset,
    AuditEvent,
    CatalogueSubscription,
    Job,
    Output,
    Template,
    User,
)
from backend.services import entitlements, messaging

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ---------- response models ----------


class TierCount(BaseModel):
    tier: str
    count: int


class StatusCount(BaseModel):
    status: str
    count: int


class TimeSeriesPoint(BaseModel):
    date: str
    count: int


class ActiveUserRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    email: str
    company_name: str | None
    tier: str
    stripe_subscription_status: str | None
    jobs_30d: int
    pdfs_30d: int
    last_pdf_at: datetime | None


class SubscriberRow(BaseModel):
    id: str
    email: str
    company_name: str | None
    tier: str
    plan: str
    stripe_subscription_status: str
    stripe_current_period_end: datetime | None
    founder_member: bool


class DropoutRow(BaseModel):
    id: str
    email: str
    company_name: str | None
    plan: str
    trial_ends_at: datetime | None
    reason: Literal["trial_expired", "canceled", "past_due", "stuck_signup", "stuck_template"]
    last_active_at: datetime | None


class StatsSummary(BaseModel):
    users_total: int
    users_signups_24h: int
    users_signups_7d: int
    users_signups_30d: int
    users_active_30d: int

    pdfs_total: int
    pdfs_24h: int
    pdfs_7d: int
    pdfs_30d: int

    jobs_total: int
    templates_total: int
    assets_total: int
    storage_bytes: int

    # Billing
    active_subscribers: int
    trialing_users: int
    locked_users: int
    past_due_users: int
    founder_members: int

    pdfs_per_day_30d: list[TimeSeriesPoint]
    signups_per_day_30d: list[TimeSeriesPoint]

    tiers: list[TierCount]
    subscription_statuses: list[StatusCount]


class AdminUserRow(BaseModel):
    id: str
    email: str
    phone: str | None
    company_name: str | None
    tier: str
    plan: str
    stripe_subscription_status: str | None
    stripe_current_period_end: str | None
    trial_ends_at: str | None
    founder_member: bool
    created_at: str
    is_active: bool
    jobs_total: int
    pdfs_total: int


class AdminUsersPage(BaseModel):
    total: int
    items: list[AdminUserRow]


class UserDetail(BaseModel):
    id: str
    email: str
    phone: str | None
    company_name: str | None
    tier: str
    plan: str
    stripe_subscription_status: str | None
    stripe_subscription_id: str | None
    stripe_customer_id: str | None
    stripe_price_id: str | None
    stripe_current_period_end: str | None
    trial_ends_at: str | None
    founder_member: bool
    is_active: bool
    created_at: str
    counts: dict
    last_pdf_at: str | None
    last_job_at: str | None
    recent_jobs: list[dict]
    recent_outputs: list[dict]
    catalogue_subscriptions: list[dict]


class UserPatch(BaseModel):
    """Admin-only overrides for a user. Only fields provided are changed."""
    tier: Literal["locked", "starter", "pro", "studio", "enterprise"] | None = None
    founder_member: bool | None = None
    is_active: bool | None = None


# ---------- helpers ----------


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _since(days: int) -> datetime:
    return _utcnow() - timedelta(days=days)


def _plan_label(user: User) -> str:
    """Compute the effective plan label for display without hitting Stripe."""
    ent = entitlements.for_user(user)
    return ent.plan


def _ts_per_day(db: Session, model_cls, days: int) -> list[TimeSeriesPoint]:
    since = _since(days)
    day = func.date_trunc("day", model_cls.created_at).label("day")
    rows = (
        db.query(day, func.count(model_cls.id))
        .filter(model_cls.created_at >= since)
        .group_by(day)
        .order_by(day)
        .all()
    )
    by_day: dict[str, int] = {
        r[0].date().isoformat(): int(r[1]) for r in rows if r[0] is not None
    }
    out: list[TimeSeriesPoint] = []
    today = _utcnow().date()
    for offset in range(days, -1, -1):
        d = (today - timedelta(days=offset)).isoformat()
        out.append(TimeSeriesPoint(date=d, count=by_day.get(d, 0)))
    return out


# ---------- endpoints ----------


@router.get("/stats", response_model=StatsSummary)
def stats(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> StatsSummary:
    now = _utcnow()
    d24 = now - timedelta(hours=24)
    d7 = now - timedelta(days=7)
    d30 = now - timedelta(days=30)

    users_total = db.query(func.count(User.id)).scalar() or 0
    users_signups_24h = db.query(func.count(User.id)).filter(User.created_at >= d24).scalar() or 0
    users_signups_7d = db.query(func.count(User.id)).filter(User.created_at >= d7).scalar() or 0
    users_signups_30d = db.query(func.count(User.id)).filter(User.created_at >= d30).scalar() or 0
    users_active_30d = (
        db.query(func.count(func.distinct(AuditEvent.user_id)))
        .filter(AuditEvent.created_at >= d30, AuditEvent.user_id.isnot(None))
        .scalar() or 0
    )

    pdfs_total = db.query(func.count(Output.id)).scalar() or 0
    pdfs_24h = db.query(func.count(Output.id)).filter(Output.created_at >= d24).scalar() or 0
    pdfs_7d = db.query(func.count(Output.id)).filter(Output.created_at >= d7).scalar() or 0
    pdfs_30d = db.query(func.count(Output.id)).filter(Output.created_at >= d30).scalar() or 0

    jobs_total = db.query(func.count(Job.id)).scalar() or 0
    templates_total = db.query(func.count(Template.id)).scalar() or 0
    assets_total = db.query(func.count(Asset.id)).scalar() or 0
    storage_bytes = int(db.query(func.coalesce(func.sum(Asset.file_size), 0)).scalar() or 0)

    # Billing counts
    active_subscribers = (
        db.query(func.count(User.id))
        .filter(User.stripe_subscription_status == "active")
        .scalar() or 0
    )
    trialing_users = (
        db.query(func.count(User.id))
        .filter(User.trial_ends_at > now, User.stripe_subscription_status != "active")
        .scalar() or 0
    )
    past_due_users = (
        db.query(func.count(User.id))
        .filter(User.stripe_subscription_status == "past_due")
        .scalar() or 0
    )
    founder_members = (
        db.query(func.count(User.id))
        .filter(User.founder_member.is_(True))
        .scalar() or 0
    )
    # Locked = not active subscriber, not trialing, not enterprise
    locked_users = (
        db.query(func.count(User.id))
        .filter(
            User.stripe_subscription_status != "active",
            User.tier != "enterprise",
            (User.trial_ends_at.is_(None)) | (User.trial_ends_at <= now),
        )
        .scalar() or 0
    )

    tier_rows = (
        db.query(User.tier, func.count(User.id))
        .group_by(User.tier)
        .order_by(func.count(User.id).desc())
        .all()
    )
    tiers = [TierCount(tier=r[0] or "unknown", count=int(r[1])) for r in tier_rows]

    status_rows = (
        db.query(
            func.coalesce(User.stripe_subscription_status, "none").label("s"),
            func.count(User.id),
        )
        .group_by("s")
        .order_by(func.count(User.id).desc())
        .all()
    )
    subscription_statuses = [StatusCount(status=r[0], count=int(r[1])) for r in status_rows]

    return StatsSummary(
        users_total=int(users_total),
        users_signups_24h=int(users_signups_24h),
        users_signups_7d=int(users_signups_7d),
        users_signups_30d=int(users_signups_30d),
        users_active_30d=int(users_active_30d),
        pdfs_total=int(pdfs_total),
        pdfs_24h=int(pdfs_24h),
        pdfs_7d=int(pdfs_7d),
        pdfs_30d=int(pdfs_30d),
        jobs_total=int(jobs_total),
        templates_total=int(templates_total),
        assets_total=int(assets_total),
        storage_bytes=storage_bytes,
        active_subscribers=int(active_subscribers),
        trialing_users=int(trialing_users),
        locked_users=int(locked_users),
        past_due_users=int(past_due_users),
        founder_members=int(founder_members),
        pdfs_per_day_30d=_ts_per_day(db, Output, 30),
        signups_per_day_30d=_ts_per_day(db, User, 30),
        tiers=tiers,
        subscription_statuses=subscription_statuses,
    )


@router.get("/users/active", response_model=list[ActiveUserRow])
def active_users(
    limit: int = Query(20, ge=1, le=100),
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[ActiveUserRow]:
    since = _since(30)
    jobs_count = func.count(func.distinct(Job.id)).label("jobs_30d")
    pdfs_count = func.count(func.distinct(Output.id)).label("pdfs_30d")
    last_pdf = func.max(Output.created_at).label("last_pdf_at")

    rows = (
        db.query(
            User.id,
            User.email,
            User.company_name,
            User.tier,
            User.stripe_subscription_status,
            jobs_count,
            pdfs_count,
            last_pdf,
        )
        .outerjoin(Job, (Job.user_id == User.id) & (Job.created_at >= since))
        .outerjoin(Output, (Output.user_id == User.id) & (Output.created_at >= since))
        .group_by(User.id)
        .order_by(pdfs_count.desc(), jobs_count.desc(), last_pdf.desc().nullslast())
        .limit(limit)
        .all()
    )
    return [
        ActiveUserRow(
            id=str(r[0]),
            email=r[1],
            company_name=r[2],
            tier=r[3],
            stripe_subscription_status=r[4],
            jobs_30d=int(r[5] or 0),
            pdfs_30d=int(r[6] or 0),
            last_pdf_at=r[7],
        )
        for r in rows
    ]


@router.get("/users/subscribers", response_model=list[SubscriberRow])
def subscribers(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[SubscriberRow]:
    """Active Stripe subscribers sorted by renewal date ascending (churn risk first)."""
    rows = (
        db.query(User)
        .filter(User.stripe_subscription_status == "active")
        .order_by(User.stripe_current_period_end.asc().nullslast(), User.email.asc())
        .all()
    )
    return [
        SubscriberRow(
            id=str(r.id),
            email=r.email,
            company_name=r.company_name,
            tier=r.tier,
            plan=_plan_label(r),
            stripe_subscription_status=r.stripe_subscription_status or "active",
            stripe_current_period_end=r.stripe_current_period_end,
            founder_member=r.founder_member,
        )
        for r in rows
    ]


@router.get("/users/dropouts", response_model=list[DropoutRow])
def dropouts(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[DropoutRow]:
    """Users worth chasing for re-engagement:

    * `trial_expired`   — trial over, no subscription ever started
    * `canceled`        — was a paying customer, subscription now canceled
    * `past_due`        — subscription active but payment failing
    * `stuck_signup`    — signed up > 7 days ago, never created a template
    * `stuck_template`  — created a template but never generated a PDF
    """
    now = _utcnow()
    seven_days_ago = _since(7)

    last_action = (
        db.query(
            AuditEvent.user_id.label("uid"),
            func.max(AuditEvent.created_at).label("last_at"),
        )
        .filter(AuditEvent.user_id.isnot(None))
        .group_by(AuditEvent.user_id)
        .subquery()
    )

    template_count = (
        db.query(Template.user_id, func.count(Template.id).label("n"))
        .group_by(Template.user_id)
        .subquery()
    )
    output_count = (
        db.query(Output.user_id, func.count(Output.id).label("n"))
        .group_by(Output.user_id)
        .subquery()
    )

    rows = (
        db.query(
            User.id,
            User.email,
            User.company_name,
            User.tier,
            User.stripe_subscription_status,
            User.trial_ends_at,
            User.created_at,
            last_action.c.last_at,
            func.coalesce(template_count.c.n, 0).label("tpl_n"),
            func.coalesce(output_count.c.n, 0).label("out_n"),
        )
        .outerjoin(last_action, last_action.c.uid == User.id)
        .outerjoin(template_count, template_count.c.user_id == User.id)
        .outerjoin(output_count, output_count.c.user_id == User.id)
        .all()
    )

    out: list[DropoutRow] = []
    for r in rows:
        (
            uid, email, company, tier, sub_status, trial_ends_at,
            created_at, last_at, tpl_n, out_n,
        ) = r

        reason = None

        if sub_status == "past_due":
            reason = "past_due"
        elif sub_status == "canceled":
            reason = "canceled"
        elif sub_status != "active" and tier != "enterprise":
            # Not a subscriber — check trial
            trial_expired = (
                trial_ends_at is not None and
                trial_ends_at.replace(tzinfo=timezone.utc) <= now
            )
            if trial_expired:
                reason = "trial_expired"
            elif int(tpl_n) == 0 and created_at < seven_days_ago:
                reason = "stuck_signup"
            elif int(tpl_n) > 0 and int(out_n) == 0 and created_at < seven_days_ago:
                reason = "stuck_template"

        if not reason:
            continue

        # Build a throwaway User-like object for plan resolution
        pseudo = User.__new__(User)
        pseudo.stripe_subscription_status = sub_status
        pseudo.stripe_price_id = None
        pseudo.tier = tier
        pseudo.trial_ends_at = trial_ends_at
        plan_label = entitlements.for_user(pseudo).plan

        out.append(
            DropoutRow(
                id=str(uid),
                email=email,
                company_name=company,
                plan=plan_label,
                trial_ends_at=trial_ends_at,
                reason=reason,
                last_active_at=last_at,
            )
        )

    out.sort(
        key=lambda d: (d.last_active_at or datetime.min.replace(tzinfo=timezone.utc)),
        reverse=True,
    )
    return out


@router.get("/users")
def list_users(
    q: str | None = Query(None, description="Filter by email substring"),
    stripe_status: str | None = Query(None, description="Filter by stripe_subscription_status"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    base = db.query(User)
    if q:
        like = f"%{q.lower()}%"
        base = base.filter(func.lower(User.email).like(like))
    if stripe_status:
        if stripe_status == "trialing":
            now = _utcnow()
            base = base.filter(
                User.trial_ends_at > now,
                User.stripe_subscription_status != "active",
            )
        elif stripe_status == "locked":
            now = _utcnow()
            base = base.filter(
                User.stripe_subscription_status != "active",
                User.tier != "enterprise",
                (User.trial_ends_at.is_(None)) | (User.trial_ends_at <= now),
            )
        else:
            base = base.filter(User.stripe_subscription_status == stripe_status)

    total = base.with_entities(func.count(User.id)).scalar() or 0
    rows = (
        base.order_by(User.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    user_ids = [r.id for r in rows]
    job_counts: dict = {}
    output_counts: dict = {}
    if user_ids:
        for uid, n in (
            db.query(Job.user_id, func.count(Job.id))
            .filter(Job.user_id.in_(user_ids))
            .group_by(Job.user_id)
            .all()
        ):
            job_counts[uid] = int(n)
        for uid, n in (
            db.query(Output.user_id, func.count(Output.id))
            .filter(Output.user_id.in_(user_ids))
            .group_by(Output.user_id)
            .all()
        ):
            output_counts[uid] = int(n)

    items = [
        {
            "id": str(r.id),
            "email": r.email,
            "phone": r.phone,
            "company_name": r.company_name,
            "tier": r.tier,
            "plan": _plan_label(r),
            "stripe_subscription_status": r.stripe_subscription_status,
            "stripe_current_period_end": (
                r.stripe_current_period_end.isoformat()
                if r.stripe_current_period_end else None
            ),
            "trial_ends_at": r.trial_ends_at.isoformat() if r.trial_ends_at else None,
            "founder_member": r.founder_member,
            "created_at": r.created_at.isoformat(),
            "is_active": r.is_active,
            "jobs_total": job_counts.get(r.id, 0),
            "pdfs_total": output_counts.get(r.id, 0),
        }
        for r in rows
    ]
    return {"total": int(total), "items": items}


# ---------- per-user detail ----------


@router.get("/users/{user_id}")
def get_user_detail(
    user_id: str,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    try:
        uid = _uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(400, "Invalid user id")

    u = db.query(User).filter(User.id == uid).one_or_none()
    if u is None:
        raise HTTPException(404, "User not found")

    now = _utcnow()
    thirty = now - timedelta(days=30)
    seven = now - timedelta(days=7)

    jobs_total = db.query(func.count(Job.id)).filter(Job.user_id == u.id).scalar() or 0
    pdfs_total = db.query(func.count(Output.id)).filter(Output.user_id == u.id).scalar() or 0
    templates_total = db.query(func.count(Template.id)).filter(Template.user_id == u.id).scalar() or 0
    pdfs_30d = (
        db.query(func.count(Output.id))
        .filter(Output.user_id == u.id, Output.created_at >= thirty)
        .scalar() or 0
    )
    pdfs_7d = (
        db.query(func.count(Output.id))
        .filter(Output.user_id == u.id, Output.created_at >= seven)
        .scalar() or 0
    )
    last_pdf_at = db.query(func.max(Output.created_at)).filter(Output.user_id == u.id).scalar()
    last_job_at = db.query(func.max(Job.created_at)).filter(Job.user_id == u.id).scalar()
    storage_bytes = (
        db.query(func.coalesce(func.sum(Asset.file_size), 0))
        .filter(Asset.user_id == u.id)
        .scalar() or 0
    )
    asset_count = db.query(func.count(Asset.id)).filter(Asset.user_id == u.id).scalar() or 0

    recent_jobs = (
        db.query(Job).filter(Job.user_id == u.id)
        .order_by(Job.created_at.desc()).limit(10).all()
    )
    recent_outputs = (
        db.query(Output).filter(Output.user_id == u.id)
        .order_by(Output.created_at.desc()).limit(10).all()
    )

    sub_rows = db.query(CatalogueSubscription).filter(CatalogueSubscription.user_id == u.id).all()
    from backend.models import AssetCategory
    sub_cats = []
    if sub_rows:
        cat_map = {
            c.id: c
            for c in db.query(AssetCategory).filter(
                AssetCategory.id.in_([s.category_id for s in sub_rows])
            )
        }
        for s in sub_rows:
            cat = cat_map.get(s.category_id)
            if cat is not None:
                sub_cats.append({
                    "id": str(cat.id),
                    "name": cat.name,
                    "subscribed_at": s.created_at.isoformat(),
                    "is_official": cat.is_official,
                })

    return {
        "id": str(u.id),
        "email": u.email,
        "phone": u.phone,
        "company_name": u.company_name,
        "tier": u.tier,
        "plan": _plan_label(u),
        "stripe_subscription_status": u.stripe_subscription_status,
        "stripe_subscription_id": u.stripe_subscription_id,
        "stripe_customer_id": u.stripe_customer_id,
        "stripe_price_id": u.stripe_price_id,
        "stripe_current_period_end": (
            u.stripe_current_period_end.isoformat()
            if u.stripe_current_period_end else None
        ),
        "trial_ends_at": u.trial_ends_at.isoformat() if u.trial_ends_at else None,
        "founder_member": u.founder_member,
        "is_active": u.is_active,
        "created_at": u.created_at.isoformat(),
        "counts": {
            "jobs_total": int(jobs_total),
            "pdfs_total": int(pdfs_total),
            "pdfs_30d": int(pdfs_30d),
            "pdfs_7d": int(pdfs_7d),
            "templates_total": int(templates_total),
            "asset_count": int(asset_count),
            "storage_bytes": int(storage_bytes),
        },
        "last_pdf_at": last_pdf_at.isoformat() if last_pdf_at else None,
        "last_job_at": last_job_at.isoformat() if last_job_at else None,
        "recent_jobs": [
            {"id": str(j.id), "name": j.name, "created_at": j.created_at.isoformat()}
            for j in recent_jobs
        ],
        "recent_outputs": [
            {
                "id": str(o.id),
                "name": o.name,
                "file_size": o.file_size,
                "slots_filled": o.slots_filled,
                "slots_total": o.slots_total,
                "created_at": o.created_at.isoformat(),
            }
            for o in recent_outputs
        ],
        "catalogue_subscriptions": sub_cats,
    }


@router.patch("/users/{user_id}", response_model=dict)
def patch_user(
    user_id: str,
    payload: UserPatch,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Admin-only overrides. Supports:
      - tier: set to 'enterprise' for invoiced customers, or back to 'locked'
              (does NOT change Stripe — purely for the manual Enterprise path)
      - founder_member: grant/revoke the Founder badge
      - is_active: suspend / unsuspend an account
    Changes are recorded in the audit log."""
    try:
        uid = _uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(400, "Invalid user id")

    u = db.query(User).filter(User.id == uid).one_or_none()
    if u is None:
        raise HTTPException(404, "User not found")

    changes: dict = {}
    if payload.tier is not None and payload.tier != u.tier:
        changes["tier"] = {"from": u.tier, "to": payload.tier}
        u.tier = payload.tier
    if payload.founder_member is not None and payload.founder_member != u.founder_member:
        changes["founder_member"] = {"from": u.founder_member, "to": payload.founder_member}
        u.founder_member = payload.founder_member
    if payload.is_active is not None and payload.is_active != u.is_active:
        changes["is_active"] = {"from": u.is_active, "to": payload.is_active}
        u.is_active = payload.is_active

    if not changes:
        return {"ok": True, "changes": {}}

    db.commit()
    db.refresh(u)
    record(db, admin, "admin.user_patched", target_type="user", target_id=u.id, payload=changes)
    return {"ok": True, "changes": changes, "plan": _plan_label(u)}


# ---------- bulk messaging ----------


SegmentName = Literal[
    "all",
    "active_subscribers",
    "dropouts",
    "most_active_30d",
    "stuck_signup",
    "stuck_template",
    "expiring_30d",
    "trialing",
]


class MessageRequest(BaseModel):
    segment: SegmentName
    channel: Literal["email", "sms"]
    subject: str | None = Field(default=None, max_length=200)
    body: str = Field(min_length=1, max_length=10_000)
    html_body: str | None = Field(default=None, max_length=50_000)
    dry_run: bool = False
    limit: int = Field(default=2000, ge=1, le=10_000)


class MessageResultItem(BaseModel):
    recipient: str
    ok: bool
    error: str | None = None


class MessageResponse(BaseModel):
    segment: SegmentName
    channel: str
    recipients_total: int
    sent: int
    failed: int
    dry_run: bool
    results: list[MessageResultItem]


def _resolve_segment(db: Session, segment: SegmentName, limit: int) -> list[User]:
    now = _utcnow()
    q = db.query(User).filter(User.is_active.is_(True))

    if segment == "all":
        return q.order_by(User.created_at.desc()).limit(limit).all()

    if segment == "active_subscribers":
        return (
            q.filter(User.stripe_subscription_status == "active")
            .order_by(User.email).limit(limit).all()
        )

    if segment == "trialing":
        return (
            q.filter(
                User.trial_ends_at > now,
                User.stripe_subscription_status != "active",
            )
            .order_by(User.trial_ends_at.asc()).limit(limit).all()
        )

    if segment == "dropouts":
        return (
            q.filter(
                User.stripe_subscription_status.in_(["canceled", "past_due"])
                | (
                    (User.stripe_subscription_status.is_(None)) &
                    (User.trial_ends_at <= now)
                )
            )
            .order_by(User.email).limit(limit).all()
        )

    if segment == "most_active_30d":
        since = now - timedelta(days=30)
        sub = (
            db.query(Output.user_id, func.count(Output.id).label("n"))
            .filter(Output.created_at >= since)
            .group_by(Output.user_id).subquery()
        )
        return (
            db.query(User)
            .join(sub, sub.c.user_id == User.id)
            .order_by(sub.c.n.desc()).limit(limit).all()
        )

    if segment == "stuck_signup":
        seven = now - timedelta(days=7)
        sub = db.query(Template.user_id).group_by(Template.user_id).subquery()
        return (
            q.outerjoin(sub, sub.c.user_id == User.id)
            .filter(sub.c.user_id.is_(None), User.created_at < seven)
            .order_by(User.created_at.desc()).limit(limit).all()
        )

    if segment == "stuck_template":
        seven = now - timedelta(days=7)
        tpl = db.query(Template.user_id).group_by(Template.user_id).subquery()
        out_q = db.query(Output.user_id).group_by(Output.user_id).subquery()
        return (
            q.join(tpl, tpl.c.user_id == User.id)
            .outerjoin(out_q, out_q.c.user_id == User.id)
            .filter(out_q.c.user_id.is_(None), User.created_at < seven)
            .order_by(User.created_at.desc()).limit(limit).all()
        )

    if segment == "expiring_30d":
        soon = now + timedelta(days=30)
        return (
            q.filter(
                User.stripe_subscription_status == "active",
                User.stripe_current_period_end.isnot(None),
                User.stripe_current_period_end <= soon,
            )
            .order_by(User.stripe_current_period_end.asc()).limit(limit).all()
        )

    return []


@router.post("/messages", response_model=MessageResponse)
def send_message(
    payload: MessageRequest,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MessageResponse:
    if payload.channel == "email":
        if not payload.subject or not payload.subject.strip():
            raise HTTPException(400, "Email requires a subject")
        if not messaging.email_configured() and not payload.dry_run:
            raise HTTPException(503, "Email provider not configured (RESEND_API_KEY missing)")
    else:
        if not messaging.sms_configured() and not payload.dry_run:
            raise HTTPException(503, "SMS provider not configured (TWILIO_* missing)")

    users = _resolve_segment(db, payload.segment, payload.limit)
    if payload.channel == "email":
        recipients = [u.email for u in users if u.email]
    else:
        recipients = [u.phone for u in users if u.phone and u.phone.strip()]

    seen: set[str] = set()
    deduped: list[str] = []
    for r in recipients:
        if r in seen:
            continue
        seen.add(r)
        deduped.append(r)
    recipients = deduped

    if payload.dry_run:
        return MessageResponse(
            segment=payload.segment, channel=payload.channel,
            recipients_total=len(recipients), sent=0, failed=0, dry_run=True,
            results=[
                MessageResultItem(recipient=r, ok=True, error="dry-run, not sent")
                for r in recipients[:200]
            ],
        )

    if not recipients:
        return MessageResponse(
            segment=payload.segment, channel=payload.channel,
            recipients_total=0, sent=0, failed=0, dry_run=False, results=[],
        )

    if payload.channel == "email":
        results = messaging.send_email_bulk(
            recipients, subject=payload.subject or "",
            text_body=payload.body, html_body=payload.html_body,
        )
    else:
        results = messaging.send_sms_bulk(recipients, body=payload.body)

    sent = sum(1 for r in results if r.ok)
    failed = sum(1 for r in results if not r.ok)
    record(
        db, admin, "admin.message_sent",
        payload={
            "segment": payload.segment, "channel": payload.channel,
            "recipients": len(recipients), "sent": sent, "failed": failed,
        },
    )

    return MessageResponse(
        segment=payload.segment, channel=payload.channel,
        recipients_total=len(recipients), sent=sent, failed=failed, dry_run=False,
        results=[
            MessageResultItem(recipient=r.recipient, ok=r.ok, error=r.error)
            for r in results[:200]
        ],
    )


@router.get("/messaging/status")
def messaging_status(_admin: User = Depends(require_admin)) -> dict:
    return {
        "email_configured": messaging.email_configured(),
        "sms_configured": messaging.sms_configured(),
    }


@router.get("/billing/health")
def billing_health(_admin: User = Depends(require_admin)) -> dict:
    """Stripe wiring diagnostics for the admin panel.

    Returns a per-env-var checklist (no secret values are ever returned).
    Lets the admin verify at a glance that everything's wired before
    going live, and spot drift after a Fly secret rotation.
    """
    from backend.services import stripe_billing

    status = stripe_billing.configuration_status()
    return {
        "fully_configured": all(status.values()),
        "items": status,
    }


@router.get("/catalogue-subscriptions")
def catalogue_subscription_counts(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[dict]:
    from backend.models import AssetCategory

    rows = (
        db.query(
            AssetCategory.id,
            AssetCategory.name,
            func.count(CatalogueSubscription.id).label("sub_count"),
        )
        .outerjoin(CatalogueSubscription, CatalogueSubscription.category_id == AssetCategory.id)
        .filter(AssetCategory.is_official.is_(True))
        .group_by(AssetCategory.id)
        .order_by(func.count(CatalogueSubscription.id).desc(), AssetCategory.name)
        .all()
    )
    return [
        {"id": str(r[0]), "name": r[1], "subscriber_count": int(r[2] or 0)}
        for r in rows
    ]
