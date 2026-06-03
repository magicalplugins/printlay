from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
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


def _asset_cut_contour(a: Asset) -> list[list[float]] | None:
    """Parse the stored sticker cut-line contour (normalised points) if any."""
    raw = getattr(a, "cut_contour_json", None)
    if not raw:
        return None
    try:
        import json

        pts = json.loads(raw)
        if isinstance(pts, list) and len(pts) >= 3:
            return [[float(p[0]), float(p[1])] for p in pts]
    except Exception:
        return None
    return None


def _asset_urls(a: Asset) -> tuple[str | None, str | None]:
    """Return (thumbnail_url, preview_url) for an asset.

    `preview_url` falls back to the thumbnail unless we have a true
    vector source (SVG) we can serve sharp."""
    thumb = None
    if a.thumbnail_r2_key:
        try:
            thumb = storage.presigned_get(a.thumbnail_r2_key, expires_in=3600)
        except Exception:
            thumb = None
    preview = thumb
    if a.kind == "svg" and a.r2_key_original:
        try:
            preview = storage.presigned_get(
                a.r2_key_original,
                expires_in=3600,
                content_type="image/svg+xml",
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
    """Returns a category the user can READ: either their own, or an official/
    private-share catalogue they're subscribed to. Admins can read any
    shareable catalogue even without an explicit subscription."""
    cat = db.query(AssetCategory).filter(AssetCategory.id == cat_id).one_or_none()
    if cat is None:
        raise HTTPException(404, "Category not found")
    if cat.user_id == user.id:
        return cat
    if cat.is_official or cat.is_private_share:
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
        is_private_share=cat.is_private_share,
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
            or_(
                AssetCategory.is_official.is_(True),
                AssetCategory.is_private_share.is_(True),
            ),
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


@router.patch("/categories/{cat_id}", response_model=CategoryOut)
def rename_category(
    cat_id: uuid.UUID,
    payload: CategoryCreate,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CategoryOut:
    user = _resolve_user(db, auth)
    cat = _own_category(db, user, cat_id)
    cat.name = payload.name.strip()
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
                page_count=max(1, int(getattr(r, "page_count", 1) or 1)),
                cut_contour=_asset_cut_contour(r),
                is_sticker_editable=bool(getattr(r, "sticker_session_prefix", None)),
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
        page_count=norm.page_count,
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
        page_count=max(1, int(getattr(asset, "page_count", 1) or 1)),
        cut_contour=_asset_cut_contour(asset),
        is_sticker_editable=bool(getattr(asset, "sticker_session_prefix", None)),
    )


class PageThumbnailOut(BaseModel):
    """URL to a rendered preview of a single PDF page/artboard."""

    url: str
    page_index: int
    page_count: int


@router.get(
    "/assets/{asset_id}/pages/{page_index}/thumbnail",
    response_model=PageThumbnailOut,
)
def get_asset_page_thumbnail(
    asset_id: uuid.UUID,
    page_index: int,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PageThumbnailOut:
    """Return a presigned URL for a single page of a multi-page asset.

    Thumbnails are generated on demand on the first request and cached
    in R2 (`<r2_key>_thumb_p<n>.jpg`) so subsequent loads are instant.
    Owner-only access — official catalogue assets the user has
    subscribed to are also allowed."""
    user = _resolve_user(db, auth)
    asset = db.query(Asset).filter(Asset.id == asset_id).one_or_none()
    if asset is None:
        raise HTTPException(404, "Asset not found")

    if asset.user_id != user.id and not asset.is_official:
        raise HTTPException(404, "Asset not found")
    if asset.is_official and asset.user_id != user.id:
        # Check subscription to the parent catalogue
        sub = (
            db.query(CatalogueSubscription)
            .filter(
                CatalogueSubscription.user_id == user.id,
                CatalogueSubscription.category_id == asset.category_id,
            )
            .one_or_none()
        )
        if sub is None:
            raise HTTPException(404, "Asset not found")

    if asset.kind != "pdf":
        # Non-PDF assets are single-page by definition; redirect to
        # the existing thumbnail.
        if not asset.thumbnail_r2_key:
            raise HTTPException(404, "No thumbnail available")
        return PageThumbnailOut(
            url=storage.presigned_get(asset.thumbnail_r2_key, expires_in=3600),
            page_index=0,
            page_count=1,
        )

    pc = max(1, int(asset.page_count or 1))
    if page_index < 0 or page_index >= pc:
        raise HTTPException(400, f"page_index out of range (0..{pc - 1})")

    # Page 0 reuses the existing primary thumbnail.
    if page_index == 0 and asset.thumbnail_r2_key:
        return PageThumbnailOut(
            url=storage.presigned_get(asset.thumbnail_r2_key, expires_in=3600),
            page_index=0,
            page_count=pc,
        )

    # Cache key sits next to the asset PDF so cleanup follows naturally.
    thumb_key = f"{asset.r2_key}.thumb_p{page_index}.jpg"
    if storage.exists(thumb_key):
        return PageThumbnailOut(
            url=storage.presigned_get(thumb_key, expires_in=3600),
            page_index=page_index,
            page_count=pc,
        )

    try:
        pdf_bytes = storage.get_bytes(asset.r2_key)
    except Exception as exc:
        raise HTTPException(503, f"Could not read source PDF: {exc}") from exc

    import io
    import pymupdf  # type: ignore[import-untyped]
    from PIL import Image

    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        if page_index >= doc.page_count:
            raise HTTPException(400, "page_index out of range")
        page = doc[page_index]
        scale = asset_pipeline.THUMBNAIL_MAX_PX / max(
            page.rect.width, page.rect.height
        )
        pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
        png = pix.tobytes("png")
    finally:
        doc.close()
    img = Image.open(io.BytesIO(png)).convert("RGB")
    img.thumbnail(
        (asset_pipeline.THUMBNAIL_MAX_PX, asset_pipeline.THUMBNAIL_MAX_PX)
    )
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=80, optimize=True)
    storage.put_bytes(thumb_key, out.getvalue(), "image/jpeg")

    return PageThumbnailOut(
        url=storage.presigned_get(thumb_key, expires_in=3600),
        page_index=page_index,
        page_count=pc,
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
    # Per-page thumbnails (lazy-generated for multi-page PDFs)
    for n in range(1, int(asset.page_count or 1)):
        try:
            storage.delete(f"{asset.r2_key}.thumb_p{n}.jpg")
        except Exception:
            pass
    db.delete(asset)
    db.commit()


class BulkDeleteIn(BaseModel):
    """Body for bulk asset deletion. Capped at 500 ids per call so a
    runaway client can't keep one DB connection busy for minutes."""

    asset_ids: list[uuid.UUID] = Field(
        ..., min_length=1, max_length=500,
        description="Asset UUIDs to delete. Only the caller's own assets are touched.",
    )


class BulkDeleteOut(BaseModel):
    deleted: int
    skipped: int
    """Ids that resolved to assets the caller doesn't own (or didn't
    exist). Not an error — silently ignored so a stale client cache
    doesn't 500."""


class BulkThumbnailIn(BaseModel):
    asset_ids: list[str] = Field(max_length=500)


@router.post("/assets/bulk-thumbnails")
def bulk_thumbnails(
    payload: BulkThumbnailIn,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, str | None]:
    """Return a map of asset_id → thumbnail_url for a batch of IDs.
    Returns URLs for assets the user owns or has access to via subscriptions."""
    from backend.routers.templates import _resolve_user as resolve
    user = resolve(db, auth)
    if not payload.asset_ids:
        return {}
    uuids = []
    for aid in payload.asset_ids:
        try:
            uuids.append(uuid.UUID(aid))
        except ValueError:
            continue

    subscribed_cat_ids = {
        row[0] for row in
        db.query(CatalogueSubscription.category_id)
        .filter(CatalogueSubscription.user_id == user.id)
        .all()
    }

    rows = (
        db.query(Asset)
        .filter(Asset.id.in_(uuids))
        .all()
    )
    result: dict[str, str | None] = {}
    for a in rows:
        if a.user_id == user.id:
            pass
        elif a.category_id in subscribed_cat_ids:
            cat = db.query(AssetCategory).filter(AssetCategory.id == a.category_id).first()
            if not (cat and (cat.is_official or cat.is_private_share)):
                continue
        else:
            continue
        thumb, _ = _asset_urls(a)
        result[str(a.id)] = thumb
    return result
    result: dict[str, str | None] = {}
    for a in rows:
        thumb, _ = _asset_urls(a)
        result[str(a.id)] = thumb
    return result


@router.post(
    "/assets/bulk-delete",
    response_model=BulkDeleteOut,
    status_code=status.HTTP_200_OK,
)
def bulk_delete_assets(
    payload: BulkDeleteIn,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> BulkDeleteOut:
    """Delete many assets in one round-trip.

    We resolve ownership in a single query (much cheaper than N round
    trips through `DELETE /assets/{id}`), then iterate to clean up R2
    keys. Storage deletes are best-effort — a failed object purge
    shouldn't block the row delete because the user clearly wanted
    the asset gone, and orphaned R2 objects can be GC'd later.

    A subscriber pointing this at an official catalogue gets a 403:
    they can unsubscribe (which strips the whole catalogue from their
    library) but they can't mutate the catalogue's contents."""
    user = _resolve_user(db, auth)
    ids = list({i for i in payload.asset_ids})  # dedupe defensively
    if not ids:
        return BulkDeleteOut(deleted=0, skipped=0)

    assets = (
        db.query(Asset)
        .filter(Asset.id.in_(ids), Asset.user_id == user.id)
        .all()
    )

    # Refuse to mutate official-catalogue contents. The whole batch is
    # rejected so the client gets a single clear error rather than
    # silently dropping some of the selection — the read-only badge in
    # the UI already prevents reaching this code path in practice.
    if any(a.is_official for a in assets):
        raise HTTPException(
            403,
            "One or more assets belong to an official catalogue and can't be deleted here. Unsubscribe from the catalogue to remove them.",
        )

    for asset in assets:
        for k in (asset.r2_key, asset.r2_key_original, asset.thumbnail_r2_key):
            if k:
                try:
                    storage.delete(k)
                except Exception:
                    pass
        db.delete(asset)
    db.commit()

    deleted = len(assets)
    record(
        db, user, "asset.bulk_delete",
        target_type="asset",
        payload={"count": deleted, "requested": len(ids)},
    )
    return BulkDeleteOut(deleted=deleted, skipped=len(ids) - deleted)


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


@router.patch("/admin/catalogues/{cat_id}/private-share")
def admin_set_private_share(
    cat_id: uuid.UUID,
    is_private_share: bool,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> CategoryOut:
    """Toggle private-share on a category. Private-share catalogues don't
    appear in the public browse list but can be assigned to specific users."""
    cat = db.query(AssetCategory).filter(
        AssetCategory.id == cat_id, AssetCategory.user_id == admin.id
    ).one_or_none()
    if cat is None:
        raise HTTPException(404, "Category not found (must be one you own)")
    cat.is_private_share = is_private_share
    db.commit()
    db.refresh(cat)
    record(
        db, admin, "catalogue.is_private_share",
        target_type="category", target_id=cat.id,
        payload={"is_private_share": is_private_share},
    )
    return _category_to_out(cat, subscribed=False)


@router.post("/admin/catalogues/{cat_id}/assign", status_code=status.HTTP_204_NO_CONTENT)
def admin_assign_subscriber(
    cat_id: uuid.UUID,
    user_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    """Force-subscribe a specific user to an official or private-share catalogue."""
    cat = db.query(AssetCategory).filter(AssetCategory.id == cat_id).one_or_none()
    if cat is None or not (cat.is_official or cat.is_private_share):
        raise HTTPException(404, "Shareable catalogue not found")
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


@router.get("/admin/catalogues/{cat_id}/subscribers")
def admin_list_subscribers(
    cat_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[dict]:
    """List users currently subscribed/assigned to a shareable catalogue."""
    cat = db.query(AssetCategory).filter(AssetCategory.id == cat_id).one_or_none()
    if cat is None or not (cat.is_official or cat.is_private_share):
        raise HTTPException(404, "Shareable catalogue not found")
    subs = (
        db.query(CatalogueSubscription)
        .filter(CatalogueSubscription.category_id == cat_id)
        .all()
    )
    user_ids = [s.user_id for s in subs]
    if not user_ids:
        return []
    users = db.query(User).filter(User.id.in_(user_ids)).all()
    return [
        {"id": str(u.id), "email": u.email, "display_name": u.display_name}
        for u in users
    ]
def refresh_all_thumbnails(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Regenerate thumbnails and refresh stored dimensions for every PDF asset.
    Useful after a pymupdf upgrade that changes how page rotation / mediabox
    are resolved. Does NOT modify the stored PDF bytes -- only the thumbnail
    and the cached width_pt/height_pt in the DB."""
    assets = db.query(Asset).filter(Asset.r2_key.isnot(None), Asset.kind == "pdf").all()
    refreshed, errors = 0, []
    for a in assets:
        try:
            pdf_bytes = storage.get_bytes(a.r2_key)
            new_thumb = asset_pipeline._thumbnail_from_pdf(pdf_bytes)
            if a.thumbnail_r2_key:
                storage.put_bytes(a.thumbnail_r2_key, new_thumb, content_type="image/jpeg")
            w, h = asset_pipeline._pdf_dimensions(pdf_bytes)
            a.width_pt = w
            a.height_pt = h
            refreshed += 1
        except Exception as exc:
            errors.append({"asset_id": str(a.id), "name": a.name, "error": str(exc)})
    db.commit()
    return {"refreshed": refreshed, "errors": errors}


@router.post("/admin/categories/{cat_id}/rotate-assets", status_code=status.HTTP_200_OK)
def rotate_category_assets(
    cat_id: uuid.UUID,
    degrees: int = 90,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Rotate every asset PDF in a category by `degrees` (90, 180, or 270).

    Uses a metadata-only /Rotate operation — no content stream is touched, so
    vector paths, colours, and embedded images are fully preserved.
    Updates width_pt / height_pt in the DB and regenerates thumbnails.
    """
    import pymupdf  # type: ignore[import-untyped]

    if degrees not in (90, 180, 270):
        raise HTTPException(400, "degrees must be 90, 180, or 270")

    cat = db.query(AssetCategory).filter(AssetCategory.id == cat_id).one_or_none()
    if cat is None:
        raise HTTPException(404, "Category not found")

    assets = db.query(Asset).filter(Asset.category_id == cat_id).all()
    rotated, skipped, errors = 0, 0, []

    for a in assets:
        if not a.r2_key:
            skipped += 1
            continue
        try:
            pdf_bytes = storage.get_bytes(a.r2_key)
            doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
            for page in doc:
                page.set_rotation((page.rotation + degrees) % 360)
            new_pdf = doc.tobytes(deflate=True, garbage=1)
            doc.close()

            # Re-upload the rotated PDF (overwrite same key)
            storage.put_bytes(a.r2_key, new_pdf, content_type="application/pdf")

            # Regenerate thumbnail
            new_thumb = asset_pipeline._thumbnail_from_pdf(new_pdf)
            if a.thumbnail_r2_key:
                storage.put_bytes(a.thumbnail_r2_key, new_thumb, content_type="image/jpeg")

            # Read the DISPLAYED dimensions from the rotated PDF (page.rect
            # accounts for /Rotate) rather than swapping DB values, which
            # can drift if the DB was stale.
            check = pymupdf.open(stream=new_pdf, filetype="pdf")
            rp = check[0]
            a.width_pt = float(rp.rect.width)
            a.height_pt = float(rp.rect.height)
            check.close()

            rotated += 1
        except Exception as exc:
            errors.append({"asset_id": str(a.id), "name": a.name, "error": str(exc)})

    db.commit()
    return {
        "category": cat.name,
        "degrees": degrees,
        "rotated": rotated,
        "skipped": skipped,
        "errors": errors,
    }

