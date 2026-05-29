"""Sheet Builder API router.

CRUD for sticker sheets and cutter presets, plus auto-layout and PDF export.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.auth import AuthenticatedUser, get_current_user
from backend.database import get_db
from backend.models import Asset, User
from backend.models.cutter_preset import CutterPreset
from backend.models.sticker_sheet import StickerSheet
from backend.routers.templates import _resolve_user
from backend.services import storage
from backend.services.sheet_compositor import (
    LayoutResult,
    Placement,
    SheetConfig,
    auto_layout,
    compose_pdf,
)

router = APIRouter(prefix="/api/sheets", tags=["sheet-builder"])

# ---------- Pydantic schemas ----------


class CutterPresetIn(BaseModel):
    name: str = Field(max_length=120)
    media_width_mm: float = Field(gt=0)
    registration_type: str | None = None
    max_zone_length_mm: float | None = Field(default=None, gt=0)
    mark_offset_mm: float = Field(default=5.0, ge=0)
    default_gap_mm: float = Field(default=3.0, ge=0)
    default_edge_margin_mm: float = Field(default=5.0, ge=0)
    show_crop_marks: bool = False


class CutterPresetOut(BaseModel):
    id: uuid.UUID
    name: str
    media_width_mm: float
    registration_type: str | None
    max_zone_length_mm: float | None
    mark_offset_mm: float
    default_gap_mm: float
    default_edge_margin_mm: float
    show_crop_marks: bool


class PlacementIn(BaseModel):
    asset_id: uuid.UUID
    x_mm: float
    y_mm: float
    rotation_deg: int = 0
    scale: float = 1.0


class SheetIn(BaseModel):
    name: str = "Untitled"
    media_width_mm: float = Field(gt=0)
    media_height_mm: float = Field(default=0.0, ge=0)
    mode: str = "roll"
    sub_sheet_size: str | None = None
    gap_mm: float = Field(default=3.0, ge=0)
    sub_sheet_gap_mm: float = Field(default=5.0, ge=0)
    sub_sheet_padding_mm: float = Field(default=5.0, ge=0)
    edge_margin_mm: float = Field(default=5.0, ge=0)
    show_crop_marks: bool = True
    registration_type: str | None = None
    max_zone_length_mm: float | None = Field(default=None, gt=0)
    mark_offset_mm: float = Field(default=5.0, ge=0)
    placements: list[PlacementIn] | None = None
    cutter_preset_id: uuid.UUID | None = None
    sub_sheet_fill_color: str | None = None
    sub_sheet_fill_color2: str | None = None
    sub_sheet_gradient_angle: float | None = 135.0
    sub_sheet_title: str | None = None
    sub_sheet_title_font: str | None = "Inter"
    sub_sheet_title_size_mm: float | None = 5.0
    sub_sheet_title_color: str | None = "#000000"
    sub_sheet_title_bold: bool | None = False
    sticker_align_h: str | None = "center"
    sticker_align_v: str | None = "top"
    sub_sheet_bleed_mm: float | None = 0.0


class SheetOut(BaseModel):
    id: uuid.UUID
    name: str
    media_width_mm: float
    media_height_mm: float
    mode: str
    sub_sheet_size: str | None
    gap_mm: float
    sub_sheet_gap_mm: float
    sub_sheet_padding_mm: float
    edge_margin_mm: float
    show_crop_marks: bool
    registration_type: str | None
    max_zone_length_mm: float | None
    mark_offset_mm: float
    placements: list[dict] | None
    cutter_preset_id: uuid.UUID | None
    sub_sheet_fill_color: str | None = None
    sub_sheet_fill_color2: str | None = None
    sub_sheet_gradient_angle: float | None = None
    sub_sheet_bg_url: str | None = None
    sub_sheet_title: str | None = None
    sub_sheet_title_font: str | None = None
    sub_sheet_title_size_mm: float | None = None
    sub_sheet_title_color: str | None = None
    sub_sheet_title_bold: bool | None = None
    sticker_align_h: str | None = None
    sticker_align_v: str | None = None
    sub_sheet_bleed_mm: float | None = None
    output_url: str | None = None


class AutoLayoutIn(BaseModel):
    asset_id: uuid.UUID
    quantity: int = Field(gt=0, le=10000)
    orientation: str = "auto"


class AutoLayoutOut(BaseModel):
    placements: list[dict]
    total_height_mm: float
    cols: int
    rows: int
    zones: int


# ---------- Cutter Presets ----------


@router.get("/presets", response_model=list[CutterPresetOut])
def list_presets(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[CutterPresetOut]:
    user = _resolve_user(db, auth)
    rows = (
        db.query(CutterPreset)
        .filter(CutterPreset.user_id == user.id)
        .order_by(CutterPreset.created_at.desc())
        .all()
    )
    return [
        CutterPresetOut(
            id=r.id,
            name=r.name,
            media_width_mm=r.media_width_mm,
            registration_type=r.registration_type,
            max_zone_length_mm=r.max_zone_length_mm,
            mark_offset_mm=r.mark_offset_mm,
            default_gap_mm=r.default_gap_mm,
            default_edge_margin_mm=r.default_edge_margin_mm,
            show_crop_marks=r.show_crop_marks,
        )
        for r in rows
    ]


@router.post("/presets", response_model=CutterPresetOut, status_code=status.HTTP_201_CREATED)
def create_preset(
    payload: CutterPresetIn,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CutterPresetOut:
    user = _resolve_user(db, auth)
    preset = CutterPreset(
        user_id=user.id,
        name=payload.name,
        media_width_mm=payload.media_width_mm,
        registration_type=payload.registration_type,
        max_zone_length_mm=payload.max_zone_length_mm,
        mark_offset_mm=payload.mark_offset_mm,
        default_gap_mm=payload.default_gap_mm,
        default_edge_margin_mm=payload.default_edge_margin_mm,
        show_crop_marks=payload.show_crop_marks,
    )
    db.add(preset)
    db.commit()
    db.refresh(preset)
    return CutterPresetOut(
        id=preset.id,
        name=preset.name,
        media_width_mm=preset.media_width_mm,
        registration_type=preset.registration_type,
        max_zone_length_mm=preset.max_zone_length_mm,
        mark_offset_mm=preset.mark_offset_mm,
        default_gap_mm=preset.default_gap_mm,
        default_edge_margin_mm=preset.default_edge_margin_mm,
        show_crop_marks=preset.show_crop_marks,
    )


@router.delete("/presets/{preset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_preset(
    preset_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    user = _resolve_user(db, auth)
    preset = (
        db.query(CutterPreset)
        .filter(CutterPreset.id == preset_id, CutterPreset.user_id == user.id)
        .one_or_none()
    )
    if not preset:
        raise HTTPException(404, "Preset not found")
    db.delete(preset)
    db.commit()


# ---------- Sticker Sheets ----------


@router.get("", response_model=list[SheetOut])
def list_sheets(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[SheetOut]:
    user = _resolve_user(db, auth)
    rows = (
        db.query(StickerSheet)
        .filter(StickerSheet.user_id == user.id)
        .order_by(StickerSheet.created_at.desc())
        .all()
    )
    return [_sheet_to_out(r) for r in rows]


@router.post("", response_model=SheetOut, status_code=status.HTTP_201_CREATED)
def create_sheet(
    payload: SheetIn,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SheetOut:
    user = _resolve_user(db, auth)
    sheet = StickerSheet(
        user_id=user.id,
        name=payload.name,
        media_width_mm=payload.media_width_mm,
        media_height_mm=payload.media_height_mm,
        mode=payload.mode,
        sub_sheet_size=payload.sub_sheet_size,
        gap_mm=payload.gap_mm,
        sub_sheet_gap_mm=payload.sub_sheet_gap_mm,
        sub_sheet_padding_mm=payload.sub_sheet_padding_mm,
        edge_margin_mm=payload.edge_margin_mm,
        show_crop_marks=payload.show_crop_marks,
        registration_type=payload.registration_type,
        max_zone_length_mm=payload.max_zone_length_mm,
        mark_offset_mm=payload.mark_offset_mm,
        placements=[p.model_dump(mode="json") for p in payload.placements]
        if payload.placements
        else [],
        cutter_preset_id=payload.cutter_preset_id,
        sub_sheet_fill_color=payload.sub_sheet_fill_color,
        sub_sheet_fill_color2=payload.sub_sheet_fill_color2,
        sub_sheet_gradient_angle=payload.sub_sheet_gradient_angle,
        sub_sheet_title=payload.sub_sheet_title,
        sub_sheet_title_font=payload.sub_sheet_title_font,
        sub_sheet_title_size_mm=payload.sub_sheet_title_size_mm,
        sub_sheet_title_color=payload.sub_sheet_title_color,
        sub_sheet_title_bold=payload.sub_sheet_title_bold,
        sticker_align_h=payload.sticker_align_h,
        sticker_align_v=payload.sticker_align_v,
        sub_sheet_bleed_mm=payload.sub_sheet_bleed_mm,
    )
    db.add(sheet)
    db.commit()
    db.refresh(sheet)
    return _sheet_to_out(sheet)


@router.put("/{sheet_id}", response_model=SheetOut)
def update_sheet(
    sheet_id: uuid.UUID,
    payload: SheetIn,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SheetOut:
    user = _resolve_user(db, auth)
    sheet = _own_sheet(db, user, sheet_id)
    sheet.name = payload.name
    sheet.media_width_mm = payload.media_width_mm
    sheet.media_height_mm = payload.media_height_mm
    sheet.mode = payload.mode
    sheet.sub_sheet_size = payload.sub_sheet_size
    sheet.gap_mm = payload.gap_mm
    sheet.sub_sheet_gap_mm = payload.sub_sheet_gap_mm
    sheet.sub_sheet_padding_mm = payload.sub_sheet_padding_mm
    sheet.edge_margin_mm = payload.edge_margin_mm
    sheet.show_crop_marks = payload.show_crop_marks
    sheet.registration_type = payload.registration_type
    sheet.max_zone_length_mm = payload.max_zone_length_mm
    sheet.mark_offset_mm = payload.mark_offset_mm
    sheet.placements = (
        [p.model_dump(mode="json") for p in payload.placements]
        if payload.placements
        else sheet.placements
    )
    sheet.cutter_preset_id = payload.cutter_preset_id
    sheet.sub_sheet_fill_color = payload.sub_sheet_fill_color
    sheet.sub_sheet_fill_color2 = payload.sub_sheet_fill_color2
    sheet.sub_sheet_gradient_angle = payload.sub_sheet_gradient_angle
    sheet.sub_sheet_title = payload.sub_sheet_title
    sheet.sub_sheet_title_font = payload.sub_sheet_title_font
    sheet.sub_sheet_title_size_mm = payload.sub_sheet_title_size_mm
    sheet.sub_sheet_title_color = payload.sub_sheet_title_color
    sheet.sub_sheet_title_bold = payload.sub_sheet_title_bold
    sheet.sticker_align_h = payload.sticker_align_h
    sheet.sticker_align_v = payload.sticker_align_v
    sheet.sub_sheet_bleed_mm = payload.sub_sheet_bleed_mm
    db.commit()
    db.refresh(sheet)
    return _sheet_to_out(sheet)


@router.delete("/{sheet_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sheet(
    sheet_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    user = _resolve_user(db, auth)
    sheet = _own_sheet(db, user, sheet_id)
    if sheet.output_r2_key:
        try:
            storage.delete(sheet.output_r2_key)
        except Exception:
            pass
    db.delete(sheet)
    db.commit()


# ---------- Auto-Layout ----------


@router.post("/{sheet_id}/auto-layout", response_model=AutoLayoutOut)
def run_auto_layout(
    sheet_id: uuid.UUID,
    payload: AutoLayoutIn,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AutoLayoutOut:
    user = _resolve_user(db, auth)
    sheet = _own_sheet(db, user, sheet_id)

    asset = (
        db.query(Asset)
        .filter(Asset.id == payload.asset_id, Asset.user_id == user.id)
        .one_or_none()
    )
    if not asset:
        raise HTTPException(404, "Asset not found")

    sticker_w_mm = asset.width_pt / (72.0 / 25.4)
    sticker_h_mm = asset.height_pt / (72.0 / 25.4)

    cfg = SheetConfig(
        media_width_mm=sheet.media_width_mm,
        media_height_mm=sheet.media_height_mm,
        mode=sheet.mode,  # type: ignore[arg-type]
        gap_mm=sheet.gap_mm,
        edge_margin_mm=sheet.edge_margin_mm,
        sub_sheet_gap_mm=getattr(sheet, "sub_sheet_gap_mm", 5.0) or 5.0,
        sub_sheet_padding_mm=getattr(sheet, "sub_sheet_padding_mm", 5.0) or 5.0,
        show_crop_marks=sheet.show_crop_marks,
        registration_type=sheet.registration_type,
        max_zone_length_mm=sheet.max_zone_length_mm,
        mark_offset_mm=sheet.mark_offset_mm,
        sub_sheet_size=sheet.sub_sheet_size,
        sticker_align_h=getattr(sheet, "sticker_align_h", "center") or "center",
        sticker_align_v=getattr(sheet, "sticker_align_v", "top") or "top",
        sub_sheet_bleed_mm=getattr(sheet, "sub_sheet_bleed_mm", 0.0) or 0.0,
        sub_sheet_title=getattr(sheet, "sub_sheet_title", None),
        sub_sheet_title_size_mm=getattr(sheet, "sub_sheet_title_size_mm", 5.0) or 5.0,
    )

    result = auto_layout(
        sticker_width_mm=sticker_w_mm,
        sticker_height_mm=sticker_h_mm,
        quantity=payload.quantity,
        config=cfg,
        asset_id=str(asset.id),
        orientation=payload.orientation,  # type: ignore[arg-type]
    )

    placements_json = [
        {
            "asset_id": str(p.asset_id),
            "x_mm": round(p.x_mm, 2),
            "y_mm": round(p.y_mm, 2),
            "rotation_deg": p.rotation_deg,
            "scale": p.scale,
        }
        for p in result.placements
    ]

    sheet.placements = placements_json
    sheet.media_height_mm = result.total_height_mm
    db.commit()

    return AutoLayoutOut(
        placements=placements_json,
        total_height_mm=round(result.total_height_mm, 2),
        cols=result.cols,
        rows=result.rows,
        zones=result.zones,
    )


# ---------- Export PDF ----------


@router.post("/{sheet_id}/export")
def export_sheet_pdf(
    sheet_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    user = _resolve_user(db, auth)
    sheet = _own_sheet(db, user, sheet_id)

    if not sheet.placements:
        raise HTTPException(400, "Sheet has no sticker placements")

    asset_ids = list({p["asset_id"] for p in sheet.placements})
    assets = (
        db.query(Asset)
        .filter(Asset.id.in_(asset_ids), Asset.user_id == user.id)
        .all()
    )
    asset_map = {str(a.id): a for a in assets}

    asset_pdfs: dict[str, bytes] = {}
    for aid, asset in asset_map.items():
        try:
            asset_pdfs[aid] = storage.get_bytes(asset.r2_key)
        except Exception as exc:
            raise HTTPException(503, f"Could not read asset PDF: {exc}") from exc

    cfg = SheetConfig(
        media_width_mm=sheet.media_width_mm,
        media_height_mm=sheet.media_height_mm,
        mode=sheet.mode,  # type: ignore[arg-type]
        gap_mm=sheet.gap_mm,
        edge_margin_mm=sheet.edge_margin_mm,
        sub_sheet_gap_mm=getattr(sheet, "sub_sheet_gap_mm", 5.0) or 5.0,
        sub_sheet_padding_mm=getattr(sheet, "sub_sheet_padding_mm", 5.0) or 5.0,
        show_crop_marks=sheet.show_crop_marks,
        registration_type=sheet.registration_type,
        max_zone_length_mm=sheet.max_zone_length_mm,
        mark_offset_mm=sheet.mark_offset_mm,
        sub_sheet_size=sheet.sub_sheet_size,
        sticker_align_h=getattr(sheet, "sticker_align_h", "center") or "center",
        sticker_align_v=getattr(sheet, "sticker_align_v", "top") or "top",
        sub_sheet_bleed_mm=getattr(sheet, "sub_sheet_bleed_mm", 0.0) or 0.0,
        sub_sheet_title=getattr(sheet, "sub_sheet_title", None),
        sub_sheet_title_size_mm=getattr(sheet, "sub_sheet_title_size_mm", 5.0) or 5.0,
    )

    placements_typed = [
        Placement(
            asset_id=p["asset_id"],
            x_mm=p["x_mm"],
            y_mm=p["y_mm"],
            rotation_deg=int(p.get("rotation_deg", 0)),
            scale=float(p.get("scale", 1.0)),
        )
        for p in sheet.placements
    ]

    pdf_bytes = compose_pdf(cfg, placements_typed, asset_pdfs, sheet.media_height_mm)

    r2_key = f"users/{user.id}/sheets/{sheet.id}/output.pdf"
    storage.put_bytes(r2_key, pdf_bytes, content_type="application/pdf")
    sheet.output_r2_key = r2_key
    db.commit()

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{sheet.name}.pdf"',
        },
    )


# ---------- Helpers ----------


def _own_sheet(db: Session, user: User, sheet_id: uuid.UUID) -> StickerSheet:
    sheet = (
        db.query(StickerSheet)
        .filter(StickerSheet.id == sheet_id, StickerSheet.user_id == user.id)
        .one_or_none()
    )
    if not sheet:
        raise HTTPException(404, "Sheet not found")
    return sheet


def _sheet_to_out(s: StickerSheet) -> SheetOut:
    output_url = None
    if s.output_r2_key:
        try:
            output_url = storage.presigned_get(s.output_r2_key, expires_in=3600)
        except Exception:
            pass
    bg_url = None
    if getattr(s, "sub_sheet_bg_r2_key", None):
        try:
            bg_url = storage.presigned_get(s.sub_sheet_bg_r2_key, expires_in=3600)
        except Exception:
            pass
    return SheetOut(
        id=s.id,
        name=s.name,
        media_width_mm=s.media_width_mm,
        media_height_mm=s.media_height_mm,
        mode=s.mode,
        sub_sheet_size=s.sub_sheet_size,
        gap_mm=s.gap_mm,
        sub_sheet_gap_mm=getattr(s, "sub_sheet_gap_mm", 5.0) or 5.0,
        sub_sheet_padding_mm=getattr(s, "sub_sheet_padding_mm", 5.0) or 5.0,
        edge_margin_mm=s.edge_margin_mm,
        show_crop_marks=s.show_crop_marks,
        registration_type=s.registration_type,
        max_zone_length_mm=s.max_zone_length_mm,
        mark_offset_mm=s.mark_offset_mm,
        placements=s.placements,
        cutter_preset_id=s.cutter_preset_id,
        sub_sheet_fill_color=getattr(s, "sub_sheet_fill_color", None),
        sub_sheet_fill_color2=getattr(s, "sub_sheet_fill_color2", None),
        sub_sheet_gradient_angle=getattr(s, "sub_sheet_gradient_angle", 135.0),
        sub_sheet_bg_url=bg_url,
        sub_sheet_title=getattr(s, "sub_sheet_title", None),
        sub_sheet_title_font=getattr(s, "sub_sheet_title_font", None),
        sub_sheet_title_size_mm=getattr(s, "sub_sheet_title_size_mm", None),
        sub_sheet_title_color=getattr(s, "sub_sheet_title_color", None),
        sub_sheet_title_bold=getattr(s, "sub_sheet_title_bold", None),
        sticker_align_h=getattr(s, "sticker_align_h", "center"),
        sticker_align_v=getattr(s, "sticker_align_v", "top"),
        sub_sheet_bleed_mm=getattr(s, "sub_sheet_bleed_mm", 0.0),
        output_url=output_url,
    )


# ---------- Background image upload ----------

@router.post("/{sheet_id}/bg-upload")
async def upload_bg_image(
    sheet_id: uuid.UUID,
    file: UploadFile = File(...),
    user: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    real_user = _resolve_user(user, db)
    sheet = (
        db.query(StickerSheet)
        .filter(StickerSheet.id == sheet_id, StickerSheet.user_id == real_user.id)
        .first()
    )
    if not sheet:
        raise HTTPException(status_code=404, detail="Sheet not found")

    content = await file.read()
    ext = (file.filename or "bg.png").rsplit(".", 1)[-1].lower()
    r2_key = f"sheets/{sheet.id}/bg.{ext}"

    storage.put_bytes(r2_key, content, content_type=file.content_type or "image/png")

    sheet.sub_sheet_bg_r2_key = r2_key
    url = storage.presigned_get(r2_key, expires_in=3600)
    sheet.sub_sheet_bg_url = url
    db.commit()

    return {"url": url}
