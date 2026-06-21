"""Embeddable sticker-builder widget API (`/api/v1/widget`).

Two auth realms, never mixed:

- **Merchant API key** (``Authorization: Bearer pl_live_...``) — used server-side
  by the store plugin to mint a short-lived session for one product. Only
  `POST /sessions` uses this.
- **Widget session token** — minted above, handed to the iframe. Every customer
  facing call (`config`, `process`, `regenerate`, `edit-cutline`, `estimate`,
  `finalize`) authenticates with it. The customer never sees the API key.

The processing endpoints reuse the same `sticker_processor` pipeline as the
in-app editor; the only differences are auth, per-merchant storage keys, and
that the widget always produces ONE sticker (quantity is for ordering — the
merchant gangs the copies later in Printlay).

CORS for this prefix is handled by the per-merchant middleware in `main.py`.
"""
from __future__ import annotations

import json
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.auth.api_key import MerchantContext, get_merchant_from_api_key
from backend.auth.widget_token import (
    SESSION_TTL_S,
    make_session_token,
    read_quote,
    read_session_token,
    sign_quote,
)
from backend.database import get_db
from backend.models import PricingProfile, PrintOrder, Product, WidgetSession
from backend.services import pricing_engine, storage
from backend.routers.sticker import (
    MAX_UPLOAD_BYTES,
    ProcessResponse,
    _get_usage,
    _heavy_job_slot,
    _increment_usage,
    _normalised_points,
    _resolve_sticker_category,
    _safe_presigned,
)

router = APIRouter(prefix="/api/v1/widget", tags=["widget"])

DEFAULT_CUT_STYLES = ["die_cut", "face", "keep_bg", "square", "circle"]
DEFAULT_QTY_PRESETS = [10, 30, 50, 100, 200, 300, 500, 750, 1000, 2500]

# Widget cut-style → cutline_generator mode.
_CUT_STYLE_TO_MODE = {
    "die_cut": "contour",
    "face": "face",
    "keep_bg": "rectangle",  # cut-out: keep the uploaded image, rectangle cut line
    "square": "rectangle",
    "circle": "ellipse",
}

_bearer = HTTPBearer(auto_error=False)


def _prefix(merchant_id: uuid.UUID, session_id: uuid.UUID) -> str:
    return f"widget-sessions/{merchant_id}/{session_id}"


def _rounded_rect_points(
    w: float, h: float, r: float, per_corner: int = 10
) -> list[tuple[float, float]]:
    """Polygon tracing a rounded rectangle (0,0)->(w,h), clockwise, for use as a
    sticker cut contour. `r` is the corner radius in px, clamped to half the
    shorter side."""
    import math

    r = max(0.0, min(r, min(w, h) / 2.0))
    if r <= 0.5:
        return [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)]

    # Centres of the four corner arcs.
    corners = [
        (w - r, r, -math.pi / 2, 0.0),       # top-right
        (w - r, h - r, 0.0, math.pi / 2),    # bottom-right
        (r, h - r, math.pi / 2, math.pi),    # bottom-left
        (r, r, math.pi, 3 * math.pi / 2),    # top-left
    ]
    pts: list[tuple[float, float]] = []
    for cx, cy, a0, a1 in corners:
        for i in range(per_corner + 1):
            a = a0 + (a1 - a0) * (i / per_corner)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def _record_draft_order(
    db: Session,
    ctx: "WidgetSessionContext",
    *,
    asset_id: uuid.UUID,
    options: dict,
    total,
    currency,
    quantity,
    proof_requested: bool = False,
    customer_email: str | None = None,
    proof_note: str | None = None,
    proof_fee: float = 0.0,
) -> None:
    """Drop a finished design into the merchant's order queue as a `draft`.

    This is created at add-to-cart (finalize) so merchants get a single place to
    see incoming designs and jump straight to ganging them onto a sheet, even
    before the store's paid-order webhook is wired up.

    A design completed from the merchant's own admin preview
    (``external_ref == 'admin-preview'``) is recorded as a clearly-labelled
    **test** order so they can rehearse the full back-end flow (open on sheet,
    gang up, mark printed) without a live store. Keyed by the session token so a
    session yields one order.
    """
    is_test = ctx.session.external_ref == "admin-preview"
    qty = max(1, int(quantity or 1))
    total_f = round(float(total or 0.0) + (proof_fee if proof_requested else 0.0), 2)
    line_item = {
        "asset_id": str(asset_id),
        "session_token": ctx.session.token,
        "options": options or {},
        "qty": qty,
        "unit_price": round(total_f / qty, 4),
        "test": is_test,
    }
    external_order_id = (
        f"TEST-{ctx.session.token[:8]}" if is_test else ctx.session.token
    )
    existing = (
        db.query(PrintOrder)
        .filter(
            PrintOrder.platform == "widget",
            PrintOrder.external_order_id == external_order_id,
        )
        .one_or_none()
    )
    if existing is not None:
        existing.line_items = [line_item]
        existing.amount_total = total_f
        existing.currency = currency or "GBP"
        if proof_requested:
            existing.proof_status = "awaiting_proof"
            existing.customer_email = customer_email
            existing.proof_notes = proof_note
            existing.proof_token = existing.proof_token or str(uuid.uuid4())[:32]
        return

    if is_test:
        test_count = (
            db.query(PrintOrder)
            .filter(
                PrintOrder.user_id == ctx.merchant_id,
                PrintOrder.platform == "widget",
                PrintOrder.external_order_id.like("TEST-%"),
            )
            .count()
        )
        customer_ref = f"Test order {test_count + 1}"
    else:
        customer_ref = ctx.session.external_ref or None

    order_kwargs: dict = dict(
        user_id=ctx.merchant_id,
        platform="widget",
        external_order_id=external_order_id,
        customer_ref=customer_ref,
        line_items=[line_item],
        amount_total=total_f,
        currency=currency or "GBP",
        status="draft",
    )
    if proof_requested:
        order_kwargs["proof_status"] = "awaiting_proof"
        order_kwargs["customer_email"] = customer_email
        order_kwargs["proof_notes"] = proof_note
        order_kwargs["proof_token"] = str(uuid.uuid4())[:32]
        order_kwargs["proof_history"] = [
            {"action": "requested", "timestamp": datetime.utcnow().isoformat(), "by": "customer", "message": proof_note or ""}
        ]

    db.add(PrintOrder(**order_kwargs))


# --------------------------------------------------------------------------- #
# Session-token auth dependency
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class WidgetSessionContext:
    session: WidgetSession
    product: Product
    merchant_id: uuid.UUID


