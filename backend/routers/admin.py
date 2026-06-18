"""Admin endpoints. All gated by `require_admin` (which checks the caller's
email against the ADMIN_EMAILS env var).

All LMFWC columns are gone as of migration 0010. Subscription truth lives in:
    users.stripe_subscription_status   ('active', 'past_due', 'canceled', None)
    users.stripe_price_id               → plan tier via entitlements
    users.stripe_current_period_end     next renewal / cancellation date
    users.trial_ends_at                 expiry of 7-day Pro trial
    users.founder_member                lifetime badge flag
    users.tier                          'enterprise' for manually-set overrides
"""
from __future__ import annotations

import uuid as _uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from backend.audit import record
from backend.auth import is_admin_email, require_admin
from backend.database import get_db
from backend.models import (
    Asset,
    AuditEvent,
    CatalogueSubscription,
    Job,
    Lead,
    Output,
    Template,
    TrialInvite,
    User,
)
from backend.models.affiliate import AffiliateProfile
from backend.models.trial_invite import generate_token
from backend.services import (
    account_deletion,
    asset_pipeline,
    entitlements,
    invite_email,
    messaging,
    secrets_store,
    storage,
)

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
    expire_trial: bool | None = None


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

        # Build a throwaway User-like object for plan resolution. We use
        # SimpleNamespace rather than User() because instantiating the ORM
        # model would attach it to the session — `for_user` only ever reads
        # named attributes, so duck-typing is enough and ~free.
        pseudo = SimpleNamespace(
            email=email,
            stripe_subscription_status=sub_status,
            stripe_price_id=None,
            tier=tier,
            trial_ends_at=trial_ends_at,
        )
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
    affiliate: bool = Query(False, description="Only users who are affiliates"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    base = db.query(User)
    if q:
        like = f"%{q.lower()}%"
        base = base.filter(func.lower(User.email).like(like))
    if affiliate:
        base = base.filter(
            User.id.in_(
                db.query(AffiliateProfile.user_id).filter(
                    AffiliateProfile.user_id.isnot(None)
                )
            )
        )
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
    affiliate_ids: set = set()
    if user_ids:
        affiliate_ids = {
            uid
            for (uid,) in db.query(AffiliateProfile.user_id)
            .filter(AffiliateProfile.user_id.in_(user_ids))
            .all()
        }
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
            "is_affiliate": r.id in affiliate_ids,
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
            {
                "id": str(j.id),
                "name": j.name,
                "created_at": j.created_at.isoformat(),
                "template_id": str(j.template_id),
                "slots_filled": len(j.assignments or {}),
                "slots_total": len(j.slot_order or []),
                "unique_assets": len(set(
                    a.get("asset_id") for a in (j.assignments or {}).values() if a.get("asset_id")
                )),
            }
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


@router.post("/users/{user_id}/jobs/{job_id}/clone", response_model=dict)
def clone_job_to_admin(
    user_id: str,
    job_id: str,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Clone a user's job (template + assets + assignments) into the admin's
    own account so they can test/debug it locally.

    Bytes are physically copied (not key-shared) so the admin's deletion of
    the imported job never reaches into the source user's storage.
    """
    import logging
    import uuid as _uuid
    from backend.services import storage

    log = logging.getLogger(__name__)

    try:
        src_user_uuid = _uuid.UUID(user_id)
        src_job_uuid = _uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(400, "Invalid user_id or job_id")

    source_job = db.query(Job).filter(
        Job.id == src_job_uuid,
        Job.user_id == src_user_uuid,
    ).one_or_none()
    if source_job is None:
        raise HTTPException(404, "Job not found")

    source_tpl = db.query(Template).filter(
        Template.id == source_job.template_id
    ).one_or_none()
    if source_tpl is None:
        raise HTTPException(404, "Template not found")

    # 1) Clone template (file + row).
    new_tpl_id = _uuid.uuid4()
    new_tpl_r2_key = f"users/{admin.id}/templates/{new_tpl_id}/source.pdf"
    try:
        tpl_bytes = storage.get_bytes(source_tpl.r2_key)
        storage.put_bytes(new_tpl_r2_key, tpl_bytes, content_type="application/pdf")
    except Exception as exc:
        raise HTTPException(500, f"Failed to copy template file: {exc}")

    new_tpl = Template(
        id=new_tpl_id,
        user_id=admin.id,
        name=f"[Import] {source_tpl.name}",
        # `source` is NOT NULL on the Template table - mirror the original
        # so generated-vs-uploaded distinctions are preserved end-to-end.
        source=source_tpl.source,
        units=source_tpl.units,
        r2_key=new_tpl_r2_key,
        page_width=source_tpl.page_width,
        page_height=source_tpl.page_height,
        shapes=source_tpl.shapes,
        has_ocg=source_tpl.has_ocg,
        positions_layer=source_tpl.positions_layer,
        bleed_mm=source_tpl.bleed_mm,
        safe_mm=source_tpl.safe_mm,
        registration_type=source_tpl.registration_type,
        mark_offset_mm=source_tpl.mark_offset_mm,
        max_zone_length_mm=source_tpl.max_zone_length_mm,
        generation_params=source_tpl.generation_params,
    )
    db.add(new_tpl)
    db.flush()

    # 2) Pre-allocate the new job id so we can attach cloned assets to it
    # before commit. Without this, JobFiller's listJobUploads filter
    # (`Asset.job_id == job.id`) returns empty - the same bug the in-repo
    # `duplicate_job` works around.
    new_job_id = _uuid.uuid4()

    # Insert a placeholder Job row first so the FK on assets.job_id is
    # satisfied when SQLAlchemy flushes Asset inserts.
    new_job = Job(
        id=new_job_id,
        user_id=admin.id,
        template_id=new_tpl_id,
        name=f"[Import] {source_job.name}",
        slot_order=list(source_job.slot_order or []),
        assignments={},
        color_profile_id=None,
    )
    db.add(new_job)
    db.flush()

    # 3) Clone assets referenced by the source job's assignments.
    all_asset_ids: set[_uuid.UUID] = set()
    for assignment in (source_job.assignments or {}).values():
        aid = assignment.get("asset_id")
        if not aid:
            continue
        try:
            all_asset_ids.add(_uuid.UUID(aid))
        except (ValueError, TypeError):
            log.warning("Skipping malformed asset_id %r on job %s", aid, src_job_uuid)

    asset_id_map: dict[str, str] = {}
    asset_copy_failures: list[str] = []
    if all_asset_ids:
        # Defense-in-depth: filter by the source user too so a forged
        # assignment can't drag bytes out of an unrelated user via this
        # admin endpoint.
        source_assets = (
            db.query(Asset)
            .filter(Asset.id.in_(all_asset_ids), Asset.user_id == src_user_uuid)
            .all()
        )
        for sa in source_assets:
            new_asset_id = _uuid.uuid4()
            new_asset_r2_key = f"users/{admin.id}/assets/{new_asset_id}/source.pdf"
            try:
                asset_bytes = storage.get_bytes(sa.r2_key)
                storage.put_bytes(new_asset_r2_key, asset_bytes, content_type="application/pdf")
            except Exception as exc:
                log.warning("Failed to copy asset %s bytes: %s", sa.id, exc)
                asset_copy_failures.append(sa.name)
                continue

            new_thumb_r2_key = None
            if sa.thumbnail_r2_key:
                new_thumb_r2_key = f"users/{admin.id}/assets/{new_asset_id}/thumb.jpg"
                try:
                    thumb_bytes = storage.get_bytes(sa.thumbnail_r2_key)
                    storage.put_bytes(new_thumb_r2_key, thumb_bytes, content_type="image/jpeg")
                except Exception:
                    new_thumb_r2_key = None

            new_asset = Asset(
                id=new_asset_id,
                user_id=admin.id,
                category_id=None,
                job_id=new_job_id,
                name=f"[Import] {sa.name}",
                kind=sa.kind,
                r2_key=new_asset_r2_key,
                width_pt=sa.width_pt,
                height_pt=sa.height_pt,
                file_size=sa.file_size,
                page_count=sa.page_count,
                thumbnail_r2_key=new_thumb_r2_key,
                cut_contour_json=sa.cut_contour_json,
            )
            db.add(new_asset)
            asset_id_map[str(sa.id)] = str(new_asset_id)

    # 4) Update the job's assignments with remapped asset ids.
    new_assignments: dict[str, dict] = {}
    for slot_key, assignment in (source_job.assignments or {}).items():
        new_a = dict(assignment)
        old_aid = new_a.get("asset_id")
        if old_aid and old_aid in asset_id_map:
            new_a["asset_id"] = asset_id_map[old_aid]
        new_assignments[slot_key] = new_a

    new_job.assignments = new_assignments
    db.commit()

    msg = (
        f"Job '{source_job.name}' imported with "
        f"{len(asset_id_map)} asset{'s' if len(asset_id_map) != 1 else ''}."
    )
    if asset_copy_failures:
        head = ", ".join(asset_copy_failures[:3])
        msg += (
            f" {len(asset_copy_failures)} asset(s) failed to copy"
            f"{': ' + head if asset_copy_failures else ''}."
        )

    record(
        db,
        admin,
        "admin.job_cloned",
        target_type="job",
        target_id=new_job_id,
        payload={
            "src_user_id": str(src_user_uuid),
            "src_job_id": str(src_job_uuid),
            "assets_cloned": len(asset_id_map),
            "assets_failed": len(asset_copy_failures),
        },
    )

    return {
        "job_id": str(new_job_id),
        "template_id": str(new_tpl_id),
        "assets_cloned": len(asset_id_map),
        "assets_failed": len(asset_copy_failures),
        "message": msg,
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
    if payload.expire_trial:
        old_trial = u.trial_ends_at.isoformat() if u.trial_ends_at else None
        u.trial_ends_at = datetime(2020, 1, 1, tzinfo=timezone.utc)
        changes["trial_ends_at"] = {"from": old_trial, "to": "expired"}

    if not changes:
        return {"ok": True, "changes": {}}

    db.commit()
    db.refresh(u)
    record(db, admin, "admin.user_patched", target_type="user", target_id=u.id, payload=changes)
    return {"ok": True, "changes": changes, "plan": _plan_label(u)}


@router.delete("/users/{user_id}")
def delete_user(
    user_id: str,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Permanently delete a user and ALL their data — templates, jobs,
    assets, outputs, colour profiles, sticker data, their affiliate profile
    (DB cascade), plus their Supabase login. Irreversible.

    Refuses for paying customers (active subscription / enterprise) and for
    admins or yourself — deactivate those instead."""
    try:
        uid = _uuid.UUID(user_id)
    except ValueError:
        raise HTTPException(400, "Invalid user id")

    u = db.query(User).filter(User.id == uid).one_or_none()
    if u is None:
        raise HTTPException(404, "User not found")

    if u.id == admin.id:
        raise HTTPException(400, "You can't delete your own account.")
    if is_admin_email(u.email):
        raise HTTPException(400, "Admin accounts can't be deleted here.")
    if account_deletion.is_paying(u):
        raise HTTPException(
            409,
            "This is a paying customer (active subscription / enterprise). "
            "Cancel their subscription or deactivate the account instead.",
        )

    deleted_email = u.email
    # Record the audit BEFORE the row is gone (audit.user_id is SET NULL on
    # delete, so we attribute it to the acting admin with the email in payload).
    record(
        db,
        admin,
        "admin.user_deleted",
        target_type="user",
        target_id=u.id,
        payload={"email": deleted_email},
    )
    db.commit()

    summary = account_deletion.delete_user_completely(db, u)
    return {"ok": True, **summary}


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
    """Wiring status for the bulk-message composer. `email_provider` lets
    the UI render an accurate hint ('SMTP2GO not configured' vs the
    legacy 'Resend not configured')."""
    return {
        "email_configured": messaging.email_configured(),
        "email_provider": messaging.active_email_provider(),
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


# ---------- leads (chat-widget inbox) ----------


class LeadRow(BaseModel):
    id: str
    name: str
    email: str
    phone: str | None
    message: str
    source: str
    page_url: str | None
    user_id: str | None
    status: str
    category: str
    created_at: str


class LeadsPage(BaseModel):
    total: int
    unread: int
    items: list[LeadRow]
    counts_by_category: dict[str, int]


class LeadPatch(BaseModel):
    status: Literal["new", "read", "responded", "archived"]


@router.get("/leads", response_model=LeadsPage)
def list_leads(
    status: str | None = Query(
        None, description="Filter by status. Omit to see everything except archived."
    ),
    category: str | None = Query(
        None, description="Filter by category (support|presales|bug_feature|general)."
    ),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> LeadsPage:
    """List inbound leads, newest first.

    Default view hides archived; pass `status=archived` to see the
    archive. `unread` is the count of `status='new'` regardless of the
    current filter (drives the nav badge). `counts_by_category` always
    reflects unarchived leads matching the current status filter so the
    UI tabs show meaningful counts."""
    q = db.query(Lead)
    if status:
        q = q.filter(Lead.status == status)
    else:
        q = q.filter(Lead.status != "archived")
    if category:
        q = q.filter(Lead.category == category)

    total = q.count()
    rows = (
        q.order_by(Lead.created_at.desc()).limit(limit).offset(offset).all()
    )

    unread = (
        db.query(func.count(Lead.id)).filter(Lead.status == "new").scalar() or 0
    )

    # Counts across categories for the same status filter (without the
    # category restriction) so the tabs always show how many of each
    # category are available to filter into.
    count_q = db.query(Lead.category, func.count(Lead.id))
    if status:
        count_q = count_q.filter(Lead.status == status)
    else:
        count_q = count_q.filter(Lead.status != "archived")
    counts_by_category: dict[str, int] = {
        "support": 0,
        "presales": 0,
        "bug_feature": 0,
        "general": 0,
    }
    for cat, n in count_q.group_by(Lead.category).all():
        counts_by_category[str(cat)] = int(n)

    return LeadsPage(
        total=int(total),
        unread=int(unread),
        counts_by_category=counts_by_category,
        items=[
            LeadRow(
                id=str(r.id),
                name=r.name,
                email=r.email,
                phone=r.phone,
                message=r.message,
                source=r.source,
                page_url=r.page_url,
                user_id=str(r.user_id) if r.user_id else None,
                status=r.status,
                category=r.category,
                created_at=r.created_at.isoformat(),
            )
            for r in rows
        ],
    )


@router.get("/leads/unread-count")
def leads_unread_count(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Cheap single-COUNT query for the admin nav badge."""
    n = db.query(func.count(Lead.id)).filter(Lead.status == "new").scalar() or 0
    return {"unread": int(n)}


@router.patch("/leads/{lead_id}", response_model=LeadRow)
def patch_lead(
    lead_id: str,
    payload: LeadPatch,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> LeadRow:
    try:
        lid = _uuid.UUID(lead_id)
    except ValueError:
        raise HTTPException(400, "Invalid lead id")

    lead = db.query(Lead).filter(Lead.id == lid).one_or_none()
    if lead is None:
        raise HTTPException(404, "Lead not found")

    old_status = lead.status
    lead.status = payload.status
    db.commit()
    db.refresh(lead)

    record(
        db,
        admin,
        "admin.lead_status_changed",
        target_type="lead",
        target_id=lead.id,
        payload={"from": old_status, "to": payload.status},
    )

    return LeadRow(
        id=str(lead.id),
        name=lead.name,
        email=lead.email,
        phone=lead.phone,
        message=lead.message,
        source=lead.source,
        page_url=lead.page_url,
        user_id=str(lead.user_id) if lead.user_id else None,
        status=lead.status,
        category=lead.category,
        created_at=lead.created_at.isoformat(),
    )


# ---------- trial invites (admin-issued extended trials) ----------


# How long an invite URL itself remains valid. The granted trial length is
# separate — set per-invite below. 30 days is generous enough for someone
# who saw the email on holiday and decided to click through after.
_INVITE_LINK_LIFETIME = timedelta(days=30)


class InviteRow(BaseModel):
    id: str
    email: str
    trial_days: int
    note: str | None
    token: str
    invite_url: str
    invited_by_email: str | None
    created_at: str
    expires_at: str
    sent_at: str | None
    accepted_at: str | None
    accepted_user_id: str | None
    revoked_at: str | None
    status: Literal["pending", "accepted", "revoked", "expired"]
    affiliate_label: str | None = None


class InvitesPage(BaseModel):
    total: int
    items: list[InviteRow]


class InviteCreate(BaseModel):
    """Body for issuing a brand-new invite.

    `trial_days` is bounded conservatively — 1–180 days. Anything longer
    smells like a mistake (or an "enterprise" deal that should use the
    tier='enterprise' override instead)."""

    email: str = Field(..., min_length=3, max_length=320)
    trial_days: int = Field(..., ge=1, le=180)
    note: str | None = Field(default=None, max_length=2000)


class InviteSendResult(BaseModel):
    invite: InviteRow
    sent: bool
    send_error: str | None = None


def _invite_status(invite: TrialInvite, now: datetime) -> str:
    if invite.revoked_at is not None:
        return "revoked"
    if invite.accepted_at is not None:
        return "accepted"
    expires = invite.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= now:
        return "expired"
    return "pending"


def _invite_row(
    invite: TrialInvite,
    *,
    inviter_email: str | None,
    now: datetime,
    affiliate_label: str | None = None,
) -> InviteRow:
    return InviteRow(
        id=str(invite.id),
        email=invite.email,
        trial_days=invite.trial_days,
        note=invite.note,
        token=invite.token,
        invite_url=invite_email.build_invite_url(invite.token),
        invited_by_email=inviter_email,
        created_at=invite.created_at.isoformat(),
        expires_at=invite.expires_at.isoformat(),
        sent_at=invite.sent_at.isoformat() if invite.sent_at else None,
        accepted_at=invite.accepted_at.isoformat() if invite.accepted_at else None,
        accepted_user_id=(
            str(invite.accepted_user_id) if invite.accepted_user_id else None
        ),
        revoked_at=invite.revoked_at.isoformat() if invite.revoked_at else None,
        status=_invite_status(invite, now),
        affiliate_label=affiliate_label,
    )


def _affiliate_label_map(
    db: Session, invites: list[TrialInvite]
) -> dict[_uuid.UUID, str]:
    """Map affiliate_id -> a short display label (name or email) for invites
    that were promoted by an affiliate."""
    from backend.models.affiliate import AffiliateProfile

    ids = {i.affiliate_id for i in invites if i.affiliate_id}
    if not ids:
        return {}
    rows = (
        db.query(AffiliateProfile.id, AffiliateProfile.name, AffiliateProfile.email)
        .filter(AffiliateProfile.id.in_(ids))
        .all()
    )
    return {r[0]: (r[1] or r[2]) for r in rows}


def _inviter_email_map(
    db: Session, invites: list[TrialInvite]
) -> dict[_uuid.UUID, str]:
    ids = {i.invited_by_user_id for i in invites if i.invited_by_user_id}
    if not ids:
        return {}
    rows = db.query(User.id, User.email).filter(User.id.in_(ids)).all()
    return {r[0]: r[1] for r in rows}


@router.get("/invites", response_model=InvitesPage)
def list_invites(
    status: str | None = Query(
        None, description="Filter by lifecycle status (pending|accepted|revoked|expired)."
    ),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> InvitesPage:
    """List issued trial invites, newest first. Status is computed on
    read (not stored) so an invite quietly transitions from `pending` to
    `expired` without any background job."""
    now = _utcnow()
    rows: list[TrialInvite] = (
        db.query(TrialInvite)
        .order_by(TrialInvite.created_at.desc())
        .all()
    )

    if status:
        rows = [r for r in rows if _invite_status(r, now) == status]

    total = len(rows)
    rows = rows[offset : offset + limit]
    inviter_map = _inviter_email_map(db, rows)
    affiliate_map = _affiliate_label_map(db, rows)

    return InvitesPage(
        total=total,
        items=[
            _invite_row(
                r,
                inviter_email=inviter_map.get(r.invited_by_user_id),
                now=now,
                affiliate_label=affiliate_map.get(r.affiliate_id) if r.affiliate_id else None,
            )
            for r in rows
        ],
    )


@router.post("/invites", response_model=InviteSendResult, status_code=201)
def create_invite(
    payload: InviteCreate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> InviteSendResult:
    """Create + immediately email a new invite.

    If the email send fails (e.g. RESEND not configured) the invite is
    still persisted so the admin can copy/share the URL manually."""
    email_clean = payload.email.strip().lower()
    if "@" not in email_clean or "." not in email_clean.split("@", 1)[-1]:
        raise HTTPException(400, "Invalid email address.")

    now = _utcnow()
    invite = TrialInvite(
        email=email_clean,
        token=generate_token(),
        trial_days=payload.trial_days,
        note=(payload.note or None),
        invited_by_user_id=admin.id,
        expires_at=now + _INVITE_LINK_LIFETIME,
    )
    db.add(invite)
    db.commit()
    db.refresh(invite)

    result = invite_email.send(
        recipient_email=email_clean,
        trial_days=payload.trial_days,
        token=invite.token,
    )
    if result.ok:
        invite.sent_at = _utcnow()
        db.commit()
        db.refresh(invite)

    record(
        db,
        admin,
        "admin.invite_created",
        target_type="trial_invite",
        target_id=invite.id,
        payload={
            "email": email_clean,
            "trial_days": payload.trial_days,
            "send_ok": result.ok,
            "send_error": result.error,
        },
    )

    return InviteSendResult(
        invite=_invite_row(invite, inviter_email=admin.email, now=_utcnow()),
        sent=result.ok,
        send_error=result.error,
    )


@router.post("/invites/{invite_id}/resend", response_model=InviteSendResult)
def resend_invite(
    invite_id: str,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> InviteSendResult:
    """Resend the invite email. Reuses the same token so any previously
    delivered link keeps working."""
    try:
        iid = _uuid.UUID(invite_id)
    except ValueError:
        raise HTTPException(400, "Invalid invite id")

    invite = db.query(TrialInvite).filter(TrialInvite.id == iid).one_or_none()
    if invite is None:
        raise HTTPException(404, "Invite not found")
    if invite.accepted_at is not None:
        raise HTTPException(400, "Invite already accepted — nothing to resend.")
    if invite.revoked_at is not None:
        raise HTTPException(400, "Invite is revoked — restore it first.")

    result = invite_email.send(
        recipient_email=invite.email,
        trial_days=invite.trial_days,
        token=invite.token,
    )
    if result.ok:
        invite.sent_at = _utcnow()
        db.commit()
        db.refresh(invite)

    inviter_email = None
    if invite.invited_by_user_id:
        inviter_email = (
            db.query(User.email)
            .filter(User.id == invite.invited_by_user_id)
            .scalar()
        )

    record(
        db,
        admin,
        "admin.invite_resent",
        target_type="trial_invite",
        target_id=invite.id,
        payload={"send_ok": result.ok, "send_error": result.error},
    )

    return InviteSendResult(
        invite=_invite_row(invite, inviter_email=inviter_email, now=_utcnow()),
        sent=result.ok,
        send_error=result.error,
    )


class InviteRevoke(BaseModel):
    revoke: bool
    """True to revoke an invite, False to restore a revoked one (so an
    accidental click can be undone)."""


@router.post("/invites/{invite_id}/revoke", response_model=InviteRow)
def revoke_invite(
    invite_id: str,
    payload: InviteRevoke,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> InviteRow:
    try:
        iid = _uuid.UUID(invite_id)
    except ValueError:
        raise HTTPException(400, "Invalid invite id")

    invite = db.query(TrialInvite).filter(TrialInvite.id == iid).one_or_none()
    if invite is None:
        raise HTTPException(404, "Invite not found")
    if invite.accepted_at is not None:
        raise HTTPException(
            400,
            "Invite already accepted — revoking it won't reclaim the trial.",
        )

    invite.revoked_at = _utcnow() if payload.revoke else None
    db.commit()
    db.refresh(invite)

    inviter_email = None
    if invite.invited_by_user_id:
        inviter_email = (
            db.query(User.email)
            .filter(User.id == invite.invited_by_user_id)
            .scalar()
        )

    record(
        db,
        admin,
        "admin.invite_revoked" if payload.revoke else "admin.invite_restored",
        target_type="trial_invite",
        target_id=invite.id,
        payload={},
    )

    return _invite_row(invite, inviter_email=inviter_email, now=_utcnow())


@router.get("/invites/pending-count")
def invites_pending_count(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Cheap COUNT for an admin nav badge (pending = sent but not yet
    accepted or expired)."""
    now = _utcnow()
    n = (
        db.query(func.count(TrialInvite.id))
        .filter(
            TrialInvite.accepted_at.is_(None),
            TrialInvite.revoked_at.is_(None),
            TrialInvite.expires_at > now,
        )
        .scalar()
        or 0
    )
    return {"pending": int(n)}


# ---------- integrations (third-party credentials) ----------


class IntegrationSettingOut(BaseModel):
    """One credential field as shown to the admin. Plaintext is NEVER
    returned — only its set/unset state and where it came from. To
    update, the admin POSTs a fresh value to the set endpoint."""

    key: str
    is_set: bool
    source: Literal["db", "env", "none"]
    """'db' = managed in this UI, 'env' = via fly secret, 'none' = unset."""
    updated_at: str | None
    updated_by_email: str | None


class IntegrationsOut(BaseModel):
    encryption_available: bool
    """False when APP_SECRETS_MASTER_KEY is missing — the UI then shows
    a read-only banner explaining how to set it."""
    email_provider: Literal["smtp2go", "resend", "none"]
    email_configured: bool
    sms_configured: bool
    settings: list[IntegrationSettingOut]


class IntegrationSet(BaseModel):
    key: str = Field(..., max_length=64)
    value: str = Field(default="", max_length=2000)
    """Empty string clears the DB row (env fallback may still apply)."""


class IntegrationTestSend(BaseModel):
    channel: Literal["email", "sms"]
    recipient: str = Field(..., min_length=3, max_length=320)
    """Target address/number for the test. Always sent live — there's
    no real way to dry-run a third-party provider integration test."""


@router.get("/integrations", response_model=IntegrationsOut)
def get_integrations(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> IntegrationsOut:
    metas = secrets_store.list_meta()

    # Resolve actor emails in one query so the list doesn't N+1.
    actor_ids = {m.updated_by_user_id for m in metas if m.updated_by_user_id}
    actor_emails: dict[_uuid.UUID, str] = {}
    if actor_ids:
        actor_emails = {
            r[0]: r[1]
            for r in db.query(User.id, User.email)
            .filter(User.id.in_(actor_ids))
            .all()
        }

    settings_out = [
        IntegrationSettingOut(
            key=m.key,
            is_set=m.is_set,
            source=m.source,
            updated_at=m.updated_at.isoformat() if m.updated_at else None,
            updated_by_email=(
                actor_emails.get(m.updated_by_user_id)
                if m.updated_by_user_id
                else None
            ),
        )
        for m in metas
    ]

    return IntegrationsOut(
        encryption_available=secrets_store.encryption_available(),
        email_provider=messaging.active_email_provider(),
        email_configured=messaging.email_configured(),
        sms_configured=messaging.sms_configured(),
        settings=settings_out,
    )


@router.put("/integrations", response_model=IntegrationsOut)
def set_integration(
    payload: IntegrationSet,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> IntegrationsOut:
    """Upsert one credential. Empty value clears it (env fallback may
    take over). The new value is encrypted before persisting; no
    plaintext is logged."""
    if payload.key not in secrets_store.KNOWN_KEYS:
        raise HTTPException(400, f"Unknown setting key: {payload.key}")
    try:
        secrets_store.set(
            payload.key, payload.value.strip(), actor_user_id=admin.id
        )
    except secrets_store.StoreUnavailable as exc:
        raise HTTPException(
            503,
            f"Encrypted store is unavailable: {exc}. Set APP_SECRETS_MASTER_KEY via fly secrets.",
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    record(
        db, admin, "admin.integration_set",
        target_type="app_setting",
        payload={"key": payload.key, "cleared": not payload.value.strip()},
    )
    return get_integrations(_admin=admin, db=db)


class IntegrationTestResult(BaseModel):
    ok: bool
    error: str | None = None
    provider: str | None = None


@router.post("/integrations/test", response_model=IntegrationTestResult)
def test_integration(
    payload: IntegrationTestSend,
    _admin: User = Depends(require_admin),
) -> IntegrationTestResult:
    """Fire a real test send so the admin gets immediate feedback when
    they paste new credentials. Bypasses the bulk-message dry-run path
    — we want the actual provider to either succeed or return a clear
    error so we can show it in the UI."""
    recipient = payload.recipient.strip()
    if payload.channel == "email":
        provider = messaging.active_email_provider()
        if provider == "none":
            return IntegrationTestResult(
                ok=False,
                error="Email provider not configured.",
                provider="none",
            )
        results = messaging.send_email_bulk(
            [recipient],
            subject="Printlay — integration test",
            text_body=(
                "If you're reading this, your Printlay email integration is "
                "wired up correctly. — sent from the admin Integrations test "
                "button."
            ),
            html_body=(
                '<div style="font-family:-apple-system,BlinkMacSystemFont,'
                "'Segoe UI',sans-serif;background:#0a0a0a;color:#e5e5e5;"
                'padding:24px;border-radius:12px;max-width:480px;">'
                '<div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#a78bfa;font-weight:600;">'
                "Printlay · integration test</div>"
                '<p style="margin:12px 0 0 0;font-size:15px;line-height:1.6;">'
                "Your email integration is wired up correctly. ✓</p>"
                '<p style="margin:12px 0 0 0;font-size:12px;color:#737373;">'
                "Sent from the admin Integrations test button.</p>"
                "</div>"
            ),
            throttle_s=0,
        )
        first = results[0] if results else None
        if first and first.ok:
            return IntegrationTestResult(ok=True, provider=provider)
        return IntegrationTestResult(
            ok=False,
            error=(first.error if first else "No response from mailer"),
            provider=provider,
        )

    # SMS branch
    if not messaging.sms_configured():
        return IntegrationTestResult(
            ok=False,
            error="SMS provider not configured.",
            provider="twilio",
        )
    results = messaging.send_sms_bulk(
        [recipient],
        body="Printlay integration test — your SMS integration works.",
        throttle_s=0,
    )
    first = results[0] if results else None
    if first and first.ok:
        return IntegrationTestResult(ok=True, provider="twilio")
    return IntegrationTestResult(
        ok=False,
        error=(first.error if first else "No response from Twilio"),
        provider="twilio",
    )


# ---------------------------------------------------------------------------
# Placement PDF backfill
# ---------------------------------------------------------------------------

class BackfillResult(BaseModel):
    processed: int = 0
    generated: int = 0
    skipped: int = 0
    errors: int = 0


@router.post("/backfill-placement-pdfs", response_model=BackfillResult)
def backfill_placement_pdfs(
    limit: int = Query(100, ge=1, le=500),
    _admin=Depends(require_admin),
    db: Session = Depends(get_db),
) -> BackfillResult:
    """Generate placement PDFs for assets that don't have one yet."""
    import logging
    log = logging.getLogger(__name__)

    assets = (
        db.query(Asset)
        .filter(Asset.placement_r2_key.is_(None))
        .filter(Asset.r2_key.isnot(None))
        .limit(limit)
        .all()
    )

    result = BackfillResult()
    for asset in assets:
        result.processed += 1
        try:
            source_bytes = storage.get_bytes(asset.r2_key)
            placement = asset_pipeline.generate_placement_pdf(source_bytes)
            if placement is None:
                result.skipped += 1
                continue
            placement_key = asset.r2_key.replace("/normalised.pdf", "/placement.pdf")
            if placement_key == asset.r2_key:
                placement_key = asset.r2_key + ".placement.pdf"
            storage.put_bytes(placement_key, placement, content_type="application/pdf")
            asset.placement_r2_key = placement_key
            result.generated += 1
        except Exception as e:
            log.warning(f"Backfill failed for asset {asset.id}: {e}")
            result.errors += 1

    db.commit()
    return result


# ---------------------------------------------------------------------------
# Generation settings
# ---------------------------------------------------------------------------

class GenerationSettingsResponse(BaseModel):
    compression_threshold_mb: int


class GenerationSettingsUpdate(BaseModel):
    compression_threshold_mb: int


@router.get("/generation-settings", response_model=GenerationSettingsResponse)
def get_generation_settings(
    _admin=Depends(require_admin),
) -> GenerationSettingsResponse:
    from backend.services import generation_settings
    return GenerationSettingsResponse(
        compression_threshold_mb=generation_settings.get_compression_threshold_mb(),
    )


@router.patch("/generation-settings", response_model=GenerationSettingsResponse)
def update_generation_settings(
    payload: GenerationSettingsUpdate,
    admin=Depends(require_admin),
) -> GenerationSettingsResponse:
    from backend.services import generation_settings
    if payload.compression_threshold_mb < 1 or payload.compression_threshold_mb > 10000:
        raise HTTPException(422, "Threshold must be between 1 and 10000 MB")
    generation_settings.set_compression_threshold_mb(
        payload.compression_threshold_mb,
        actor_user_id=admin.id,
    )
    return GenerationSettingsResponse(
        compression_threshold_mb=payload.compression_threshold_mb,
    )
