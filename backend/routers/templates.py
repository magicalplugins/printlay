"""Template endpoints: upload, list, get, delete, download (presigned R2)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from backend.auth import AuthenticatedUser, get_current_user
from backend.database import get_db
from backend.models import Template, User
from backend.schemas.template import GenerateRequest, TemplateOut, TemplateUpdate
from backend.services import entitlements, pdf_generator, pdf_parser, storage

router = APIRouter(prefix="/api/templates", tags=["templates"])

MAX_UPLOAD_BYTES = 50 * 1024 * 1024
ALLOWED_CONTENT_TYPES = {"application/pdf", "application/octet-stream"}


def _shape_to_json(s: pdf_parser.ParsedShape) -> dict:
    """Serialise a ParsedShape for the `templates.shapes` JSONB column.

    `corner_radius_pt` is only emitted when non-zero so plain rectangles
    and ellipses keep the same JSON shape they always had (no spurious
    diff in stored rows when the parser improves)."""
    out: dict = {
        "page_index": s.page_index,
        "shape_index": s.shape_index,
        "bbox": list(s.bbox),
        "layer": s.layer,
        "is_position_slot": s.is_position_slot,
        "kind": s.kind,
    }
    if s.corner_radius_pt and s.corner_radius_pt > 0:
        out["corner_radius_pt"] = round(s.corner_radius_pt, 3)
    if s.path:
        # Persist as a plain list-of-lists for JSONB friendliness;
        # tuples round-trip as lists anyway and the frontend type is
        # `[number, number][]`.
        out["path"] = [[u, v] for (u, v) in s.path]
    return out


def _resolve_user(db: Session, auth: AuthenticatedUser) -> User:
    if not auth.email:
        raise HTTPException(400, "JWT missing email claim")
    from backend.services import user_provisioning
    return user_provisioning.get_or_provision(
        db, auth_id=auth.auth_id, email=auth.email
    )


@router.get("", response_model=list[TemplateOut])
def list_templates(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[Template]:
    user = _resolve_user(db, auth)
    return (
        db.query(Template)
        .filter(Template.user_id == user.id)
        .order_by(Template.created_at.desc())
        .all()
    )


@router.get("/{template_id}", response_model=TemplateOut)
def get_template(
    template_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Template:
    user = _resolve_user(db, auth)
    tpl = db.query(Template).filter(
        Template.id == template_id, Template.user_id == user.id
    ).one_or_none()
    if tpl is None:
        raise HTTPException(404, "Template not found")
    return tpl


@router.post("/upload", response_model=TemplateOut, status_code=status.HTTP_201_CREATED)
async def upload_template(
    file: UploadFile = File(...),
    name: str | None = None,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Template:
    user = _resolve_user(db, auth)

    ent = entitlements.for_user(user)
    if not ent.allows("pdf_export"):
        raise HTTPException(
            402,
            detail={
                "code": "plan_locked",
                "message": "Your trial has ended. Reactivate your account to upload templates.",
            },
        )
    current_count = db.query(Template).filter(Template.user_id == user.id).count()
    if not ent.under_quota("templates_max", current_count):
        raise HTTPException(
            402,
            detail={
                "code": "quota_exceeded",
                "limit": "templates_max",
                "cap": ent.quota("templates_max"),
                "message": f"You've reached your {ent.quota('templates_max')}-template limit. Upgrade to Pro for unlimited templates.",
            },
        )

    if file.content_type and file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(415, f"Unsupported content type: {file.content_type}")

    body = await file.read()
    if not body:
        raise HTTPException(400, "Empty upload")
    if len(body) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"File exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit")

    try:
        parsed = pdf_parser.parse(body)
    except Exception as exc:
        raise HTTPException(422, f"Could not parse PDF: {exc}")

    if not parsed.shapes:
        raise HTTPException(
            422,
            "No slot shapes found in this PDF. Make sure the file has rectangles "
            "or circles on a layer named POSITIONS, then re-export.",
        )

    template_id = uuid.uuid4()
    r2_key = f"users/{user.id}/templates/{template_id}/source.pdf"
    try:
        storage.put_bytes(r2_key, body, content_type="application/pdf")
    except storage.StorageNotConfigured as exc:
        raise HTTPException(503, str(exc))

    tpl = Template(
        id=template_id,
        user_id=user.id,
        name=name or file.filename or "Untitled template",
        source="uploaded",
        r2_key=r2_key,
        page_width=parsed.page_width,
        page_height=parsed.page_height,
        positions_layer=parsed.positions_layer or "POSITIONS",
        has_ocg=parsed.has_positions_ocg,
        shapes=[_shape_to_json(s) for s in parsed.shapes],
    )
    db.add(tpl)
    db.commit()
    db.refresh(tpl)
    return tpl


@router.post("/{template_id}/reparse", response_model=TemplateOut)
def reparse_template(
    template_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Template:
    """Re-extract slot bboxes from the stored PDF using the current
    parser. Useful when the parser has been improved and existing
    uploaded templates still carry the old (bad) bboxes - saves the
    user from having to re-upload and re-program every job.

    Only works on templates with `source == "uploaded"` since that's
    the only case where re-parsing makes sense (generated templates
    have authoritative shapes from the generator itself).
    """
    user = _resolve_user(db, auth)
    tpl = db.query(Template).filter(
        Template.id == template_id, Template.user_id == user.id
    ).one_or_none()
    if tpl is None:
        raise HTTPException(404, "Template not found")
    if tpl.source != "uploaded":
        raise HTTPException(
            400, "Only uploaded templates can be re-parsed"
        )

    try:
        body = storage.get_bytes(tpl.r2_key)
    except Exception as exc:
        raise HTTPException(503, f"Could not read source PDF: {exc}")

    try:
        parsed = pdf_parser.parse(body, layer_hint=tpl.positions_layer)
    except Exception as exc:
        raise HTTPException(422, f"Could not parse PDF: {exc}")

    if not parsed.shapes:
        raise HTTPException(
            422,
            "No slot shapes found when re-parsing. The PDF may have changed.",
        )

    tpl.page_width = parsed.page_width
    tpl.page_height = parsed.page_height
    tpl.has_ocg = parsed.has_positions_ocg
    if parsed.positions_layer:
        tpl.positions_layer = parsed.positions_layer
    tpl.shapes = [_shape_to_json(s) for s in parsed.shapes]
    db.commit()
    db.refresh(tpl)
    return tpl


@router.post("/generate", response_model=TemplateOut, status_code=status.HTTP_201_CREATED)
def generate_template(
    payload: GenerateRequest,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Template:
    user = _resolve_user(db, auth)

    ent = entitlements.for_user(user)
    if not ent.allows("pdf_export"):
        raise HTTPException(
            402,
            detail={
                "code": "plan_locked",
                "message": "Your trial has ended. Reactivate your account to create templates.",
            },
        )
    current_count = db.query(Template).filter(Template.user_id == user.id).count()
    if not ent.under_quota("templates_max", current_count):
        raise HTTPException(
            402,
            detail={
                "code": "quota_exceeded",
                "limit": "templates_max",
                "cap": ent.quota("templates_max"),
                "message": f"You've reached your {ent.quota('templates_max')}-template limit. Upgrade to Pro for unlimited templates.",
            },
        )

    try:
        gen = pdf_generator.generate(
            artboard_w=payload.artboard.width,
            artboard_h=payload.artboard.height,
            units=payload.artboard.units,
            shape_kind=payload.shape.kind,
            shape_w=payload.shape.width,
            shape_h=payload.shape.height,
            gap_x=payload.shape.gap_x,
            gap_y=payload.shape.gap_y,
            center=payload.shape.center,
            edge_margin=payload.shape.edge_margin,
            spacing_mode=payload.shape.spacing_mode,
            corner_radius=payload.shape.corner_radius,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc))

    if not gen.shapes:
        raise HTTPException(422, "Generated template contained no shapes (artboard too small for shape size)")

    template_id = uuid.uuid4()
    r2_key = f"users/{user.id}/templates/{template_id}/source.pdf"
    try:
        storage.put_bytes(r2_key, gen.pdf_bytes, content_type="application/pdf")
    except storage.StorageNotConfigured as exc:
        raise HTTPException(503, str(exc))

    tpl = Template(
        id=template_id,
        user_id=user.id,
        name=payload.name,
        source="generated",
        units=payload.artboard.units,
        r2_key=r2_key,
        page_width=gen.page_width,
        page_height=gen.page_height,
        positions_layer="POSITIONS",
        has_ocg=True,
        shapes=gen.shapes,
        generation_params=payload.model_dump(),
    )
    db.add(tpl)
    db.commit()
    db.refresh(tpl)
    return tpl


@router.patch("/{template_id}", response_model=TemplateOut)
def update_template(
    template_id: uuid.UUID,
    payload: TemplateUpdate,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Template:
    user = _resolve_user(db, auth)
    tpl = db.query(Template).filter(
        Template.id == template_id, Template.user_id == user.id
    ).one_or_none()
    if tpl is None:
        raise HTTPException(404, "Template not found")

    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(tpl, k, v)
    db.commit()
    db.refresh(tpl)
    return tpl


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_template(
    template_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    user = _resolve_user(db, auth)
    tpl = db.query(Template).filter(
        Template.id == template_id, Template.user_id == user.id
    ).one_or_none()
    if tpl is None:
        raise HTTPException(404, "Template not found")
    try:
        storage.delete(tpl.r2_key)
    except Exception:
        pass
    db.delete(tpl)
    db.commit()


@router.get("/{template_id}/download")
def download_template(
    template_id: uuid.UUID,
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, str | int]:
    user = _resolve_user(db, auth)
    tpl = db.query(Template).filter(
        Template.id == template_id, Template.user_id == user.id
    ).one_or_none()
    if tpl is None:
        raise HTTPException(404, "Template not found")
    safe_name = "".join(c if c.isalnum() or c in "-_." else "-" for c in tpl.name)
    url = storage.presigned_get(tpl.r2_key, expires_in=3600, download_filename=f"{safe_name}.pdf")
    return {"url": url, "expires_in": 3600}