def get_widget_session(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> WidgetSessionContext:
    if creds is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Missing session token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    payload = read_session_token(creds.credentials)  # raises 401 on bad/expired
    sid = payload.get("sid")
    sess = (
        db.query(WidgetSession)
        .filter(WidgetSession.token == sid)
        .one_or_none()
    )
    if sess is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session not found")
    if sess.status != "open":
        raise HTTPException(status.HTTP_409_CONFLICT, "This design session is closed")
    if sess.expires_at and sess.expires_at < datetime.now(timezone.utc):
        sess.status = "expired"
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")

    product = (
        db.query(Product)
        .filter(Product.id == sess.product_id, Product.is_active.is_(True))
        .one_or_none()
    )
    if product is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found or inactive")

    return WidgetSessionContext(session=sess, product=product, merchant_id=sess.user_id)


# --------------------------------------------------------------------------- #
# Product config helpers
# --------------------------------------------------------------------------- #
class ProductConfig(BaseModel):
    id: str
    name: str
    mode: str  # 'flexible' | 'fixed' (fixed preset support lands with its migration)
    designer: str  # 'cutout' | 'canvas' — which design experience the iframe renders
    enabled_cut_styles: list[str]
    min_size_mm: float
    max_size_mm: float
    size_presets: list[dict] = []
    allow_custom_size: bool = True
    corner_radius: float = 0.01
    vinyl_types: list[dict] = []
    finishes: list[dict] = []
    bleed_mm: float
    safe_mm: float
    currency: str
    show_filters: bool = True
    show_ai_styles: bool = False
    show_hand_edit: bool = False
    require_proof: bool = False
    proof_fee: float = 0.0
    quantity_presets: list[int] = []
    allow_custom_quantity: bool = True


def _pricing_profile(db: Session, product: Product) -> PricingProfile | None:
    if not product.pricing_profile_id:
        return None
    return (
        db.query(PricingProfile)
        .filter(PricingProfile.id == product.pricing_profile_id)
        .one_or_none()
    )


def _product_config(product: Product, profile: PricingProfile | None) -> ProductConfig:
    styles = product.enabled_cut_styles or DEFAULT_CUT_STYLES

    # Only include materials/finishes that exist in the linked profile
    vinyl_types = product.vinyl_types or []
    finishes = product.finishes or []
    if profile:
        valid_vinyl_keys = set((profile.vinyl_surcharges or {}).keys())
        valid_finish_keys = set((profile.finish_surcharges or {}).keys())
        if valid_vinyl_keys:
            vinyl_types = [v for v in vinyl_types if v.get("key") in valid_vinyl_keys]
        if valid_finish_keys:
            finishes = [f for f in finishes if f.get("key") in valid_finish_keys]

    return ProductConfig(
        id=str(product.id),
        name=product.name,
        mode="flexible",
        designer=getattr(product, "designer", "cutout") or "cutout",
        enabled_cut_styles=[s for s in styles if s in DEFAULT_CUT_STYLES] or DEFAULT_CUT_STYLES,
        min_size_mm=product.min_size_mm,
        max_size_mm=product.max_size_mm,
        size_presets=getattr(product, "size_presets", None) or [],
        allow_custom_size=getattr(product, "allow_custom_size", True),
        corner_radius=getattr(product, "corner_radius", 0.01),
        vinyl_types=vinyl_types,
        finishes=finishes,
        bleed_mm=product.bleed_mm,
        safe_mm=product.safe_mm,
        currency=(profile.currency if profile else "GBP"),
        show_filters=getattr(product, "show_filters", True),
        show_ai_styles=getattr(product, "show_ai_styles", False),
        show_hand_edit=getattr(product, "show_hand_edit", False),
        require_proof=getattr(product, "require_proof", False),
        proof_fee=getattr(product, "proof_fee", 0.0),
        quantity_presets=(profile.quantity_presets if profile and profile.quantity_presets else DEFAULT_QTY_PRESETS),
        allow_custom_quantity=(profile.allow_custom_quantity if profile else True),
    )


# --------------------------------------------------------------------------- #
# 1) Create a session (merchant API key)
# --------------------------------------------------------------------------- #
class PluginProductOut(BaseModel):
    id: str
    name: str
    designer: str
    is_active: bool


@router.get("/products", response_model=list[PluginProductOut])
def list_products_for_plugin(
    ctx: MerchantContext = Depends(get_merchant_from_api_key),
    db: Session = Depends(get_db),
):
    """List the merchant's active products (API-key auth).

    Used by the WooCommerce/Shopify plugin settings page to populate
    the product-linking dropdown.
    """
    products = (
        db.query(Product)
        .filter(Product.user_id == ctx.user.id, Product.is_active.is_(True))
        .order_by(Product.name)
        .all()
    )
    return [
        PluginProductOut(
            id=str(p.id),
            name=p.name,
            designer=p.designer,
            is_active=p.is_active,
        )
        for p in products
    ]


class CreateSessionRequest(BaseModel):
    product_id: str
    external_ref: str | None = None


class CreateSessionResponse(BaseModel):
    session_token: str
    expires_in: int
    product: ProductConfig


@router.post("/sessions", response_model=CreateSessionResponse)
def create_session(
    body: CreateSessionRequest,
    ctx: MerchantContext = Depends(get_merchant_from_api_key),
    db: Session = Depends(get_db),
):
    """Mint a short-lived design session for one of the merchant's products.

    Called server-side by the plugin (which holds the API key). The returned
    session token is what the iframe is loaded with.
    """
    try:
        product_uuid = uuid.UUID(body.product_id)
    except (ValueError, TypeError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid product id")

    product = (
        db.query(Product)
        .filter(
            Product.id == product_uuid,
            Product.user_id == ctx.user.id,
            Product.is_active.is_(True),
        )
        .one_or_none()
    )
    if product is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found")

    token = secrets.token_urlsafe(32)
    sess = WidgetSession(
        user_id=ctx.user.id,
        product_id=product.id,
        token=token,
        external_ref=body.external_ref,
        status="open",
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=SESSION_TTL_S),
    )
    db.add(sess)
    db.commit()
    db.refresh(sess)

    session_token = make_session_token(
        session_id=token,
        merchant_id=str(ctx.user.id),
        product_id=str(product.id),
    )
    profile = _pricing_profile(db, product)
    return CreateSessionResponse(
        session_token=session_token,
        expires_in=SESSION_TTL_S,
        product=_product_config(product, profile),
    )


# --------------------------------------------------------------------------- #
# 2) Config (session token) — re-fetch product options inside the iframe
# --------------------------------------------------------------------------- #
@router.get("/config", response_model=ProductConfig)
def get_config(
    ctx: WidgetSessionContext = Depends(get_widget_session),
    db: Session = Depends(get_db),
):
    profile = _pricing_profile(db, ctx.product)
    return _product_config(ctx.product, profile)


# --------------------------------------------------------------------------- #
# Shared persistence of a processed sticker into the session's storage
# --------------------------------------------------------------------------- #
def _persist_result(prefix: str, result, mode: str | None = None) -> None:
    storage.put_bytes(f"{prefix}/preview.png", result.preview_png, "image/png")
    storage.put_bytes(f"{prefix}/border.png", result.border_png, "image/png")
    if getattr(result, "cutout_png", None):
        storage.put_bytes(f"{prefix}/cutout.png", result.cutout_png, "image/png")
    payload = {
        "points_px": [list(p) for p in result.cutline.points_px],
        "points_pt": [list(p) for p in result.cutline.points_pt],
        "width_px": result.cutline.width_px,
        "height_px": result.cutline.height_px,
        "width_pt": result.cutline.width_pt,
        "height_pt": result.cutline.height_pt,
        "width_mm": result.width_mm,
        "height_mm": result.height_mm,
        "work_dpi": getattr(result, "work_dpi", 300.0),
        # Cut-line mode the cached cutout was produced with. Lets `regenerate`
        # know whether the cutout has its background removed ("contour"/"face")
        # or kept ("rectangle"), so switching between Keep-background and a
        # die-cut/face style correctly re-processes from the original upload.
        "mode": mode,
    }
    storage.put_bytes(
        f"{prefix}/cutline.json", json.dumps(payload).encode("utf-8"), "application/json"
    )


def _process_response(prefix: str, result, session_token_sid: str) -> ProcessResponse:
    return ProcessResponse(
        preview_url=storage.presigned_get(f"{prefix}/preview.png"),
        border_url=storage.presigned_get(f"{prefix}/border.png"),
        cutout_url=_safe_presigned(f"{prefix}/cutout.png"),
        width_mm=result.width_mm,
        height_mm=result.height_mm,
        bg_type=result.bg_type,
        removal_method=result.removal_method,
        session_id=session_token_sid,
        cutline_points=_normalised_points(
            result.cutline.points_px, result.cutline.width_px, result.cutline.height_px
        ),
        img_w_px=result.cutline.width_px,
        img_h_px=result.cutline.height_px,
    )


def _validate_cut_style(product: Product, cut_style: str) -> str:
    allowed = product.enabled_cut_styles or DEFAULT_CUT_STYLES
    if cut_style not in _CUT_STYLE_TO_MODE or cut_style not in allowed:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Cut style '{cut_style}' is not available for this product",
        )
    return _CUT_STYLE_TO_MODE[cut_style]


