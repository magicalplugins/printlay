from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.audit import record
from backend.auth import AuthenticatedUser, get_current_user, is_admin_email, require_admin
from backend.database import get_db
from backend.models import Asset, AssetCategory, CatalogueSubscription, User
from backend.routers.templates import _resolve_user
from backend.schemas.asset import AssetOut, CategoryCreate, CategoryOut
from backend.services import (
    asset_pipeline,
    catalogue_bundle,
    entitlements,
    storage,
    storage_usage,
)

router = APIRouter(prefix="/api", tags=["catalogue"])

# Hard ceiling on bundle imports — independent of plan, this just stops
# someone from hammering us with a 10 GB ZIP. Per-asset and total-storage
# enforcement happens via the entitlement / storage_usage layer.
MAX_BUNDLE_BYTES = 200 * 1024 * 1024


_PREVIEW_CONTENT_TYPES: dict[str, str] = {
    "svg": "image/svg+xml",
    "png": "image/png",
    "jpg": "image/jpeg",
}


def _asset_urls(a: Asset) -> tuple[str | None, str | None]:
    """Return (thumbnail_url, preview_url) for an asset.

    `preview_url` serves the original source file for SVG/PNG/JPG (sharp at
    any zoom); PDFs fall back to the thumbnail."""
    thumb = None
    if a.thumbnail_r2_key:
        try:
            thumb = storage.presigned_get(a.thumbnail_r2_key, expires_in=3600)
        except Exception:
            thumb = None
    preview = thumb
    ct = _PREVIEW_CONTENT_TYPES.get(a.kind)
    if ct and a.r2_key_original:
        try:
            preview = storage.presigned_get(
                a.r2_key_original,
                expires_in=3600,
                content_type=ct,
            )
        except Exception:
            pass
    return thumb, preview


def _content_type_for_original(kind: str, fallback: str | None) -> str:
    if kind == "svg":
        return "image/svg+xml"
    if kind == "png":
        return "image/png"
    if kind == "jpg":
        return "image/jpeg"
    if kind == "pdf":
        return "application/pdf"
    return fallback or "application/octet-stream"


def _own_category(db: Session, user: User, cat_id: uuid.UUID) -> AssetCategory:
    """Returns a category the calling user OWNS (i.e. created themselves).
    Used for write operations - subscribers can't mutate officials."""
    cat = db.query(AssetCategory).filter(
        AssetCategory.id == cat_id, AssetCategory.user_id == user.id
    ).one_or_none()
    if cat is None:
        raise HTTPException(404, "Category not found")
    return cat


def _accessible_category(db: Session, user: User, cat_id: uuid.UUID) -> AssetCategory:
    """Returns a category the user can READ: either their own, or an official
    catalogue they're subscribed to. Admins can read every official, even
    without an explicit subscription."""
    cat = db.query(AssetCategory).filter(AssetCategory.id == cat_id).one_or_none()
    if cat is None:
        raise HTTPException(404, "Category not found")
    if cat.user_id == user.id:
        return cat
    if cat.is_official:
        if is_admin_email(user.email):
            return cat
        sub = (
            db.query(CatalogueSubscription)
            .filter(
                CatalogueSubscription.user_id == user.id,
                CatalogueSubscription.category_id == cat.id,
            )
            .one_or_none()
        )
        if sub is not None:
            return cat
    raise HTTPException(404, "Category not found")


def _category_to_out(
    cat: AssetCategory,
    *,
    subscribed: bool = False,
    asset_count: int | None = None,
) -> CategoryOut:
    return CategoryOut(
        id=cat.id,
        name=cat.name,
        created_at=cat.created_at,
        is_official=cat.is_official,
        subscribed=subscribed,
        asset_count=asset_count,
    )


# ---------- categories ----------


