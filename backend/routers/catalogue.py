from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response
from sqlalchemy.orm import Session

from backend.audit import record
from backend.auth import AuthenticatedUser, get_current_user
from backend.database import get_db
from backend.models import Asset, AssetCategory, User
from backend.routers.templates import _resolve_user
from backend.schemas.asset import AssetOut, CategoryCreate, CategoryOut
from backend.services import asset_pipeline, catalogue_bundle, storage

router = APIRouter(prefix="/api", tags=["catalogue"])

MAX_ASSET_BYTES = 50 * 1024 * 1024


def _own_category(db: Session, user: User, cat_id: uuid.UUID) -> AssetCategory:
    cat = db.query(AssetCategory).filter(
        AssetCategory.id == cat_id, AssetCategory.user_id == user.id
    ).one_or_none()
    if cat is None:
        raise HTTPException(404, "Category not found")
    return cat


@router.get("/categories", response_model=list[CategoryOut])
def list_categories(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AssetCategory]:
    user = _resolve_user(db, auth)
    return (
        db.query(AssetCategory)
        .filter(AssetCategory.user_id == user.id)
        .order_by(AssetCategory.name)
        .all()
    )


@router.post("/categories", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
def create_category(
    payload: CategoryCreate,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AssetCategory:
    user = _resolve_user(db, auth)
    cat = AssetCategory(user_id=user.id, name=payload.name.strip())
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return cat


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
    cat = _own_category(db, user, cat_id)
    rows = (
        db.query(Asset)
        .filter(Asset.category_id == cat.id)
        .order_by(Asset.created_at.desc())
        .all()
    )
    out: list[AssetOut] = []
    for r in rows:
        thumb_url = None
        if r.thumbnail_r2_key:
            try:
                thumb_url = storage.presigned_get(r.thumbnail_r2_key, expires_in=3600)
            except Exception:
                thumb_url = None
        out.append(
            AssetOut(
                id=r.id,
                category_id=r.category_id,
                name=r.name,
                kind=r.kind,
                width_pt=r.width_pt,
                height_pt=r.height_pt,
                file_size=r.file_size,
                thumbnail_url=thumb_url,
                created_at=r.created_at,
            )
        )
    return out


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

    body = await file.read()
    if not body:
        raise HTTPException(400, "Empty upload")
    if len(body) > MAX_ASSET_BYTES:
        raise HTTPException(413, "File too large")

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
            storage.put_bytes(key_orig, body, content_type=file.content_type or "application/octet-stream")
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
    )
    db.add(asset)
    db.commit()
    db.refresh(asset)

    thumb_url = None
    if asset.thumbnail_r2_key:
        try:
            thumb_url = storage.presigned_get(asset.thumbnail_r2_key, expires_in=3600)
        except Exception:
            thumb_url = None

    return AssetOut(
        id=asset.id,
        category_id=asset.category_id,
        name=asset.name,
        kind=asset.kind,
        width_pt=asset.width_pt,
        height_pt=asset.height_pt,
        file_size=asset.file_size,
        thumbnail_url=thumb_url,
        created_at=asset.created_at,
    )


@router.get("/categories/{cat_id}/export")
def export_category(
    cat_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    user = _resolve_user(db, auth)
    cat = _own_category(db, user, cat_id)
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
) -> AssetCategory:
    user = _resolve_user(db, auth)
    body = await file.read()
    if not body:
        raise HTTPException(400, "Empty upload")
    if len(body) > 200 * 1024 * 1024:
        raise HTTPException(413, "Bundle too large (200 MB max)")
    try:
        parsed = catalogue_bundle.parse_bundle(body)
    except Exception as exc:
        raise HTTPException(400, f"Invalid bundle: {exc}")

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
    return cat


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