def _charge_bg_quota_if_needed(
    db: Session, ctx: "WidgetSessionContext", raw: bytes, mode: str
) -> None:
    """Count an AI background removal against the merchant's monthly quota when
    the chosen mode actually removes the background. The geometric "rectangle"
    (Keep-background) mode keeps the upload as-is, and transparent/solid-colour
    images don't need the paid AI model, so none of those are charged."""
    if mode == "rectangle":
        return
    from backend.services.bg_removal import detect_background

    if detect_background(raw) in ("transparent", "solid"):
        return

    from backend.models import User
    from backend.services import entitlements

    merchant = db.query(User).filter(User.id == ctx.merchant_id).one()
    ent = entitlements.for_user(merchant)
    limit = ent.quota("bg_removals_per_month")
    current = _get_usage(db, ctx.merchant_id)
    if limit is not None and current >= limit:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "This store has reached its monthly design limit. Please try again later.",
        )
    _increment_usage(db, ctx.merchant_id)


# --------------------------------------------------------------------------- #
# 3) Process — upload + background removal + cut line (session token)
# --------------------------------------------------------------------------- #
@router.post("/process", response_model=ProcessResponse)
def process(
    file: UploadFile = File(...),
    cut_style: str = Form("die_cut"),
    filter_id: str = Form("none"),
    corner_radius: float = Form(0.01),
    ctx: WidgetSessionContext = Depends(get_widget_session),
    db: Session = Depends(get_db),
):
    mode = _validate_cut_style(ctx.product, cut_style)

    raw = file.file.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "File too large (max 25 MB)")

    from backend.services.cutline_generator import FaceNotFoundError
    from backend.services.sticker_processor import process_sticker as do_process
    from backend.services.bg_removal import normalise_orientation

    raw = normalise_orientation(raw)

    # Count AI background removals against the merchant's monthly quota (they
    # pay for the widget). Keep-background ("rectangle") keeps the upload as-is.
    _charge_bg_quota_if_needed(db, ctx, raw, mode)

    prefix = _prefix(ctx.merchant_id, ctx.session.id)
    storage.put_bytes(f"{prefix}/source.png", raw, file.content_type or "image/png")

    with _heavy_job_slot("widget-process"):
        try:
            result = do_process(
                image_bytes=raw,
                removal_method=None,  # process_sticker auto-detects + picks method
                border_width_mm=2.0,
                bleed_mm=ctx.product.bleed_mm,
                cutline_mode=mode,
                cutline_precision="medium",
                filter_id=filter_id,
                corner_radius_frac=corner_radius if mode == "rectangle" else None,
            )
        except FaceNotFoundError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))
        except Exception as exc:
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"Processing failed: {exc}")

    _persist_result(prefix, result, mode=mode)
    ctx.session.params = {"cut_style": cut_style, "filter_id": filter_id}
    db.commit()

    return _process_response(prefix, result, ctx.session.token)


# --------------------------------------------------------------------------- #
# 4) Regenerate — change cut style / tighten / filter without re-upload
# --------------------------------------------------------------------------- #
class RegenerateRequest(BaseModel):
    cut_style: str = "die_cut"
    tighten: float = 0.0  # mm: + closer to subject, - looser
    filter_id: str = "none"
    corner_radius: float = 0.01  # rectangle (keep-bg) corner radius, 0..1 of half short side