@router.get("/categories", response_model=list[CategoryOut])
def list_categories(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[CategoryOut]:
    """Categories visible to the user: their own + any official catalogues
    they've subscribed to. Officials are tagged so the UI can render them
    read-only."""
    user = _resolve_user(db, auth)

    own = (
        db.query(AssetCategory)
        .filter(AssetCategory.user_id == user.id)
        .order_by(AssetCategory.name)
        .all()
    )

    sub_rows = (
        db.query(AssetCategory)
        .join(CatalogueSubscription, CatalogueSubscription.category_id == AssetCategory.id)
        .filter(
            CatalogueSubscription.user_id == user.id,
            AssetCategory.is_official.is_(True),
        )
        .order_by(AssetCategory.name)
        .all()
    )

    out = [_category_to_out(c) for c in own]
    out.extend(_category_to_out(c, subscribed=True) for c in sub_rows)
    return out


@router.post("/categories", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
def create_category(
    payload: CategoryCreate,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CategoryOut:
    user = _resolve_user(db, auth)

    ent = entitlements.for_user(user)
    if not ent.allows("catalogue"):
        raise HTTPException(
            402,
            detail={
                "code": "plan_locked",
                "message": "Your trial has ended. Reactivate your account to manage the catalogue.",
            },
        )
    current = (
        db.query(func.count(AssetCategory.id))
        .filter(AssetCategory.user_id == user.id)
        .scalar()
        or 0
    )
    if not ent.under_quota("categories_max", current):
        cap = ent.quota("categories_max")
        raise HTTPException(
            402,
            detail={
                "code": "quota_exceeded",
                "limit": "categories_max",
                "cap": cap,
                "message": (
                    f"You've reached your {cap}-category limit. "
                    "Upgrade to Pro for unlimited categories."
                ),
            },
        )

    cat = AssetCategory(user_id=user.id, name=payload.name.strip())
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return _category_to_out(cat)


@router.delete("/categories/{cat_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_category(
    cat_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    user = _resolve_user(db, auth)
    cat = _own_category(db, user, cat_id)
    assets = db.query(Asset).filter(Asset.category_id == cat.id).all()
    for a in assets:
        for k in (a.r2_key, a.r2_key_original, a.thumbnail_r2_key):
            if k:
                try:
                    storage.delete(k)
                except Exception:
                    pass
    db.delete(cat)
    db.commit()


@router.get("/categories/{cat_id}/assets", response_model=list[AssetOut])
def list_assets(
    cat_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AssetOut]:
    user = _resolve_user(db, auth)
    cat = _accessible_category(db, user, cat_id)
    rows = (
        db.query(Asset)
        .filter(Asset.category_id == cat.id, Asset.job_id.is_(None))
        .order_by(Asset.created_at.desc())
        .all()
    )
    out: list[AssetOut] = []
    for r in rows:
        thumb_url, preview_url = _asset_urls(r)
        out.append(
            AssetOut(
                id=r.id,
                category_id=r.category_id,
                job_id=r.job_id,
                name=r.name,
                kind=r.kind,
                width_pt=r.width_pt,
                height_pt=r.height_pt,
                file_size=r.file_size,
                thumbnail_url=thumb_url,
                preview_url=preview_url,
                created_at=r.created_at,
                is_official=r.is_official,
            )
        )
    return out


# ---------- assets ----------


@router.post("/assets", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
async def upload_asset(
    category_id: uuid.UUID = Form(...),
    file: UploadFile = File(...),
    name: str | None = Form(None),
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AssetOut:
    user = _resolve_user(db, auth)
    cat = _own_category(db, user, category_id)

    ent = entitlements.for_user(user)
    if not ent.allows("catalogue"):
        raise HTTPException(
            402,
            detail={
                "code": "plan_locked",
                "message": "Your trial has ended. Reactivate your account to upload artwork.",
            },
        )

    body = await file.read()
    if not body:
        raise HTTPException(400, "Empty upload")

    # Per-file ceiling — tier-specific. Trial gets Pro's 100 MB limit; a
    # locked / expired account is 0 (they're stopped above by `allows`).
    size_mb = len(body) / (1024 * 1024)
    cap_mb = ent.quota("asset_size_mb_max")
    if cap_mb is not None and size_mb > cap_mb:
        raise HTTPException(
            402,
            detail={
                "code": "quota_exceeded",
                "limit": "asset_size_mb_max",
                "cap": cap_mb,
                "message": (
                    f"File is {size_mb:.1f} MB, which exceeds your {cap_mb} MB "
                    "per-asset limit. Upgrade to upload larger files."
                ),
            },
        )

    # Total-storage ceiling — sum of every existing asset (catalogue +
    # job uploads). Generated outputs are intentionally excluded so users
    # aren't penalised for re-running fills.
    storage_cap_mb = ent.quota("storage_mb_max")
    if storage_usage.would_exceed_cap(db, user.id, len(body), storage_cap_mb):
        used_mb = storage_usage.current_storage_mb(db, user.id)
        raise HTTPException(
            402,
            detail={
                "code": "quota_exceeded",
                "limit": "storage_mb_max",
                "cap": storage_cap_mb,
                "message": (
                    f"This upload would push you over your {storage_cap_mb} MB "
                    f"storage cap (currently using {used_mb:.0f} MB). "
                    "Delete unused artwork or upgrade for more space."
                ),
            },
        )

    try:
        norm = asset_pipeline.normalise(body, file.filename or "asset", file.content_type)
    except ValueError as exc:
        raise HTTPException(415, str(exc))
    except RuntimeError as exc:
        raise HTTPException(503, str(exc))

    asset_id = uuid.uuid4()
    base = f"users/{user.id}/assets/{asset_id}"
    key_pdf = f"{base}/normalised.pdf"
    key_thumb = f"{base}/thumb.jpg"
    key_orig = f"{base}/original.{norm.kind}" if norm.original_kept else None

    try:
        storage.put_bytes(key_pdf, norm.pdf_bytes, content_type="application/pdf")
        if norm.thumbnail_jpg:
            storage.put_bytes(key_thumb, norm.thumbnail_jpg, content_type="image/jpeg")
        if key_orig:
            storage.put_bytes(
                key_orig,
                norm.original_bytes if norm.original_bytes is not None else body,
                content_type=_content_type_for_original(norm.kind, file.content_type),
            )
    except storage.StorageNotConfigured as exc:
        raise HTTPException(503, str(exc))

    asset = Asset(
        id=asset_id,
        user_id=user.id,
        category_id=cat.id,
        name=name or file.filename or "Untitled",
        kind=norm.kind,
        r2_key=key_pdf,
        r2_key_original=key_orig,
        thumbnail_r2_key=key_thumb if norm.thumbnail_jpg else None,
        width_pt=norm.width_pt,
        height_pt=norm.height_pt,
        file_size=len(norm.pdf_bytes),
        is_official=cat.is_official,
    )
    db.add(asset)
    db.commit()
    db.refresh(asset)

    thumb_url, preview_url = _asset_urls(asset)

    return AssetOut(
        id=asset.id,
        category_id=asset.category_id,
        job_id=asset.job_id,
        name=asset.name,
        kind=asset.kind,
        width_pt=asset.width_pt,
        height_pt=asset.height_pt,
        file_size=asset.file_size,
        thumbnail_url=thumb_url,
        preview_url=preview_url,
        created_at=asset.created_at,
        is_official=asset.is_official,
    )


@router.delete("/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_asset(
    asset_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    user = _resolve_user(db, auth)
    asset = db.query(Asset).filter(
        Asset.id == asset_id, Asset.user_id == user.id
    ).one_or_none()
    if asset is None:
        raise HTTPException(404, "Asset not found")
    for k in (asset.r2_key, asset.r2_key_original, asset.thumbnail_r2_key):
        if k:
            try:
                storage.delete(k)
            except Exception:
                pass
    db.delete(asset)
    db.commit()


# ---------- bundles (export / import) ----------


@router.get("/categories/{cat_id}/export")
def export_category(
    cat_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    user = _resolve_user(db, auth)
    cat = _accessible_category(db, user, cat_id)
    assets = (
        db.query(Asset)
        .filter(Asset.category_id == cat.id)
        .order_by(Asset.created_at)
        .all()
    )

    def load_pdf(a: Asset) -> bytes:
        return storage.get_bytes(a.r2_key)

    def load_thumb(a: Asset) -> bytes | None:
        if not a.thumbnail_r2_key:
            return None
        return storage.get_bytes(a.thumbnail_r2_key)

    bundle = catalogue_bundle.export_bundle(cat.name, assets, load_pdf, load_thumb)
    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in cat.name).strip("_") or "category"
    record(
        db, user, "category.export",
        target_type="category", target_id=cat.id,
        payload={"asset_count": len(assets), "bytes": len(bundle)},
    )
    return Response(
        content=bundle,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="printlay-{safe_name}.printlay.zip"',
        },
    )


@router.post("/categories/import", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
async def import_category(
    file: UploadFile = File(...),
    target_category_id: uuid.UUID | None = Form(None),
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CategoryOut:
    user = _resolve_user(db, auth)

    ent = entitlements.for_user(user)
    if not ent.allows("catalogue"):
        raise HTTPException(
            402,
            detail={
                "code": "plan_locked",
                "message": "Your trial has ended. Reactivate your account to import bundles.",
            },
        )

    body = await file.read()
    if not body:
        raise HTTPException(400, "Empty upload")
    if len(body) > MAX_BUNDLE_BYTES:
        raise HTTPException(
            413,
            f"Bundle too large ({MAX_BUNDLE_BYTES // (1024 * 1024)} MB max)",
        )
    try:
        parsed = catalogue_bundle.parse_bundle(body)
    except Exception as exc:
        raise HTTPException(400, f"Invalid bundle: {exc}")

    # An import is N uploads in one POST — check the total against the
    # storage cap before we do the writes (cheaper than rolling back R2
    # objects mid-loop).
    storage_cap_mb = ent.quota("storage_mb_max")
    if storage_cap_mb is not None:
        incoming = sum(
            getattr(ba, "file_size", 0) or len(ba.pdf_bytes or b"")
            for ba in parsed.assets
        )
        if storage_usage.would_exceed_cap(db, user.id, incoming, storage_cap_mb):
            used_mb = storage_usage.current_storage_mb(db, user.id)
            raise HTTPException(
                402,
                detail={
                    "code": "quota_exceeded",
                    "limit": "storage_mb_max",
                    "cap": storage_cap_mb,
                    "message": (
                        f"Importing this bundle would push you over your "
                        f"{storage_cap_mb} MB storage cap (currently using "
                        f"{used_mb:.0f} MB). Free up space or upgrade."
                    ),
                },
            )

    if target_category_id is not None:
        cat = _own_category(db, user, target_category_id)
    else:
        cat = AssetCategory(user_id=user.id, name=parsed.category_name)
        db.add(cat)
        db.flush()

    imported = 0
    for ba in parsed.assets:
        new_id = catalogue_bundle.fresh_asset_id()
        base = f"users/{user.id}/assets/{new_id}"
        key_pdf = f"{base}/normalised.pdf"
        key_thumb = f"{base}/thumb.jpg"
        try:
            storage.put_bytes(key_pdf, ba.pdf_bytes, content_type="application/pdf")
            if ba.thumbnail_jpg:
                storage.put_bytes(key_thumb, ba.thumbnail_jpg, content_type="image/jpeg")
        except storage.StorageNotConfigured as exc:
            raise HTTPException(503, str(exc))

        asset = Asset(
            id=new_id,
            user_id=user.id,
            category_id=cat.id,
            name=ba.name,
            kind=ba.kind,
            r2_key=key_pdf,
            r2_key_original=None,
            thumbnail_r2_key=key_thumb if ba.thumbnail_jpg else None,
            width_pt=ba.width_pt,
            height_pt=ba.height_pt,
            file_size=ba.file_size,
            is_official=cat.is_official,
        )
        db.add(asset)
        imported += 1

    db.commit()
    db.refresh(cat)
    record(
        db, user, "category.import",
        target_type="category", target_id=cat.id,
        payload={"asset_count": imported, "bytes": len(body)},
    )
    return _category_to_out(cat)


# ---------- official catalogues (browse + opt-in) ----------


@router.get("/catalogues/official", response_model=list[CategoryOut])
def list_official_catalogues(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[CategoryOut]:
    """Browse panel feed. Returns every official catalogue, with `subscribed`
    pre-computed for the calling user and an `asset_count` so the UI can
    show "Playing cards · 52 assets" without a second request."""
    user = _resolve_user(db, auth)

    cats = (
        db.query(AssetCategory)
        .filter(AssetCategory.is_official.is_(True))
        .order_by(AssetCategory.name)
        .all()
    )
    if not cats:
        return []

    cat_ids = [c.id for c in cats]
    sub_ids: set[uuid.UUID] = set(
        cid for (cid,) in db.query(CatalogueSubscription.category_id).filter(
            CatalogueSubscription.user_id == user.id,
            CatalogueSubscription.category_id.in_(cat_ids),
        )
    )
    from sqlalchemy import func as _f

    counts = dict(
        db.query(Asset.category_id, _f.count(Asset.id))
        .filter(Asset.category_id.in_(cat_ids), Asset.job_id.is_(None))
        .group_by(Asset.category_id)
        .all()
    )

    return [
        _category_to_out(
            c,
            subscribed=c.id in sub_ids,
            asset_count=int(counts.get(c.id, 0)),
        )
        for c in cats
    ]


@router.post("/catalogues/{cat_id}/subscribe", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
def subscribe(
    cat_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CategoryOut:
    user = _resolve_user(db, auth)
    cat = db.query(AssetCategory).filter(AssetCategory.id == cat_id).one_or_none()
    if cat is None or not cat.is_official:
        raise HTTPException(404, "Official catalogue not found")

    existing = (
        db.query(CatalogueSubscription)
        .filter(
            CatalogueSubscription.user_id == user.id,
            CatalogueSubscription.category_id == cat.id,
        )
        .one_or_none()
    )
    if existing is None:
        sub = CatalogueSubscription(user_id=user.id, category_id=cat.id)
        db.add(sub)
        db.commit()
        record(
            db, user, "catalogue.subscribed",
            target_type="category", target_id=cat.id,
            payload={"name": cat.name},
        )
    return _category_to_out(cat, subscribed=True)


@router.delete("/catalogues/{cat_id}/subscribe", status_code=status.HTTP_204_NO_CONTENT)
def unsubscribe(
    cat_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    user = _resolve_user(db, auth)
    sub = (
        db.query(CatalogueSubscription)
        .filter(
            CatalogueSubscription.user_id == user.id,
            CatalogueSubscription.category_id == cat_id,
        )
        .one_or_none()
    )
    if sub is None:
        return
    db.delete(sub)
    db.commit()
    record(
        db, user, "catalogue.unsubscribed",
        target_type="category", target_id=cat_id,
    )


# ---------- admin: mark official + push subscriptions ----------


@router.patch("/admin/catalogues/{cat_id}", response_model=CategoryOut)
def admin_set_official(
    cat_id: uuid.UUID,
    is_official: bool,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> CategoryOut:
    """Flip the official flag on one of the admin's own categories. Also
    cascades the flag to the contained assets (denormalised mirror)."""
    cat = db.query(AssetCategory).filter(
        AssetCategory.id == cat_id, AssetCategory.user_id == admin.id
    ).one_or_none()
    if cat is None:
        raise HTTPException(
            404,
            "Category not found (must be one you own)",
        )
    cat.is_official = is_official
    db.query(Asset).filter(Asset.category_id == cat.id).update(
        {Asset.is_official: is_official}, synchronize_session=False
    )
    db.commit()
    db.refresh(cat)
    record(
        db, admin, "catalogue.is_official",
        target_type="category", target_id=cat.id,
        payload={"is_official": is_official},
    )
    return _category_to_out(cat, subscribed=False)


@router.post("/admin/catalogues/{cat_id}/assign", status_code=status.HTTP_204_NO_CONTENT)
def admin_assign_subscriber(
    cat_id: uuid.UUID,
    user_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    """Force-subscribe a specific user to an official catalogue. Useful for
    onboarding (e.g. a wholesale magic-supply customer who needs the
    Playing Cards pack)."""
    cat = db.query(AssetCategory).filter(AssetCategory.id == cat_id).one_or_none()
    if cat is None or not cat.is_official:
        raise HTTPException(404, "Official catalogue not found")
    target = db.query(User).filter(User.id == user_id).one_or_none()
    if target is None:
        raise HTTPException(404, "User not found")
    existing = (
        db.query(CatalogueSubscription)
        .filter(
            CatalogueSubscription.user_id == target.id,
            CatalogueSubscription.category_id == cat.id,
        )
        .one_or_none()
    )
    if existing is None:
        db.add(CatalogueSubscription(user_id=target.id, category_id=cat.id))
        db.commit()
        record(
            db, admin, "catalogue.assigned",
            target_type="category", target_id=cat.id,
            payload={"target_user_id": str(target.id)},
        )


@router.delete("/admin/catalogues/{cat_id}/assign", status_code=status.HTTP_204_NO_CONTENT)
def admin_unassign_subscriber(
    cat_id: uuid.UUID,
    user_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    sub = (
        db.query(CatalogueSubscription)
        .filter(
            CatalogueSubscription.user_id == user_id,
            CatalogueSubscription.category_id == cat_id,
        )
        .one_or_none()
    )
    if sub is None:
        return
    db.delete(sub)
    db.commit()
    record(
        db, admin, "catalogue.unassigned",
        target_type="category", target_id=cat_id,
        payload={"target_user_id": str(user_id)},
    )
