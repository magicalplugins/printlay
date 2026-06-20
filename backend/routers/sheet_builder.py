"""Sheet Builder API router.

CRUD for sticker sheets and cutter presets, plus auto-layout and PDF export.
"""
from __future__ import annotations

import math
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
    SUB_SHEET_SIZES,
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
    sub_sheet_custom_w_mm: float | None = Field(default=None, gt=0)
    sub_sheet_custom_h_mm: float | None = Field(default=None, gt=0)
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
    spot_color_cutlines: str | None = "CutContour"
    spot_color_subsheets: str | None = "#00FF00"
    spot_color_marks: str | None = "#000000"
    sheet_type: str = "sticker"
    mirror_output: bool = False


class SheetOut(BaseModel):
    id: uuid.UUID
    name: str
    media_width_mm: float
    media_height_mm: float
    mode: str
    sub_sheet_size: str | None
    sub_sheet_custom_w_mm: float | None = None
    sub_sheet_custom_h_mm: float | None = None
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
    spot_color_cutlines: str | None = None
    spot_color_subsheets: str | None = None
    spot_color_marks: str | None = None
    sheet_type: str = "sticker"
    mirror_output: bool = False
    output_url: str | None = None


class AutoLayoutIn(BaseModel):
    asset_id: uuid.UUID
    quantity: int = Field(gt=0, le=10000)
    orientation: str = "auto"
    # Optional placed size override (mm). When given, every sticker is laid
    # out at this size instead of its native size. Aspect ratio is enforced
    # from the asset's native dimensions (scale derived from width). None =
    # use the asset's native size.
    width_mm: float | None = Field(default=None, gt=0, le=5000)
    height_mm: float | None = Field(default=None, gt=0, le=5000)


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
        sub_sheet_custom_w_mm=payload.sub_sheet_custom_w_mm,
        sub_sheet_custom_h_mm=payload.sub_sheet_custom_h_mm,
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
        spot_color_cutlines=payload.spot_color_cutlines,
        spot_color_subsheets=payload.spot_color_subsheets,
        spot_color_marks=payload.spot_color_marks,
        sheet_type=payload.sheet_type,
        mirror_output=payload.mirror_output,
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
    sheet.sub_sheet_custom_w_mm = payload.sub_sheet_custom_w_mm
    sheet.sub_sheet_custom_h_mm = payload.sub_sheet_custom_h_mm
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
    sheet.spot_color_cutlines = payload.spot_color_cutlines
    sheet.spot_color_subsheets = payload.spot_color_subsheets
    sheet.spot_color_marks = payload.spot_color_marks
    sheet.sheet_type = payload.sheet_type
    sheet.mirror_output = payload.mirror_output
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


class BulkDeleteIn(BaseModel):
    ids: list[uuid.UUID]