@router.post("/regenerate", response_model=ProcessResponse)
def regenerate(
    body: RegenerateRequest,
    ctx: WidgetSessionContext = Depends(get_widget_session),
    db: Session = Depends(get_db),
):
    mode = _validate_cut_style(ctx.product, body.cut_style)
    prefix = _prefix(ctx.merchant_id, ctx.session.id)
    try:
        cutout = storage.get_bytes(f"{prefix}/cutout.png")
    except Exception:
        raise HTTPException(404, "Design session expired. Please re-upload.")

    work_dpi = 300.0
    prev_mode: str | None = None
    has_custom_points = False
    custom_meta: dict | None = None
    try:
        meta = json.loads(storage.get_bytes(f"{prefix}/cutline.json").decode("utf-8"))
        work_dpi = float(meta.get("work_dpi", 300.0))
        prev_mode = meta.get("mode")
        has_custom_points = bool(meta.get("custom_points"))
        if has_custom_points:
            custom_meta = meta
    except Exception:
        work_dpi = 300.0

    from backend.services.cutline_generator import FaceNotFoundError
    from backend.services.sticker_processor import process_sticker, regenerate_cutline

    border = max(-3.0, min(6.0, 2.0 - body.tighten))

    # Switching into or out of Keep-background changes whether the background is
    # removed, so the cached cutout (which is either the original image or the
    # cut-out subject) is wrong — re-run the full pipeline from the original
    # upload. Within the same bg-handling, regenerate cheaply off the cutout.
    bg_handling_changed = (prev_mode == "rectangle") != (mode == "rectangle")

    with _heavy_job_slot("widget-regenerate"):
        try:
            if bg_handling_changed:
                try:
                    source = storage.get_bytes(f"{prefix}/source.png")
                except Exception:
                    raise HTTPException(404, "Design session expired. Please re-upload.")
                _charge_bg_quota_if_needed(db, ctx, source, mode)
                result = process_sticker(
                    image_bytes=source,
                    removal_method=None,
                    border_width_mm=border,
                    bleed_mm=ctx.product.bleed_mm,
                    cutline_mode=mode,
                    cutline_precision="medium",
                    filter_id=body.filter_id,
                    corner_radius_frac=body.corner_radius if mode == "rectangle" else None,
                )
            else:
                result = regenerate_cutline(
                    cutout_bytes=cutout,
                    border_width_mm=border,
                    bleed_mm=ctx.product.bleed_mm,
                    dpi=work_dpi,
                    cutline_mode=mode,
                    cutline_precision="medium",
                    filter_id=body.filter_id,
                    corner_radius_frac=body.corner_radius if mode == "rectangle" else None,
                )
        except FaceNotFoundError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"Regeneration failed: {exc}")

    _persist_result(prefix, result, mode=mode)

    # If the user had hand-edited the cutline and only the filter/tighten changed
    # (not switching modes), restore their custom cutline on the new artwork.
    if has_custom_points and custom_meta and not bg_handling_changed:
        from backend.services.cutline_generator import CutlineResult
        from backend.services.sticker_processor import _render_preview

        width_px = int(custom_meta["width_px"])
        height_px = int(custom_meta["height_px"])
        width_pt = float(custom_meta["width_pt"])
        height_pt = float(custom_meta["height_pt"])

        cutline = CutlineResult(
            points_px=[(float(p[0]), float(p[1])) for p in custom_meta["points_px"]],
            points_pt=[(float(p[0]), float(p[1])) for p in custom_meta["points_pt"]],
            width_px=width_px,
            height_px=height_px,
            width_pt=width_pt,
            height_pt=height_pt,
            border_image=result.border_png,
        )
        preview_png = _render_preview(cutline)
        storage.put_bytes(f"{prefix}/preview.png", preview_png, "image/png")

        payload = {
            "points_px": custom_meta["points_px"],
            "points_pt": custom_meta["points_pt"],
            "width_px": width_px,
            "height_px": height_px,
            "width_pt": width_pt,
            "height_pt": height_pt,
            "width_mm": custom_meta.get("width_mm", result.width_mm),
            "height_mm": custom_meta.get("height_mm", result.height_mm),
            "work_dpi": custom_meta.get("work_dpi", work_dpi),
            "mode": mode,
            "custom_points": True,
        }
        storage.put_bytes(
            f"{prefix}/cutline.json", json.dumps(payload).encode("utf-8"), "application/json"
        )

        ctx.session.params = {"cut_style": body.cut_style, "filter_id": body.filter_id}
        db.commit()
        return ProcessResponse(
            preview_url=storage.presigned_get(f"{prefix}/preview.png"),
            border_url=storage.presigned_get(f"{prefix}/border.png"),
            cutout_url=_safe_presigned(f"{prefix}/cutout.png"),
            width_mm=result.width_mm,
            height_mm=result.height_mm,
            bg_type=result.bg_type,
            removal_method=result.removal_method,
            session_id=ctx.session.token,
            cutline_points=_normalised_points(cutline.points_px, width_px, height_px),
            img_w_px=width_px,
            img_h_px=height_px,
        )

    ctx.session.params = {"cut_style": body.cut_style, "filter_id": body.filter_id}
    db.commit()
    return _process_response(prefix, result, ctx.session.token)


# --------------------------------------------------------------------------- #
# 5) Edit cut line by hand (session token)
# --------------------------------------------------------------------------- #
class EditCutlineRequest(BaseModel):
    points: list[list[float]]  # closed polygon, normalised 0..1


@router.post("/edit-cutline", response_model=ProcessResponse)
def edit_cutline(
    body: EditCutlineRequest,
    ctx: WidgetSessionContext = Depends(get_widget_session),
):
    if len(body.points) < 3:
        raise HTTPException(400, "A cut path needs at least 3 points")

    prefix = _prefix(ctx.merchant_id, ctx.session.id)
    try:
        border_png = storage.get_bytes(f"{prefix}/border.png")
        meta = json.loads(storage.get_bytes(f"{prefix}/cutline.json").decode("utf-8"))
    except Exception:
        raise HTTPException(404, "Design session expired. Please re-process.")

    width_px = int(meta["width_px"])
    height_px = int(meta["height_px"])
    width_pt = float(meta["width_pt"])
    height_pt = float(meta["height_pt"])
    width_mm = float(meta["width_mm"])
    height_mm = float(meta["height_mm"])

    points_px = [
        (max(0.0, min(1.0, float(nx))) * width_px, max(0.0, min(1.0, float(ny))) * height_px)
        for nx, ny in body.points
    ]

    from backend.services.cutline_generator import (
        CutlineResult,
        _chaikin_smooth,
        _enforce_min_corner_radius,
        _smooth_oscillating_regions,
    )
    from backend.services.sticker_processor import _render_preview

    dpi = width_px * 25.4 / width_mm if width_mm > 0 else 300
    bleed_mm = 3.0
    bleed_px = int(bleed_mm * dpi / 25.4)
    try:
        points_px = _smooth_oscillating_regions(
            points_px, iterations=10, window=6, wiggle_threshold=0.3, strength=0.55
        )
        points_px = _chaikin_smooth(points_px, iterations=3)
        points_px = _enforce_min_corner_radius(points_px, dpi=int(dpi), min_radius_mm=1.0)
    except Exception:
        pass

    # Re-crop border image to new cutline bounds + bleed
    from PIL import Image as _PILImage
    import io as _io
    border_pil = _PILImage.open(_io.BytesIO(border_png)).convert("RGBA")
    min_cx = min(p[0] for p in points_px)
    min_cy = min(p[1] for p in points_px)
    max_cx = max(p[0] for p in points_px)
    max_cy = max(p[1] for p in points_px)
    c_x1 = max(0, int(min_cx) - bleed_px)
    c_y1 = max(0, int(min_cy) - bleed_px)
    c_x2 = min(width_px, int(max_cx) + bleed_px + 1)
    c_y2 = min(height_px, int(max_cy) + bleed_px + 1)
    if c_x1 > 0 or c_y1 > 0 or c_x2 < width_px or c_y2 < height_px:
        points_px = [(x - c_x1, y - c_y1) for x, y in points_px]
        border_pil = border_pil.crop((c_x1, c_y1, c_x2, c_y2))
        width_px = c_x2 - c_x1
        height_px = c_y2 - c_y1
        alpha_bbox = border_pil.getbbox()
        if alpha_bbox and (alpha_bbox[0] > 0 or alpha_bbox[1] > 0
                          or alpha_bbox[2] < width_px or alpha_bbox[3] < height_px):
            points_px = [(x - alpha_bbox[0], y - alpha_bbox[1]) for x, y in points_px]
            border_pil = border_pil.crop(alpha_bbox)
            width_px = alpha_bbox[2] - alpha_bbox[0]
            height_px = alpha_bbox[3] - alpha_bbox[1]
        buf = _io.BytesIO()
        border_pil.save(buf, format="PNG")
        border_png = buf.getvalue()
        storage.put_bytes(f"{prefix}/border.png", border_png, "image/png")
        px_to_pt = 72.0 / dpi
        width_pt = width_px * px_to_pt
        height_pt = height_px * px_to_pt
        width_mm = width_pt * 25.4 / 72.0
        height_mm = height_pt * 25.4 / 72.0

    px_to_pt_x = width_pt / width_px if width_px else 0.0
    px_to_pt_y = height_pt / height_px if height_px else 0.0
    points_pt = [(x * px_to_pt_x, y * px_to_pt_y) for x, y in points_px]

    cutline = CutlineResult(
        points_px=[(float(x), float(y)) for x, y in points_px],
        points_pt=[(float(x), float(y)) for x, y in points_pt],
        width_px=width_px,
        height_px=height_px,
        width_pt=width_pt,
        height_pt=height_pt,
        border_image=border_png,
    )
    preview_png = _render_preview(cutline)
    storage.put_bytes(f"{prefix}/preview.png", preview_png, "image/png")
    storage.put_bytes(
        f"{prefix}/cutline.json",
        json.dumps(
            {
                "points_px": [list(p) for p in cutline.points_px],
                "points_pt": [list(p) for p in cutline.points_pt],
                "width_px": width_px,
                "height_px": height_px,
                "width_pt": width_pt,
                "height_pt": height_pt,
                "width_mm": width_mm,
                "height_mm": height_mm,
                "custom_points": True,
            }
        ).encode("utf-8"),
        "application/json",
    )

    return ProcessResponse(
        preview_url=storage.presigned_get(f"{prefix}/preview.png"),
        border_url=storage.presigned_get(f"{prefix}/border.png"),
        cutout_url=_safe_presigned(f"{prefix}/cutout.png"),
        width_mm=width_mm,
        height_mm=height_mm,
        bg_type="transparent",
        removal_method=None,
        session_id=ctx.session.token,
        cutline_points=_normalised_points(cutline.points_px, width_px, height_px),
        img_w_px=width_px,
        img_h_px=height_px,
    )


# --------------------------------------------------------------------------- #
# 5b) AI style — redraw in an illustration style (session token)
# --------------------------------------------------------------------------- #
class AIStyleWidgetRequest(BaseModel):
    style: str = "cartoon"
    custom_prompt: str | None = None


@router.post("/ai-style", response_model=ProcessResponse)
def widget_ai_style(
    body: AIStyleWidgetRequest,
    ctx: WidgetSessionContext = Depends(get_widget_session),
    db: Session = Depends(get_db),
):
    """Apply an AI illustration style using the merchant's OpenAI key."""
    from backend.services import ai_stylize, secrets_store
    from backend.models import User

    merchant = db.query(User).filter(User.id == ctx.merchant_id).one_or_none()
    if not merchant:
        raise HTTPException(404, "Merchant account not found.")
    api_key = secrets_store.decrypt_value(merchant.openai_api_key_enc)
    if not api_key:
        raise HTTPException(400, "AI styles are not configured for this store.")

    if not getattr(ctx.product, "show_ai_styles", False):
        raise HTTPException(403, "AI styles are not enabled for this product.")

    if body.style == "custom":
        if not (body.custom_prompt or "").strip():
            raise HTTPException(400, "Enter a description for your custom AI style.")
    elif body.style not in ai_stylize.STYLE_PROMPTS:
        raise HTTPException(400, f"Unknown AI style: {body.style}")

    prefix = _prefix(ctx.merchant_id, ctx.session.id)
    try:
        cutout = storage.get_bytes(f"{prefix}/cutout.png")
    except Exception:
        raise HTTPException(404, "Design session expired. Please re-upload.")

    work_dpi = 300.0
    try:
        meta = json.loads(storage.get_bytes(f"{prefix}/cutline.json").decode("utf-8"))
        work_dpi = float(meta.get("work_dpi", 300.0))
    except Exception:
        work_dpi = 300.0

    from PIL import Image as PILImage
    import io as _io

    try:
        orig = PILImage.open(_io.BytesIO(cutout)).convert("RGBA")
        orig_w, orig_h = orig.size
    except Exception:
        orig_w, orig_h = 0, 0

    try:
        stylized = ai_stylize.stylize_image(
            cutout, body.style, api_key, custom_prompt=body.custom_prompt
        )
    except RuntimeError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))
    except Exception as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"AI style failed: {exc}")

    from backend.routers.sticker import _fit_into

    new_cutout = _fit_into(stylized, orig_w, orig_h)
    storage.put_bytes(f"{prefix}/cutout.png", new_cutout, "image/png")

    params = ctx.session.params or {}
    cut_style = params.get("cut_style", "die_cut")
    mode = _CUT_STYLE_TO_MODE.get(cut_style, "contour")

    from backend.services.cutline_generator import FaceNotFoundError
    from backend.services.sticker_processor import regenerate_cutline

    border = 2.0
    with _heavy_job_slot("widget-ai-style"):
        try:
            result = regenerate_cutline(
                cutout_bytes=new_cutout,
                border_width_mm=border,
                bleed_mm=ctx.product.bleed_mm,
                dpi=work_dpi,
                cutline_mode=mode,
                cutline_precision="medium",
            )
        except FaceNotFoundError:
            # AI-styled image may not have a detectable face — fallback to contour
            result = regenerate_cutline(
                cutout_bytes=new_cutout,
                border_width_mm=border,
                bleed_mm=ctx.product.bleed_mm,
                dpi=work_dpi,
                cutline_mode="contour",
                cutline_precision="medium",
            )
            mode = "contour"
        except Exception as exc:
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"AI style failed: {exc}")

    _persist_result(prefix, result, mode=mode)
    ctx.session.params = {**params, "filter_id": "none"}
    db.commit()
    return _process_response(prefix, result, ctx.session.token)


# --------------------------------------------------------------------------- #
# 6) Estimate — signed, tamper-proof price quote (session token)
# --------------------------------------------------------------------------- #
class EstimateRequest(BaseModel):
    width_mm: float
    height_mm: float
    quantity: int
    cut_style: str = "die_cut"
    vinyl: str | None = None
    finish: str | None = None
    corner_radius: float = 0.01  # 0..1; cosmetic, carried through to the cut line


class EstimateResponse(BaseModel):
    breakdown: dict
    quote_token: str


def _validate_size(product: Product, width_mm: float, height_mm: float) -> None:
    lo, hi = product.min_size_mm, product.max_size_mm
    for dim in (width_mm, height_mm):
        if dim < lo - 0.01 or dim > hi + 0.01:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Size must be between {lo:g} mm and {hi:g} mm",
            )


@router.post("/estimate", response_model=EstimateResponse)
def estimate(
    body: EstimateRequest,
    ctx: WidgetSessionContext = Depends(get_widget_session),
    db: Session = Depends(get_db),
):
    _validate_cut_style(ctx.product, body.cut_style)
    _validate_size(ctx.product, body.width_mm, body.height_mm)
    if body.quantity < 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Quantity must be at least 1")

    profile = _pricing_profile(db, ctx.product)
    if profile is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This product has no pricing set up yet. Please contact the store.",
        )

    inputs = pricing_engine.inputs_from_profile(profile, vinyl=body.vinyl, finish=body.finish)
    breakdown = pricing_engine.estimate(
        inputs,
        currency=profile.currency,
        width_mm=body.width_mm,
        height_mm=body.height_mm,
        quantity=body.quantity,
        quantity_breaks=profile.quantity_breaks,
    )

    quote_token = sign_quote(
        {
            "sid": ctx.session.token,
            "mid": str(ctx.merchant_id),
            "pid": str(ctx.product.id),
            "total": breakdown.total,
            "currency": breakdown.currency,
            "quantity": breakdown.quantity,
            "options": {
                "cut_style": body.cut_style,
                "width_mm": body.width_mm,
                "height_mm": body.height_mm,
                "vinyl": body.vinyl,
                "finish": body.finish,
                "corner_radius": max(0.0, min(1.0, float(body.corner_radius))),
            },
        }
    )
    return EstimateResponse(breakdown=breakdown.to_dict(), quote_token=quote_token)