@router.post("/bulk-delete", status_code=status.HTTP_204_NO_CONTENT)
def bulk_delete_sheets(
    body: BulkDeleteIn,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    user = _resolve_user(db, auth)
    rows = (
        db.query(StickerSheet)
        .filter(StickerSheet.user_id == user.id, StickerSheet.id.in_(body.ids))
        .all()
    )
    for sheet in rows:
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

    native_w_mm = asset.width_pt / (72.0 / 25.4)
    native_h_mm = asset.height_pt / (72.0 / 25.4)

    # Resolve the placed size. A custom width drives a uniform scale so the
    # aspect ratio is preserved (the frontend locks the two together, but we
    # re-derive here so the scale is exact and the PDF/SVG render matches).
    if payload.width_mm and payload.width_mm > 0 and native_w_mm > 0:
        scale = payload.width_mm / native_w_mm
    elif payload.height_mm and payload.height_mm > 0 and native_h_mm > 0:
        scale = payload.height_mm / native_h_mm
    else:
        scale = 1.0
    sticker_w_mm = native_w_mm * scale
    sticker_h_mm = native_h_mm * scale

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
        sub_sheet_custom_w_mm=getattr(sheet, "sub_sheet_custom_w_mm", None),
        sub_sheet_custom_h_mm=getattr(sheet, "sub_sheet_custom_h_mm", None),
        sticker_align_h=getattr(sheet, "sticker_align_h", "center") or "center",
        sticker_align_v=getattr(sheet, "sticker_align_v", "top") or "top",
        sub_sheet_bleed_mm=getattr(sheet, "sub_sheet_bleed_mm", 0.0) or 0.0,
        sub_sheet_title=getattr(sheet, "sub_sheet_title", None),
        sub_sheet_title_size_mm=getattr(sheet, "sub_sheet_title_size_mm", 5.0) or 5.0,
        spot_color_marks=getattr(sheet, "spot_color_marks", None),
        sheet_type=getattr(sheet, "sheet_type", "sticker"),
        mirror_output=getattr(sheet, "mirror_output", False),
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
            "scale": round(scale, 4),
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


# ---------- Multi-Asset Auto-Layout ----------


class MultiAssetItem(BaseModel):
    asset_id: uuid.UUID
    quantity: int = Field(gt=0, le=10000)
    width_mm: float | None = Field(default=None, gt=0, le=5000)
    height_mm: float | None = Field(default=None, gt=0, le=5000)
    orientation: str = "auto"


class MultiAutoLayoutIn(BaseModel):
    items: list[MultiAssetItem] = Field(min_length=1)


@router.post("/{sheet_id}/multi-auto-layout", response_model=AutoLayoutOut)
def run_multi_auto_layout(
    sheet_id: uuid.UUID,
    payload: MultiAutoLayoutIn,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AutoLayoutOut:
    """Pack multiple different assets onto the sheet, each with their own qty/size."""
    user = _resolve_user(db, auth)
    sheet = _own_sheet(db, user, sheet_id)

    # Save sheet config first
    cfg = SheetConfig(
        media_width_mm=sheet.media_width_mm,
        mode=sheet.mode or "roll",
        gap_mm=sheet.gap_mm,
        edge_margin_mm=sheet.edge_margin_mm,
        registration_type=sheet.registration_type,
        max_zone_length_mm=sheet.max_zone_length_mm,
        mark_offset_mm=sheet.mark_offset_mm or 5.0,
        sub_sheet_size=sheet.sub_sheet_size,
        sub_sheet_custom_w_mm=sheet.sub_sheet_custom_w_mm,
        sub_sheet_custom_h_mm=sheet.sub_sheet_custom_h_mm,
        sub_sheet_padding_mm=sheet.sub_sheet_padding_mm or 5.0,
        sub_sheet_gap_mm=sheet.sub_sheet_gap_mm or 5.0,
        show_crop_marks=sheet.show_crop_marks if sheet.show_crop_marks is not None else True,
        sub_sheet_title=sheet.sub_sheet_title,
        sub_sheet_title_size_mm=sheet.sub_sheet_title_size_mm or 5.0,
        sticker_align_h=sheet.sticker_align_h or "center",
        sticker_align_v=sheet.sticker_align_v or "top",
    )

    all_placements: list[dict] = []
    y_offset = cfg.edge_margin_mm
    gap = cfg.gap_mm
    margin = cfg.edge_margin_mm

    for item in payload.items:
        asset = (
            db.query(Asset)
            .filter(Asset.id == item.asset_id, Asset.user_id == user.id)
            .one_or_none()
        )
        if not asset:
            continue

        native_w_mm = asset.width_pt / (72.0 / 25.4)
        native_h_mm = asset.height_pt / (72.0 / 25.4)

        if item.width_mm and item.width_mm > 0 and native_w_mm > 0:
            scale = item.width_mm / native_w_mm
        elif item.height_mm and item.height_mm > 0 and native_h_mm > 0:
            scale = item.height_mm / native_h_mm
        else:
            scale = 1.0

        sw = native_w_mm * scale
        sh = native_h_mm * scale

        # Determine orientation
        available_w = cfg.media_width_mm - 2 * margin
        orient = item.orientation
        if orient == "auto":
            cols_h = max(1, int((available_w + gap) / (sw + gap)))
            cols_v = max(1, int((available_w + gap) / (sh + gap)))
            if cols_v > cols_h:
                sw, sh = sh, sw
        elif orient == "horizontal":
            if sw > sh:
                sw, sh = sh, sw
        elif orient == "vertical":
            if sh > sw:
                sw, sh = sh, sw

        cols = max(1, int((available_w + gap) / (sw + gap)))
        rows_needed = math.ceil(item.quantity / cols)
        rotation = 90 if (sw != native_w_mm * scale) else 0

        idx = 0
        for row in range(rows_needed):
            for col in range(cols):
                if idx >= item.quantity:
                    break
                x = margin + col * (sw + gap)
                y = y_offset + row * (sh + gap)
                all_placements.append({
                    "asset_id": str(asset.id),
                    "x_mm": round(x, 2),
                    "y_mm": round(y, 2),
                    "rotation_deg": rotation,
                    "scale": round(scale, 4),
                })
                idx += 1

        y_offset += rows_needed * (sh + gap)

    total_height = y_offset + margin
    sheet.placements = all_placements
    sheet.media_height_mm = total_height
    db.commit()

    total_items = sum(i.quantity for i in payload.items)
    cols_approx = max(1, int((cfg.media_width_mm - 2 * margin + gap) / 50))

    return AutoLayoutOut(
        placements=all_placements,
        total_height_mm=round(total_height, 2),
        cols=cols_approx,
        rows=math.ceil(total_items / max(cols_approx, 1)),
        zones=1,
    )


# ---------- DTF Auto-Pack ----------


class PackResult(BaseModel):
    placements: list[dict]
    total_height_mm: float


@router.post("/{sheet_id}/pack", response_model=PackResult)
def pack_sheet(
    sheet_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Auto-pack existing placements into optimal positions without overlap.

    Uses a simple bottom-left shelf algorithm that respects item sizes.
    Returns new placements without saving, so the frontend can animate.
    """
    sheet = db.query(StickerSheet).filter_by(
        id=sheet_id, user_id=auth.user_id
    ).first()
    if not sheet:
        raise HTTPException(404, "Sheet not found")

    placements = sheet.placements or []
    if not placements:
        return PackResult(placements=[], total_height_mm=sheet.media_height_mm)

    gap = sheet.gap_mm
    margin = sheet.edge_margin_mm
    media_w = sheet.media_width_mm

    # Build items with their sizes from placements
    items = []
    for p in placements:
        asset = db.query(Asset).filter_by(id=p["asset_id"]).first()
        if not asset:
            continue
        mm_per_pt = 25.4 / 72
        native_w = asset.width_pt * mm_per_pt
        native_h = asset.height_pt * mm_per_pt
        scale = p.get("scale", 1.0)
        rot = p.get("rotation_deg", 0)
        w = native_w * scale
        h = native_h * scale
        if rot == 90 or rot == 270:
            w, h = h, w
        items.append({"p": p, "w": w, "h": h})

    # Sort by height descending for better shelf packing
    items.sort(key=lambda x: -x["h"])

    # Bottom-left shelf algorithm
    packed = []
    x_cursor = margin
    y_cursor = margin
    row_height = 0.0

    for item in items:
        w, h = item["w"], item["h"]
        if x_cursor + w > media_w - margin:
            # Next row
            x_cursor = margin
            y_cursor += row_height + gap
            row_height = 0.0

        packed.append({
            **item["p"],
            "x_mm": round(x_cursor, 2),
            "y_mm": round(y_cursor, 2),
        })
        x_cursor += w + gap
        row_height = max(row_height, h)

    total_height = y_cursor + row_height + margin

    return PackResult(
        placements=packed,
        total_height_mm=round(total_height, 2),
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
        sub_sheet_custom_w_mm=getattr(sheet, "sub_sheet_custom_w_mm", None),
        sub_sheet_custom_h_mm=getattr(sheet, "sub_sheet_custom_h_mm", None),
        sticker_align_h=getattr(sheet, "sticker_align_h", "center") or "center",
        sticker_align_v=getattr(sheet, "sticker_align_v", "top") or "top",
        sub_sheet_bleed_mm=getattr(sheet, "sub_sheet_bleed_mm", 0.0) or 0.0,
        sub_sheet_title=getattr(sheet, "sub_sheet_title", None),
        sub_sheet_title_size_mm=getattr(sheet, "sub_sheet_title_size_mm", 5.0) or 5.0,
        spot_color_marks=getattr(sheet, "spot_color_marks", None),
        sheet_type=getattr(sheet, "sheet_type", "sticker"),
        mirror_output=getattr(sheet, "mirror_output", False),
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


def _parse_cut_contour(raw: str | None) -> list[tuple[float, float]] | None:
    """Parse a stored sticker contour (normalised 0..1 points) → list of
    (x, y) tuples, or None if absent/invalid."""
    if not raw:
        return None
    try:
        import json

        pts = json.loads(raw)
        if isinstance(pts, list) and len(pts) >= 3:
            return [(float(p[0]), float(p[1])) for p in pts]
    except Exception:
        return None
    return None


def _rotate_norm_point(
    nx: float,
    ny: float,
    uw: float,
    uh: float,
    rotation: int,
    x0: float,
    y0: float,
) -> tuple[float, float]:
    """Map a normalised (0..1) contour point in the sticker's own space to
    absolute sheet mm, applying the placement rotation (clockwise) and the
    top-left offset (x0, y0). `uw`/`uh` are the unrotated placed size in mm."""
    lx = nx * uw
    ly = ny * uh
    if rotation == 90:
        rx, ry = uh - ly, lx
    elif rotation == 180:
        rx, ry = uw - lx, uh - ly
    elif rotation == 270:
        rx, ry = ly, uw - lx
    else:
        rx, ry = lx, ly
    return x0 + rx, y0 + ry


# ---------- Export SVG (cut lines only) ----------


@router.post("/{sheet_id}/export-svg")
def export_sheet_svg(
    sheet_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Export an SVG containing only cut lines, sub-sheet outlines, crop marks,
    and registration marks — no artwork."""
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

    w = sheet.media_width_mm
    h = sheet.media_height_mm

    cut_stroke = getattr(sheet, "spot_color_cutlines", None) or "#FF00FF"
    subsheet_stroke = getattr(sheet, "spot_color_subsheets", None) or "#00FF00"
    mark_stroke = getattr(sheet, "spot_color_marks", None) or "#000000"

    elements: list[str] = []

    # --- Sub-sheet outlines ---
    sub_size = _svg_sub_size(sheet)
    if sub_size:
        sub_w, sub_h = sub_size
        sub_gap = getattr(sheet, "sub_sheet_gap_mm", 5.0) or 5.0
        edge = sheet.edge_margin_mm
        avail = w - 2 * edge
        sub_cols = max(1, int((avail + sub_gap) / (sub_w + sub_gap)))
        avail_h = h - 2 * edge
        sub_rows = max(1, int((avail_h + sub_gap) / (sub_h + sub_gap)))

        for sr in range(sub_rows):
            for sc in range(sub_cols):
                sx = edge + sc * (sub_w + sub_gap)
                sy = edge + sr * (sub_h + sub_gap)
                elements.append(
                    f'  <rect x="{sx:.2f}" y="{sy:.2f}" '
                    f'width="{sub_w:.2f}" height="{sub_h:.2f}" '
                    f'fill="none" stroke="{subsheet_stroke}" stroke-width="0.1"/>'
                )

    # --- Cut lines (one closed path per placement) ---
    # If the sticker carries a custom contour (face/contour cut), trace that;
    # otherwise fall back to the bounding rectangle.
    for p in sheet.placements:
        asset = asset_map.get(p["asset_id"])
        if not asset:
            continue
        sw_mm = asset.width_pt / (72.0 / 25.4)
        sh_mm = asset.height_pt / (72.0 / 25.4)
        scale = float(p.get("scale", 1.0))
        rotation = int(p.get("rotation_deg", 0))
        x0 = p["x_mm"]
        y0 = p["y_mm"]

        uw, uh = sw_mm * scale, sh_mm * scale  # unrotated placed size (mm)
        contour = _parse_cut_contour(getattr(asset, "cut_contour_json", None))

        if contour:
            pts = [
                _rotate_norm_point(nx, ny, uw, uh, rotation, x0, y0)
                for nx, ny in contour
            ]
            d = "M " + " L ".join(f"{px:.2f} {py:.2f}" for px, py in pts) + " Z"
            elements.append(
                f'  <path d="{d}" fill="none" '
                f'stroke="{cut_stroke}" stroke-width="0.1"/>'
            )
        else:
            pw, ph = (uh, uw) if rotation in (90, 270) else (uw, uh)
            elements.append(
                f'  <path d="M {x0:.2f} {y0:.2f} '
                f'L {x0 + pw:.2f} {y0:.2f} '
                f'L {x0 + pw:.2f} {y0 + ph:.2f} '
                f'L {x0:.2f} {y0 + ph:.2f} Z" '
                f'fill="none" stroke="{cut_stroke}" stroke-width="0.1"/>'
            )

    # --- Crop marks at sub-sheet corners ---
    if sheet.show_crop_marks and sub_size:
        sub_w, sub_h = sub_size
        sub_gap = getattr(sheet, "sub_sheet_gap_mm", 5.0) or 5.0
        edge = sheet.edge_margin_mm
        avail = w - 2 * edge
        sub_cols = max(1, int((avail + sub_gap) / (sub_w + sub_gap)))
        avail_h = h - 2 * edge
        sub_rows = max(1, int((avail_h + sub_gap) / (sub_h + sub_gap)))

        mark_len = 3.0
        offset = 1.5

        for sr in range(sub_rows):
            for sc in range(sub_cols):
                sx = edge + sc * (sub_w + sub_gap)
                sy = edge + sr * (sub_h + sub_gap)
                corners = [
                    (sx, sy),
                    (sx + sub_w, sy),
                    (sx, sy + sub_h),
                    (sx + sub_w, sy + sub_h),
                ]
                for cx, cy in corners:
                    h_dir = -1 if cx == sx else 1
                    v_dir = -1 if cy == sy else 1
                    elements.append(
                        f'  <line x1="{cx + h_dir * offset:.2f}" y1="{cy:.2f}" '
                        f'x2="{cx + h_dir * (offset + mark_len):.2f}" y2="{cy:.2f}" '
                        f'stroke="{mark_stroke}" stroke-width="0.1"/>'
                    )
                    elements.append(
                        f'  <line x1="{cx:.2f}" y1="{cy + v_dir * offset:.2f}" '
                        f'x2="{cx:.2f}" y2="{cy + v_dir * (offset + mark_len):.2f}" '
                        f'stroke="{mark_stroke}" stroke-width="0.1"/>'
                    )

    # --- Registration marks ---
    reg_type = sheet.registration_type
    mark_offset = sheet.mark_offset_mm

    if reg_type == "velloblade":
        _svg_velloblade_marks(elements, w, h, mark_offset, sheet.max_zone_length_mm, mark_stroke)
    elif reg_type == "summa_opos":
        _svg_summa_marks(elements, w, h, mark_offset, sheet.max_zone_length_mm, mark_stroke)
    elif reg_type == "generic":
        _svg_generic_marks(elements, w, h, mark_offset, mark_stroke)

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{w:.2f}mm" height="{h:.2f}mm" '
        f'viewBox="0 0 {w:.2f} {h:.2f}">\n'
        + "\n".join(elements)
        + "\n</svg>\n"
    )

    return Response(content=svg, media_type="image/svg+xml")


def _svg_sub_size(sheet) -> tuple[float, float] | None:
    """Resolve sub-sheet (w, h) in mm including a custom size."""
    key = sheet.sub_sheet_size or ""
    if key == "custom":
        cw = getattr(sheet, "sub_sheet_custom_w_mm", None)
        ch = getattr(sheet, "sub_sheet_custom_h_mm", None)
        if cw and ch:
            return (float(cw), float(ch))
        return None
    return SUB_SHEET_SIZES.get(key)


# Velloblade registration circles are always 6mm diameter.
VELLOBLADE_CIRCLE_DIAMETER_MM = 6.0


def _velloblade_mark_centres(
    w: float, h: float, mark_offset: float, max_zone: float | None
) -> list[tuple[float, float]]:
    """Centres for Velloblade reg circles: 4 corners + 1 top-centre per zone."""
    if max_zone:
        num_zones = max(1, math.ceil(h / max_zone))
    else:
        max_zone = h
        num_zones = 1

    centres: list[tuple[float, float]] = []
    for z in range(num_zones):
        zone_top = z * max_zone
        zone_bottom = min((z + 1) * max_zone, h)
        centres.extend([
            (mark_offset, zone_top + mark_offset),
            (w - mark_offset, zone_top + mark_offset),
            (mark_offset, zone_bottom - mark_offset),
            (w - mark_offset, zone_bottom - mark_offset),
            # Middle mark at the top edge of the zone.
            (w / 2.0, zone_top + mark_offset),
        ])
    return centres


def _svg_velloblade_marks(
    elements: list[str],
    w: float,
    h: float,
    mark_offset: float,
    max_zone: float | None,
    stroke: str,
) -> None:
    """Velloblade: 6mm hollow circles (0.1 stroke) at 4 corners + top centre.

    In the SVG (for cutting) the circle is hollow with a thin 0.1mm stroke so
    the machine cuts/registers on the outline. The full-fill version is only
    used in the printable PDF.
    """
    circle_r = VELLOBLADE_CIRCLE_DIAMETER_MM / 2.0
    for cx, cy in _velloblade_mark_centres(w, h, mark_offset, max_zone):
        elements.append(
            f'  <circle cx="{cx:.2f}" cy="{cy:.2f}" r="{circle_r:.2f}" '
            f'fill="none" stroke="{stroke}" stroke-width="0.1"/>'
        )


def _svg_summa_marks(
    elements: list[str],
    w: float,
    h: float,
    mark_offset: float,
    max_zone: float | None,
    stroke: str,
) -> None:
    """Summa OPOS: crosshair targets along both edges at zone boundaries."""
    arm_len = 1.5

    if max_zone:
        num_marks = max(2, math.ceil(h / max_zone) + 1)
    else:
        max_zone = h
        num_marks = 2

    for i in range(num_marks):
        if i == 0:
            y = mark_offset
        elif i == num_marks - 1:
            y = h - mark_offset
        else:
            y = i * max_zone

        for x in (mark_offset, w - mark_offset):
            elements.append(
                f'  <line x1="{x - arm_len:.2f}" y1="{y:.2f}" '
                f'x2="{x + arm_len:.2f}" y2="{y:.2f}" '
                f'stroke="{stroke}" stroke-width="0.1"/>'
            )
            elements.append(
                f'  <line x1="{x:.2f}" y1="{y - arm_len:.2f}" '
                f'x2="{x:.2f}" y2="{y + arm_len:.2f}" '
                f'stroke="{stroke}" stroke-width="0.1"/>'
            )


def _svg_generic_marks(
    elements: list[str],
    w: float,
    h: float,
    mark_offset: float,
    stroke: str,
) -> None:
    """Generic ISO-style registration crosshairs at four corners."""
    arm_len = 2.0
    corners = [
        (mark_offset, mark_offset),
        (w - mark_offset, mark_offset),
        (mark_offset, h - mark_offset),
        (w - mark_offset, h - mark_offset),
    ]
    for cx, cy in corners:
        elements.append(
            f'  <line x1="{cx - arm_len:.2f}" y1="{cy:.2f}" '
            f'x2="{cx + arm_len:.2f}" y2="{cy:.2f}" '
            f'stroke="{stroke}" stroke-width="0.1"/>'
        )
        elements.append(
            f'  <line x1="{cx:.2f}" y1="{cy - arm_len:.2f}" '
            f'x2="{cx:.2f}" y2="{cy + arm_len:.2f}" '
            f'stroke="{stroke}" stroke-width="0.1"/>'
        )
        elements.append(
            f'  <circle cx="{cx:.2f}" cy="{cy:.2f}" r="{arm_len * 0.6:.2f}" '
            f'fill="none" stroke="{stroke}" stroke-width="0.08"/>'
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
        sub_sheet_custom_w_mm=getattr(s, "sub_sheet_custom_w_mm", None),
        sub_sheet_custom_h_mm=getattr(s, "sub_sheet_custom_h_mm", None),
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
        spot_color_cutlines=getattr(s, "spot_color_cutlines", "CutContour"),
        spot_color_subsheets=getattr(s, "spot_color_subsheets", "#00FF00"),
        spot_color_marks=getattr(s, "spot_color_marks", "#000000"),
        sheet_type=getattr(s, "sheet_type", "sticker"),
        mirror_output=getattr(s, "mirror_output", False),
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