class EstimateBatchRequest(BaseModel):
    width_mm: float
    height_mm: float
    quantities: list[int]
    cut_style: str = "die_cut"
    vinyl: str | None = None
    finish: str | None = None


class EstimateBatchItem(BaseModel):
    quantity: int
    unit_price: float
    total: float


@router.post("/estimate-batch", response_model=list[EstimateBatchItem])
def estimate_batch(
    body: EstimateBatchRequest,
    ctx: WidgetSessionContext = Depends(get_widget_session),
    db: Session = Depends(get_db),
):
    """Return unit prices for multiple quantities at once (for radio button labels)."""
    _validate_cut_style(ctx.product, body.cut_style)
    _validate_size(ctx.product, body.width_mm, body.height_mm)

    profile = _pricing_profile(db, ctx.product)
    if profile is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This product has no pricing set up yet. Please contact the store.",
        )

    inputs = pricing_engine.inputs_from_profile(profile, vinyl=body.vinyl, finish=body.finish)
    results: list[EstimateBatchItem] = []
    for qty in body.quantities:
        if qty < 1:
            continue
        bd = pricing_engine.estimate(
            inputs,
            currency=profile.currency,
            width_mm=body.width_mm,
            height_mm=body.height_mm,
            quantity=qty,
            quantity_breaks=profile.quantity_breaks,
        )
        results.append(EstimateBatchItem(
            quantity=qty,
            unit_price=bd.unit_price,
            total=bd.total,
        ))
    return results


# --------------------------------------------------------------------------- #
# 7) Finalize — save the single sticker design + return the authoritative quote
# --------------------------------------------------------------------------- #
class FinalizeRequest(BaseModel):
    quote_token: str
    name: str | None = None
    proof_requested: bool = False
    customer_email: str | None = None
    proof_note: str | None = None


class FinalizeResponse(BaseModel):
    design_ref: str
    quote_token: str
    total: float
    currency: str
    options: dict
    thumbnail_url: str | None = None


@router.post("/finalize", response_model=FinalizeResponse)
def finalize(
    body: FinalizeRequest,
    ctx: WidgetSessionContext = Depends(get_widget_session),
    db: Session = Depends(get_db),
):
    """Persist the finished design as a Printlay asset for the merchant and
    re-issue a final signed quote that also carries the design reference.

    The plugin uses the returned `quote_token` as the authoritative,
    tamper-proof line-item price; the order-paid webhook re-verifies it.
    """
    quote = read_quote(body.quote_token)  # raises 401 if tampered/expired
    if quote.get("sid") != ctx.session.token:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Quote does not match this session")

    prefix = _prefix(ctx.merchant_id, ctx.session.id)
    try:
        border_png = storage.get_bytes(f"{prefix}/border.png")
        meta = json.loads(storage.get_bytes(f"{prefix}/cutline.json").decode("utf-8"))
    except Exception:
        raise HTTPException(404, "Design session is incomplete. Please re-process the design.")

    from backend.models import Asset, User
    from backend.services.cutline_generator import CutlineResult
    from backend.services.sticker_processor import StickerProcessResult, save_sticker_pdf

    cutline = CutlineResult(
        points_px=[tuple(p) for p in meta["points_px"]],
        points_pt=[tuple(p) for p in meta["points_pt"]],
        width_px=int(meta["width_px"]),
        height_px=int(meta["height_px"]),
        width_pt=float(meta["width_pt"]),
        height_pt=float(meta["height_pt"]),
        border_image=border_png,
    )
    proc = StickerProcessResult(
        preview_png=b"",
        border_png=border_png,
        cutline=cutline,
        width_mm=float(meta["width_mm"]),
        height_mm=float(meta["height_mm"]),
        bg_type="transparent",
        removal_method=None,
    )
    with _heavy_job_slot("widget-finalize"):
        try:
            saved = save_sticker_pdf(proc, include_cut_contour=True)
        except Exception as exc:
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"PDF generation failed: {exc}")

    merchant = db.query(User).filter(User.id == ctx.merchant_id).one()
    category = _resolve_sticker_category(db, ctx.merchant_id, None, default_name="Plugin orders")

    cut_contour_json = None
    try:
        norm = _normalised_points(
            [tuple(p) for p in meta["points_px"]], int(meta["width_px"]), int(meta["height_px"])
        )
        if len(norm) >= 3:
            cut_contour_json = json.dumps([list(p) for p in norm])
    except Exception:
        cut_contour_json = None

    asset_id = uuid.uuid4()
    r2_key = f"assets/{merchant.id}/{asset_id}.pdf"
    thumb_key = f"assets/{merchant.id}/{asset_id}_thumb.jpg"
    storage.put_bytes(r2_key, saved.pdf_bytes, "application/pdf")
    storage.put_bytes(thumb_key, saved.thumbnail_bytes, "image/jpeg")

    name = (body.name or ctx.product.name or "Custom sticker").strip()[:200]
    asset = Asset(
        id=asset_id,
        user_id=merchant.id,
        category_id=category.id,
        name=name,
        kind="pdf",
        width_pt=saved.width_pt,
        height_pt=saved.height_pt,
        r2_key=r2_key,
        thumbnail_r2_key=thumb_key,
        file_size=len(saved.pdf_bytes),
        cut_contour_json=cut_contour_json,
        sticker_session_prefix=prefix,
    )
    db.add(asset)

    _record_draft_order(
        db,
        ctx,
        asset_id=asset_id,
        options=quote.get("options", {}),
        total=quote.get("total"),
        currency=quote.get("currency"),
        quantity=quote.get("quantity"),
        proof_requested=body.proof_requested,
        customer_email=body.customer_email,
        proof_note=body.proof_note,
        proof_fee=float(getattr(ctx.product, "proof_fee", 0.0) or 0.0),
    )

    ctx.session.asset_id = asset_id
    ctx.session.status = "completed"
    db.commit()

    final_quote = sign_quote(
        {
            "sid": ctx.session.token,
            "mid": str(ctx.merchant_id),
            "pid": str(ctx.product.id),
            "design_ref": str(asset_id),
            "total": quote.get("total"),
            "currency": quote.get("currency"),
            "quantity": quote.get("quantity"),
            "options": quote.get("options", {}),
        }
    )
    return FinalizeResponse(
        design_ref=str(asset_id),
        quote_token=final_quote,
        total=float(quote.get("total") or 0.0),
        currency=str(quote.get("currency") or "GBP"),
        options=quote.get("options", {}),
        thumbnail_url=_safe_presigned(thumb_key),
    )


# --------------------------------------------------------------------------- #
# 7b) Remove background from one image (used inside the canvas designer)
# --------------------------------------------------------------------------- #
class RemoveBgResponse(BaseModel):
    image_url: str
    removed: bool  # False when the image was already transparent (no-op)


@router.post("/remove-bg", response_model=RemoveBgResponse)
def remove_bg(
    file: UploadFile = File(...),
    ctx: WidgetSessionContext = Depends(get_widget_session),
    db: Session = Depends(get_db),
):
    """Background-remove a single image the customer dropped into the shaped
    designer. AI removals are metered against the merchant's monthly quota; a
    cheap solid-colour key-out or an already-transparent image is free.
    """
    raw = file.file.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "File too large (max 25 MB)")

    from backend.services.bg_removal import (
        detect_background,
        normalise_orientation,
        remove_background,
    )

    raw = normalise_orientation(raw)
    bg_type = detect_background(raw)

    removed = True
    if bg_type == "transparent":
        out = raw
        removed = False
    elif bg_type == "solid":
        with _heavy_job_slot("widget-remove-bg"):
            out = remove_background(raw, method="solid_color")
    else:
        from backend.models import User
        from backend.services import entitlements

        merchant = db.query(User).filter(User.id == ctx.merchant_id).one()
        ent = entitlements.for_user(merchant)
        limit = ent.quota("bg_removals_per_month")
        current = _get_usage(db, ctx.merchant_id)
        if limit is not None and current >= limit:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "This store has reached its monthly design limit. Please try again later.",
            )
        _increment_usage(db, ctx.merchant_id)
        with _heavy_job_slot("widget-remove-bg"):
            out = remove_background(raw, method="ai_basic")

    prefix = _prefix(ctx.merchant_id, ctx.session.id)
    key = f"{prefix}/canvas-img-{uuid.uuid4().hex}.png"
    storage.put_bytes(key, out, "image/png")
    return RemoveBgResponse(image_url=storage.presigned_get(key), removed=removed)


# --------------------------------------------------------------------------- #
# 8) Canvas finalize — flatten a multi-layer (shaped) design + save it
# --------------------------------------------------------------------------- #
@router.post("/canvas-finalize", response_model=FinalizeResponse)
def canvas_finalize(
    print_image: UploadFile = File(...),
    quote_token: str = Form(...),
    shape: str = Form("rect"),
    name: str | None = Form(None),
    ctx: WidgetSessionContext = Depends(get_widget_session),
    db: Session = Depends(get_db),
):
    """Finalize a multi-layer 'canvas' design.

    The shaped designer (circle/oval/square/rectangle) renders its layers to a
    flattened RGBA PNG client-side at print resolution, already clipped to the
    chosen shape. Here we wrap it in a print-ready PDF whose cut line is simply
    the artboard's geometric outline — no contour detection needed — and save it
    as a Printlay asset, exactly like the cut-out flow's finalize.
    """
    if getattr(ctx.product, "designer", "cutout") != "canvas":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This product is not a canvas design")

    quote = read_quote(quote_token)  # raises 401 if tampered/expired
    if quote.get("sid") != ctx.session.token:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Quote does not match this session")

    options = quote.get("options") or {}
    try:
        width_mm = float(options["width_mm"])
        height_mm = float(options["height_mm"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Quote is missing the design size")

    raw = print_image.file.read()
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Rendered design too large")

    import io as _io

    from PIL import Image as _Image

    from backend.models import Asset, User
    from backend.services.cutline_generator import CutlineResult, _ellipse_points
    from backend.services.sticker_processor import StickerProcessResult, save_sticker_pdf

    try:
        img = _Image.open(_io.BytesIO(raw)).convert("RGBA")
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Rendered design is not a valid image")

    width_px, height_px = img.size
    if width_px < 2 or height_px < 2:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Rendered design is too small")

    # The shaped designer renders the artwork across the full trim + bleed area
    # (so colours/images run to the bleed edge — no white at the cut). The
    # customer's chosen size (width_mm/height_mm) is the TRIM; the PNG we receive
    # is the trim plus a `bleed_mm` margin on every side. So the asset is stored
    # at the full size and the cut line sits INSET by the bleed — meaning on the
    # sheet the artwork overhangs the cut line by the bleed, exactly as needed.
    bleed_mm = 0.0
    try:
        bleed_mm = max(0.0, float(getattr(ctx.product, "bleed_mm", 0) or 0))
    except (TypeError, ValueError):
        bleed_mm = 0.0

    # Record the bleed on the line item so the order → Sheet Builder deep link
    # can size the placement to the full (trim + bleed) image and land the cut
    # line on the trim.
    if bleed_mm > 0:
        options = {**options, "bleed_mm": bleed_mm}

    total_w_mm = width_mm + 2.0 * bleed_mm
    total_h_mm = height_mm + 2.0 * bleed_mm
    w_pt = total_w_mm * 72.0 / 25.4
    h_pt = total_h_mm * 72.0 / 25.4
    px_to_pt_x = w_pt / width_px
    px_to_pt_y = h_pt / height_px

    bleed_px_x = (bleed_mm / total_w_mm) * width_px if total_w_mm > 0 else 0.0
    bleed_px_y = (bleed_mm / total_h_mm) * height_px if total_h_mm > 0 else 0.0
    trim_w_px = max(1.0, width_px - 2.0 * bleed_px_x)
    trim_h_px = max(1.0, height_px - 2.0 * bleed_px_y)

    if shape == "ellipse":
        pts = _ellipse_points(
            width_px / 2.0, height_px / 2.0, trim_w_px / 2.0, trim_h_px / 2.0
        )
        points_px = [(float(x), float(y)) for x, y in pts]
    else:
        # Rectangle outline along the trim edge (inset by the bleed), with
        # rounded corners when the quote carries a corner radius (0..1 fraction
        # of half the short side).
        corner_radius = 0.0
        try:
            corner_radius = max(0.0, min(1.0, float(options.get("corner_radius", 0.0))))
        except (TypeError, ValueError):
            corner_radius = 0.0
        r_px = corner_radius * min(trim_w_px, trim_h_px) / 2.0
        if r_px > 0.5:
            base = _rounded_rect_points(trim_w_px, trim_h_px, r_px)
            points_px = [(x + bleed_px_x, y + bleed_px_y) for x, y in base]
        else:
            points_px = [
                (bleed_px_x, bleed_px_y),
                (bleed_px_x + trim_w_px, bleed_px_y),
                (bleed_px_x + trim_w_px, bleed_px_y + trim_h_px),
                (bleed_px_x, bleed_px_y + trim_h_px),
            ]
    points_pt = [(x * px_to_pt_x, y * px_to_pt_y) for x, y in points_px]

    buf = _io.BytesIO()
    img.save(buf, format="PNG")
    border_png = buf.getvalue()

    cutline = CutlineResult(
        points_px=points_px,
        points_pt=points_pt,
        width_px=width_px,
        height_px=height_px,
        width_pt=w_pt,
        height_pt=h_pt,
        border_image=border_png,
    )
    proc = StickerProcessResult(
        preview_png=b"",
        border_png=border_png,
        cutline=cutline,
        width_mm=width_mm,
        height_mm=height_mm,
        bg_type="kept",
        removal_method=None,
    )

    with _heavy_job_slot("widget-canvas-finalize"):
        try:
            saved = save_sticker_pdf(proc, include_cut_contour=True)
        except Exception as exc:
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"PDF generation failed: {exc}")

    merchant = db.query(User).filter(User.id == ctx.merchant_id).one()
    category = _resolve_sticker_category(db, ctx.merchant_id, None, default_name="Plugin orders")

    cut_contour_json = None
    try:
        norm = _normalised_points(points_px, width_px, height_px)
        if len(norm) >= 3:
            cut_contour_json = json.dumps([list(p) for p in norm])
    except Exception:
        cut_contour_json = None

    asset_id = uuid.uuid4()
    r2_key = f"assets/{merchant.id}/{asset_id}.pdf"
    thumb_key = f"assets/{merchant.id}/{asset_id}_thumb.jpg"
    prefix = _prefix(ctx.merchant_id, ctx.session.id)
    storage.put_bytes(r2_key, saved.pdf_bytes, "application/pdf")
    storage.put_bytes(thumb_key, saved.thumbnail_bytes, "image/jpeg")
    storage.put_bytes(f"{prefix}/canvas.png", border_png, "image/png")
    storage.put_bytes(f"{prefix}/border.png", border_png, "image/png")
    cutline_meta = {
        "points_px": [list(p) for p in points_px],
        "points_pt": [list(p) for p in points_pt],
        "width_px": width_px,
        "height_px": height_px,
        "width_pt": w_pt,
        "height_pt": h_pt,
        "width_mm": width_mm,
        "height_mm": height_mm,
        "work_dpi": 300.0,
        "mode": "canvas",
    }
    storage.put_bytes(
        f"{prefix}/cutline.json", json.dumps(cutline_meta).encode("utf-8"), "application/json"
    )

    asset_name = (name or ctx.product.name or "Custom sticker").strip()[:200]
    asset = Asset(
        id=asset_id,
        user_id=merchant.id,
        category_id=category.id,
        name=asset_name,
        kind="pdf",
        width_pt=saved.width_pt,
        height_pt=saved.height_pt,
        r2_key=r2_key,
        thumbnail_r2_key=thumb_key,
        file_size=len(saved.pdf_bytes),
        cut_contour_json=cut_contour_json,
        sticker_session_prefix=prefix,
    )
    db.add(asset)

    _record_draft_order(
        db,
        ctx,
        asset_id=asset_id,
        options=options,
        total=quote.get("total"),
        currency=quote.get("currency"),
        quantity=quote.get("quantity"),
    )

    ctx.session.asset_id = asset_id
    ctx.session.status = "completed"
    db.commit()

    final_quote = sign_quote(
        {
            "sid": ctx.session.token,
            "mid": str(ctx.merchant_id),
            "pid": str(ctx.product.id),
            "design_ref": str(asset_id),
            "total": quote.get("total"),
            "currency": quote.get("currency"),
            "quantity": quote.get("quantity"),
            "options": options,
        }
    )
    return FinalizeResponse(
        design_ref=str(asset_id),
        quote_token=final_quote,
        total=float(quote.get("total") or 0.0),
        currency=str(quote.get("currency") or "GBP"),
        options=options,
        thumbnail_url=_safe_presigned(thumb_key),
    )


# --------------------------------------------------------------------------- #
# Public proof review endpoints (token-authenticated, no login required)
# --------------------------------------------------------------------------- #

class MarkPaidRequest(BaseModel):
    wc_order_id: int | str
    design_ref: str


@router.post("/orders/{design_ref}/mark-paid")
def mark_order_paid(
    design_ref: str,
    body: MarkPaidRequest,
    db: Session = Depends(get_db),
):
    """Called by WooCommerce plugin on payment_complete to mark the PrintLay order as paid."""
    from backend.models import Asset
    asset = db.query(Asset).filter(Asset.id == design_ref).one_or_none()
    if not asset:
        raise HTTPException(404, "Design not found")

    orders = (
        db.query(PrintOrder)
        .filter(PrintOrder.user_id == asset.user_id)
        .order_by(PrintOrder.created_at.desc())
        .limit(100)
        .all()
    )
    order = None
    for o in orders:
        for item in (o.line_items or []):
            if item.get("asset_id") == design_ref:
                order = o
                break
        if order:
            break

    if not order:
        raise HTTPException(404, "Order not found for this design")

    if order.status == "draft":
        order.status = "paid"
    order.external_order_id = str(body.wc_order_id)
    order.platform = "woocommerce"
    db.commit()
    return {"status": "ok"}

class ProofInfoResponse(BaseModel):
    order_id: str
    customer_ref: str | None
    line_items: list
    amount_total: float
    currency: str
    proof_status: str | None
    thumbnail_url: str | None = None


@router.get("/proof/{token}")
def get_proof_info(token: str, db: Session = Depends(get_db)):
    """Public endpoint: fetch order info for the proof review page."""
    o = db.query(PrintOrder).filter(PrintOrder.proof_token == token).one_or_none()
    if o is None:
        raise HTTPException(404, "Proof not found or link expired")

    thumb_url = None
    items = o.line_items or []
    if items:
        asset_id = items[0].get("asset_id")
        if asset_id:
            thumb_key = f"assets/{o.user_id}/{asset_id}_thumb.jpg"
            thumb_url = _safe_presigned(thumb_key)

    return ProofInfoResponse(
        order_id=str(o.id),
        customer_ref=o.customer_ref,
        line_items=items,
        amount_total=o.amount_total,
        currency=o.currency,
        proof_status=o.proof_status,
        thumbnail_url=thumb_url,
    )


class ProofRespondRequest(BaseModel):
    action: str  # "approve" | "reject"
    comment: str | None = None


@router.post("/proof/{token}/respond")
def respond_to_proof(token: str, body: ProofRespondRequest, db: Session = Depends(get_db)):
    """Public endpoint: customer approves or rejects a proof."""
    o = db.query(PrintOrder).filter(PrintOrder.proof_token == token).one_or_none()
    if o is None:
        raise HTTPException(404, "Proof not found or link expired")

    if body.action == "approve":
        o.proof_status = "proof_approved"
        o.status = "ready_to_print"
        msg = "Customer approved the proof"
    elif body.action == "reject":
        if not body.comment:
            raise HTTPException(400, "Please provide a reason for rejection")
        o.proof_status = "proof_rejected"
        o.proof_notes = body.comment
        msg = f"Customer rejected: {body.comment}"
    else:
        raise HTTPException(400, "Invalid action — use 'approve' or 'reject'")

    history = o.proof_history or []
    history.append({
        "action": body.action,
        "timestamp": datetime.utcnow().isoformat(),
        "by": "customer",
        "message": msg,
    })
    o.proof_history = history
    db.commit()
    return {"status": "ok", "proof_status": o.proof_status}
