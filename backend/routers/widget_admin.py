"""Merchant-facing admin API for the embeddable widget (`/api/widget`).

Authenticated with the normal Supabase session (the logged-in Printlay
merchant), gated behind the `widget_access` entitlement. Lets a merchant manage
everything the customer-facing widget needs:

- **API keys**     — create (shown once) / list / revoke.
- **Settings**     — allowed embed origins + the order-webhook secret.
- **Pricing**      — reusable PricingProfiles (sheet width, GBP/metre, margin…).
- **Products**     — the entity a store product links to (cut styles, sizes,
                     vinyls, finishes, bleed/safe, pricing profile).
- **Orders**       — the "ready to print" queue.
- **Preview**      — mint a session token for the merchant's own browser so they
                     can test the live widget before wiring up a plugin.

These run same-origin from the Printlay app, so they use the normal app CORS —
NOT the per-merchant widget CORS (which only covers `/api/v1/widget` + `/embed`).
"""
from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.auth import AuthenticatedUser, get_current_user
from backend.auth.widget_token import SESSION_TTL_S, make_session_token
from backend.database import get_db
from backend.models import (
    MerchantApiKey,
    PricingProfile,
    PrintOrder,
    Product,
    User,
    WidgetSession,
    WidgetSettings,
)
from backend.services import entitlements, merchant_keys, widget_origins

router = APIRouter(prefix="/api/widget", tags=["widget-admin"])

DEFAULT_CUT_STYLES = ["die_cut", "face", "square", "circle"]

# Cut styles are constrained by the chosen design experience: a cut-out product
# only does contour/face cuts, a shaped (canvas) product only does geometric
# artboard shapes (rectangle/oval are reached via the in-designer unlock).
CUTOUT_CUT_STYLES = ["die_cut", "face", "keep_bg"]
CANVAS_CUT_STYLES = ["square", "circle"]


def _allowed_cut_styles(designer: str) -> list[str]:
    return CANVAS_CUT_STYLES if designer == "canvas" else CUTOUT_CUT_STYLES


def _merchant(
    auth: AuthenticatedUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    """Resolve the logged-in merchant and require the widget entitlement."""
    if not auth.email:
        raise HTTPException(400, "JWT missing email claim")
    from backend.services import user_provisioning

    user = user_provisioning.get_or_provision(db, auth_id=auth.auth_id, email=auth.email)
    if not entitlements.for_user(user).allows("widget_access"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "The embeddable widget is a Studio feature. Upgrade your plan to enable it.",
        )
    return user


# --------------------------------------------------------------------------- #
# API keys
# --------------------------------------------------------------------------- #
class ApiKeyOut(BaseModel):
    id: str
    name: str
    prefix: str
    last_used_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime


class ApiKeyCreated(ApiKeyOut):
    plaintext: str  # shown exactly once


def _key_out(k: MerchantApiKey) -> ApiKeyOut:
    return ApiKeyOut(
        id=str(k.id),
        name=k.name,
        prefix=k.prefix,
        last_used_at=k.last_used_at,
        revoked_at=k.revoked_at,
        created_at=k.created_at,
    )


@router.get("/keys", response_model=list[ApiKeyOut])
def list_keys(user: User = Depends(_merchant), db: Session = Depends(get_db)):
    rows = (
        db.query(MerchantApiKey)
        .filter(MerchantApiKey.user_id == user.id)
        .order_by(MerchantApiKey.created_at.desc())
        .all()
    )
    return [_key_out(k) for k in rows]


class CreateKeyRequest(BaseModel):
    name: str = Field(default="API key", max_length=100)


@router.post("/keys", response_model=ApiKeyCreated, status_code=201)
def create_key(
    body: CreateKeyRequest, user: User = Depends(_merchant), db: Session = Depends(get_db)
):
    gen = merchant_keys.generate_key()
    key = MerchantApiKey(
        user_id=user.id,
        name=body.name.strip() or "API key",
        prefix=gen.prefix,
        key_hash=gen.key_hash,
    )
    db.add(key)
    db.commit()
    db.refresh(key)
    return ApiKeyCreated(**_key_out(key).model_dump(), plaintext=gen.plaintext)


@router.delete("/keys/{key_id}", status_code=204)
def revoke_key(key_id: uuid.UUID, user: User = Depends(_merchant), db: Session = Depends(get_db)):
    key = (
        db.query(MerchantApiKey)
        .filter(MerchantApiKey.id == key_id, MerchantApiKey.user_id == user.id)
        .one_or_none()
    )
    if key is None:
        raise HTTPException(404, "Key not found")
    if key.revoked_at is None:
        key.revoked_at = datetime.now(timezone.utc)
        db.commit()


# --------------------------------------------------------------------------- #
# Widget settings (allowed origins + webhook secret)
# --------------------------------------------------------------------------- #
class SettingsOut(BaseModel):
    allowed_origins: list[str]
    has_webhook_secret: bool


def _get_or_create_settings(db: Session, user_id: uuid.UUID) -> WidgetSettings:
    s = db.query(WidgetSettings).filter(WidgetSettings.user_id == user_id).one_or_none()
    if s is None:
        s = WidgetSettings(user_id=user_id, allowed_origins=[])
        db.add(s)
        db.commit()
        db.refresh(s)
    return s


@router.get("/settings", response_model=SettingsOut)
def get_settings(user: User = Depends(_merchant), db: Session = Depends(get_db)):
    s = _get_or_create_settings(db, user.id)
    return SettingsOut(
        allowed_origins=s.allowed_origins or [],
        has_webhook_secret=bool(s.webhook_secret),
    )


class UpdateSettingsRequest(BaseModel):
    allowed_origins: list[str]


@router.patch("/settings", response_model=SettingsOut)
def update_settings(
    body: UpdateSettingsRequest, user: User = Depends(_merchant), db: Session = Depends(get_db)
):
    s = _get_or_create_settings(db, user.id)
    cleaned: list[str] = []
    for o in body.allowed_origins:
        o = (o or "").strip().rstrip("/")
        if o and o not in cleaned:
            cleaned.append(o)
    s.allowed_origins = cleaned
    db.commit()
    widget_origins.allowed_origins(force_refresh=True)  # bust the CORS cache
    return SettingsOut(allowed_origins=cleaned, has_webhook_secret=bool(s.webhook_secret))


class WebhookSecretOut(BaseModel):
    webhook_secret: str  # shown once


@router.post("/settings/webhook-secret", response_model=WebhookSecretOut)
def rotate_webhook_secret(user: User = Depends(_merchant), db: Session = Depends(get_db)):
    s = _get_or_create_settings(db, user.id)
    s.webhook_secret = secrets.token_hex(32)
    db.commit()
    return WebhookSecretOut(webhook_secret=s.webhook_secret)


# --------------------------------------------------------------------------- #
# Pricing profiles
# --------------------------------------------------------------------------- #
class PricingProfileIn(BaseModel):
    name: str = Field(default="Default pricing", max_length=120)
    currency: str = Field(default="GBP", max_length=3)
    sheet_width_mm: float = 300.0
    price_per_metre: float = 0.0
    gap_mm: float = 3.0
    margin_pct: float = 0.0
    handling_fee: float = 0.0
    min_order_price: float = 0.0
    min_length_m: float = 0.0
    vinyl_surcharges: dict | None = None
    finish_surcharges: dict | None = None
    quantity_breaks: list | None = None
    quantity_presets: list[int] | None = None
    allow_custom_quantity: bool = True


class PricingProfileOut(PricingProfileIn):
    id: str
    created_at: datetime


def _profile_out(p: PricingProfile) -> PricingProfileOut:
    return PricingProfileOut(
        id=str(p.id),
        name=p.name,
        currency=p.currency,
        sheet_width_mm=p.sheet_width_mm,
        price_per_metre=p.price_per_metre,
        gap_mm=p.gap_mm,
        margin_pct=p.margin_pct,
        handling_fee=p.handling_fee,
        min_order_price=p.min_order_price,
        min_length_m=getattr(p, "min_length_m", 0.0) or 0.0,
        vinyl_surcharges=p.vinyl_surcharges,
        finish_surcharges=p.finish_surcharges,
        quantity_breaks=p.quantity_breaks,
        quantity_presets=getattr(p, "quantity_presets", None),
        allow_custom_quantity=getattr(p, "allow_custom_quantity", True),
        created_at=p.created_at,
    )


@router.get("/pricing-profiles", response_model=list[PricingProfileOut])
def list_profiles(user: User = Depends(_merchant), db: Session = Depends(get_db)):
    rows = (
        db.query(PricingProfile)
        .filter(PricingProfile.user_id == user.id)
        .order_by(PricingProfile.created_at.desc())
        .all()
    )
    return [_profile_out(p) for p in rows]


@router.post("/pricing-profiles", response_model=PricingProfileOut, status_code=201)
def create_profile(
    body: PricingProfileIn, user: User = Depends(_merchant), db: Session = Depends(get_db)
):
    p = PricingProfile(user_id=user.id, **body.model_dump())
    db.add(p)
    db.commit()
    db.refresh(p)
    return _profile_out(p)


def _get_profile(db: Session, user_id: uuid.UUID, profile_id: uuid.UUID) -> PricingProfile:
    p = (
        db.query(PricingProfile)
        .filter(PricingProfile.id == profile_id, PricingProfile.user_id == user_id)
        .one_or_none()
    )
    if p is None:
        raise HTTPException(404, "Pricing profile not found")
    return p


@router.patch("/pricing-profiles/{profile_id}", response_model=PricingProfileOut)
def update_profile(
    profile_id: uuid.UUID,
    body: PricingProfileIn,
    user: User = Depends(_merchant),
    db: Session = Depends(get_db),
):
    p = _get_profile(db, user.id, profile_id)
    for k, v in body.model_dump().items():
        setattr(p, k, v)
    db.commit()
    db.refresh(p)
    return _profile_out(p)


@router.delete("/pricing-profiles/{profile_id}", status_code=204)
def delete_profile(
    profile_id: uuid.UUID, user: User = Depends(_merchant), db: Session = Depends(get_db)
):
    p = _get_profile(db, user.id, profile_id)
    db.delete(p)
    db.commit()


# --------------------------------------------------------------------------- #
# Products
# --------------------------------------------------------------------------- #
class SizePreset(BaseModel):
    width_mm: float
    height_mm: float


class ProductIn(BaseModel):
    name: str = Field(default="Custom stickers", max_length=200)
    is_active: bool = True
    designer: str = "cutout"  # 'cutout' | 'canvas'
    enabled_cut_styles: list[str] | None = None
    min_size_mm: float = 20.0
    max_size_mm: float = 300.0
    size_presets: list[SizePreset] | None = None
    allow_custom_size: bool = True
    corner_radius: float = 0.2
    vinyl_types: list | None = None
    finishes: list | None = None
    bleed_mm: float = 3.0
    safe_mm: float = 4.0
    pricing_profile_id: str | None = None
    show_filters: bool = True
    show_ai_styles: bool = False
    show_hand_edit: bool = False
    require_proof: bool = False
    proof_fee: float = 0.0


class ProductOut(BaseModel):
    id: str
    name: str
    is_active: bool
    designer: str
    enabled_cut_styles: list[str]
    min_size_mm: float
    max_size_mm: float
    size_presets: list[dict]
    allow_custom_size: bool
    corner_radius: float
    vinyl_types: list
    finishes: list
    bleed_mm: float
    safe_mm: float
    pricing_profile_id: str | None
    show_filters: bool
    show_ai_styles: bool
    show_hand_edit: bool
    require_proof: bool
    proof_fee: float
    created_at: datetime


def _product_out(p: Product) -> ProductOut:
    designer = getattr(p, "designer", "cutout") or "cutout"
    return ProductOut(
        id=str(p.id),
        name=p.name,
        is_active=p.is_active,
        designer=designer,
        enabled_cut_styles=p.enabled_cut_styles or _allowed_cut_styles(designer),
        min_size_mm=p.min_size_mm,
        max_size_mm=p.max_size_mm,
        size_presets=getattr(p, "size_presets", None) or [],
        allow_custom_size=getattr(p, "allow_custom_size", True),
        corner_radius=getattr(p, "corner_radius", 0.2),
        vinyl_types=p.vinyl_types or [],
        finishes=p.finishes or [],
        bleed_mm=p.bleed_mm,
        safe_mm=p.safe_mm,
        pricing_profile_id=str(p.pricing_profile_id) if p.pricing_profile_id else None,
        show_filters=getattr(p, "show_filters", True),
        show_ai_styles=getattr(p, "show_ai_styles", False),
        show_hand_edit=getattr(p, "show_hand_edit", False),
        require_proof=getattr(p, "require_proof", False),
        proof_fee=getattr(p, "proof_fee", 0.0),
        created_at=p.created_at,
    )


def _clean_cut_styles(styles: list[str] | None, designer: str) -> list[str] | None:
    """Keep only the cut styles valid for the chosen design experience."""
    allowed = _allowed_cut_styles(designer)
    if styles is None:
        return None
    cleaned = [s for s in styles if s in allowed]
    return cleaned or None


def _clean_size_presets(
    presets: list[SizePreset] | None, lo: float, hi: float
) -> list[dict] | None:
    if not presets:
        return None
    out: list[dict] = []
    seen: set[tuple[float, float]] = set()
    for p in presets:
        w = round(max(lo, min(hi, float(p.width_mm))), 1)
        h = round(max(lo, min(hi, float(p.height_mm))), 1)
        if w <= 0 or h <= 0 or (w, h) in seen:
            continue
        seen.add((w, h))
        out.append({"width_mm": w, "height_mm": h})
    return out or None


def _clean_corner_radius(value: float | None) -> float:
    try:
        return round(max(0.0, min(1.0, float(value if value is not None else 0.2))), 3)
    except (TypeError, ValueError):
        return 0.2


def _clean_designer(value: str | None) -> str:
    return value if value in ("cutout", "canvas") else "cutout"


def _resolve_profile_id(
    db: Session, user_id: uuid.UUID, profile_id: str | None
) -> uuid.UUID | None:
    if not profile_id:
        return None
    try:
        pid = uuid.UUID(profile_id)
    except (ValueError, TypeError):
        raise HTTPException(400, "Invalid pricing profile id")
    _get_profile(db, user_id, pid)  # validate ownership
    return pid


@router.get("/products", response_model=list[ProductOut])
def list_products(user: User = Depends(_merchant), db: Session = Depends(get_db)):
    rows = (
        db.query(Product)
        .filter(Product.user_id == user.id)
        .order_by(Product.created_at.desc())
        .all()
    )
    return [_product_out(p) for p in rows]


@router.post("/products", response_model=ProductOut, status_code=201)
def create_product(
    body: ProductIn, user: User = Depends(_merchant), db: Session = Depends(get_db)
):
    data = body.model_dump()
    data["designer"] = _clean_designer(body.designer)
    data["enabled_cut_styles"] = _clean_cut_styles(body.enabled_cut_styles, data["designer"])
    data["size_presets"] = _clean_size_presets(body.size_presets, body.min_size_mm, body.max_size_mm)
    data["corner_radius"] = _clean_corner_radius(body.corner_radius)
    data["pricing_profile_id"] = _resolve_profile_id(db, user.id, body.pricing_profile_id)
    p = Product(user_id=user.id, **data)
    db.add(p)
    db.commit()
    db.refresh(p)
    return _product_out(p)


def _get_product(db: Session, user_id: uuid.UUID, product_id: uuid.UUID) -> Product:
    p = (
        db.query(Product)
        .filter(Product.id == product_id, Product.user_id == user_id)
        .one_or_none()
    )
    if p is None:
        raise HTTPException(404, "Product not found")
    return p


@router.get("/products/{product_id}", response_model=ProductOut)
def get_product(
    product_id: uuid.UUID, user: User = Depends(_merchant), db: Session = Depends(get_db)
):
    return _product_out(_get_product(db, user.id, product_id))


@router.patch("/products/{product_id}", response_model=ProductOut)
def update_product(
    product_id: uuid.UUID,
    body: ProductIn,
    user: User = Depends(_merchant),
    db: Session = Depends(get_db),
):
    p = _get_product(db, user.id, product_id)
    data = body.model_dump()
    data["designer"] = _clean_designer(body.designer)
    data["enabled_cut_styles"] = _clean_cut_styles(body.enabled_cut_styles, data["designer"])
    data["size_presets"] = _clean_size_presets(body.size_presets, body.min_size_mm, body.max_size_mm)
    data["corner_radius"] = _clean_corner_radius(body.corner_radius)
    data["pricing_profile_id"] = _resolve_profile_id(db, user.id, body.pricing_profile_id)
    for k, v in data.items():
        setattr(p, k, v)
    db.commit()
    db.refresh(p)
    return _product_out(p)


@router.delete("/products/{product_id}", status_code=204)
def delete_product(
    product_id: uuid.UUID, user: User = Depends(_merchant), db: Session = Depends(get_db)
):
    p = _get_product(db, user.id, product_id)
    db.delete(p)
    db.commit()


# --------------------------------------------------------------------------- #
# WooCommerce status webhook helper
# --------------------------------------------------------------------------- #

def _fire_wc_status_webhook(order: PrintOrder) -> None:
    """Best-effort fire a status update to the WooCommerce REST endpoint."""
    import os
    import httpx

    if order.platform != "woocommerce":
        return
    items = order.line_items or []
    if not items:
        return
    design_ref = items[0].get("asset_id")
    if not design_ref:
        return

    from backend.models.user import User
    from backend.database import SessionLocal

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.id == order.user_id).one_or_none()
        if not user:
            return
        wc_url = getattr(user, "wc_site_url", None) or os.environ.get("WC_SITE_URL")
        api_key = getattr(user, "wc_api_key", None) or os.environ.get("WC_API_KEY")
        if not wc_url or not api_key:
            return

        endpoint = f"{wc_url.rstrip('/')}/wp-json/printlay/v1/status-update"
        try:
            httpx.post(
                endpoint,
                json={
                    "design_ref": design_ref,
                    "status": order.status,
                    "proof_status": getattr(order, "proof_status", None),
                },
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=10,
            )
        except Exception:
            pass
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Print orders queue
# --------------------------------------------------------------------------- #
class OrderOut(BaseModel):
    id: str
    platform: str
    external_order_id: str
    customer_ref: str | None
    line_items: list
    amount_total: float
    currency: str
    status: str
    proof_status: str | None = None
    proof_notes: str | None = None
    proof_history: list | None = None
    customer_email: str | None = None
    proof_token: str | None = None
    output_r2_key: str | None
    created_at: datetime


def _order_out(o: PrintOrder) -> OrderOut:
    return OrderOut(
        id=str(o.id),
        platform=o.platform,
        external_order_id=o.external_order_id,
        customer_ref=o.customer_ref,
        line_items=o.line_items or [],
        amount_total=o.amount_total,
        currency=o.currency,
        status=o.status,
        proof_status=getattr(o, "proof_status", None),
        proof_notes=getattr(o, "proof_notes", None),
        proof_history=getattr(o, "proof_history", None),
        customer_email=getattr(o, "customer_email", None),
        proof_token=getattr(o, "proof_token", None),
        output_r2_key=o.output_r2_key,
        created_at=o.created_at,
    )


@router.get("/orders", response_model=list[OrderOut])
def list_orders(
    status_filter: str | None = None,
    user: User = Depends(_merchant),
    db: Session = Depends(get_db),
):
    q = db.query(PrintOrder).filter(PrintOrder.user_id == user.id)
    if status_filter:
        if status_filter == "awaiting_proof":
            q = q.filter(PrintOrder.proof_status.in_(["awaiting_proof", "proof_sent", "proof_rejected"]))
        else:
            q = q.filter(PrintOrder.status == status_filter)
    rows = q.order_by(PrintOrder.created_at.desc()).limit(200).all()
    return [_order_out(o) for o in rows]


class UpdateOrderRequest(BaseModel):
    status: str


_VALID_ORDER_STATUSES = {"draft", "paid", "ready_to_print", "printed"}


@router.patch("/orders/{order_id}", response_model=OrderOut)
def update_order(
    order_id: uuid.UUID,
    body: UpdateOrderRequest,
    user: User = Depends(_merchant),
    db: Session = Depends(get_db),
):
    if body.status not in _VALID_ORDER_STATUSES:
        raise HTTPException(400, "Invalid status")
    o = (
        db.query(PrintOrder)
        .filter(PrintOrder.id == order_id, PrintOrder.user_id == user.id)
        .one_or_none()
    )
    if o is None:
        raise HTTPException(404, "Order not found")
    o.status = body.status
    db.commit()
    db.refresh(o)
    _fire_wc_status_webhook(o)
    return _order_out(o)


@router.delete("/orders/{order_id}", status_code=204)
def delete_order(
    order_id: uuid.UUID, user: User = Depends(_merchant), db: Session = Depends(get_db)
):
    o = (
        db.query(PrintOrder)
        .filter(PrintOrder.id == order_id, PrintOrder.user_id == user.id)
        .one_or_none()
    )
    if o is None:
        raise HTTPException(404, "Order not found")
    db.delete(o)
    db.commit()


@router.post("/orders/{order_id}/send-proof", response_model=OrderOut)
def send_proof(
    order_id: uuid.UUID,
    user: User = Depends(_merchant),
    db: Session = Depends(get_db),
):
    """Send proof email to customer and update proof_status."""
    from backend.services import messaging
    import os

    o = (
        db.query(PrintOrder)
        .filter(PrintOrder.id == order_id, PrintOrder.user_id == user.id)
        .one_or_none()
    )
    if o is None:
        raise HTTPException(404, "Order not found")
    if not o.customer_email:
        raise HTTPException(400, "Order has no customer email address")

    base_url = os.environ.get("APP_BASE_URL", "https://printlay.co.uk")
    proof_url = f"{base_url}/proof/{o.proof_token}"

    items_desc = ""
    for item in (o.line_items or []):
        opts = item.get("options", {})
        w = opts.get("width_mm", "?")
        h = opts.get("height_mm", "?")
        qty = item.get("qty", 1)
        items_desc += f"  • {qty}× {w}mm × {h}mm\n"

    subject = f"Your design proof is ready — {o.customer_ref or 'Order'}"
    text_body = (
        f"Hi,\n\n"
        f"Your design proof is ready for review.\n\n"
        f"Specs:\n{items_desc}\n"
        f"Total: {o.currency} {o.amount_total:.2f}\n\n"
        f"Please review and approve (or request changes):\n{proof_url}\n\n"
        f"Thank you!"
    )
    html_body = (
        f"<div style='font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px'>"
        f"<h2 style='color:#1e293b'>Your design proof is ready</h2>"
        f"<p>We've prepared your design for review before printing.</p>"
        f"<div style='background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin:16px 0'>"
        f"<p style='margin:0 0 8px;font-weight:600'>Order details</p>"
        f"<p style='margin:0;font-size:14px;color:#475569'>{items_desc.replace(chr(10), '<br>')}</p>"
        f"<p style='margin:8px 0 0;font-size:14px'>Total: <strong>{o.currency} {o.amount_total:.2f}</strong></p>"
        f"</div>"
        f"<div style='text-align:center;margin:24px 0'>"
        f"<a href='{proof_url}' style='display:inline-block;background:#8b5cf6;color:#fff;padding:12px 32px;"
        f"border-radius:8px;text-decoration:none;font-weight:600;font-size:16px'>Review Proof</a>"
        f"</div>"
        f"<p style='font-size:13px;color:#64748b'>Or copy this link: {proof_url}</p>"
        f"</div>"
    )

    messaging.send_email_bulk(
        [o.customer_email],
        subject=subject,
        text_body=text_body,
        html_body=html_body,
    )

    o.proof_status = "proof_sent"
    history = o.proof_history or []
    history.append({
        "action": "proof_sent",
        "timestamp": datetime.utcnow().isoformat(),
        "by": "merchant",
        "message": f"Proof sent to {o.customer_email}",
    })
    o.proof_history = history
    db.commit()
    db.refresh(o)
    return _order_out(o)


# --------------------------------------------------------------------------- #
# Live preview — mint a session token for the merchant's own browser
# --------------------------------------------------------------------------- #
class PreviewSessionRequest(BaseModel):
    product_id: str


class PreviewSessionResponse(BaseModel):
    session_token: str
    expires_in: int


@router.post("/preview-session", response_model=PreviewSessionResponse)
def preview_session(
    body: PreviewSessionRequest, user: User = Depends(_merchant), db: Session = Depends(get_db)
):
    """Create a widget session for the logged-in merchant so they can test the
    live design flow in the admin before connecting a store plugin. Identical to
    the API-key `/api/v1/widget/sessions`, but authenticated by the app session.
    """
    try:
        product_uuid = uuid.UUID(body.product_id)
    except (ValueError, TypeError):
        raise HTTPException(400, "Invalid product id")

    product = _get_product(db, user.id, product_uuid)
    if not product.is_active:
        raise HTTPException(409, "Activate this product before previewing it")

    token = secrets.token_urlsafe(32)
    sess = WidgetSession(
        user_id=user.id,
        product_id=product.id,
        token=token,
        external_ref="admin-preview",
        status="open",
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=SESSION_TTL_S),
    )
    db.add(sess)
    db.commit()

    session_token = make_session_token(
        session_id=token, merchant_id=str(user.id), product_id=str(product.id)
    )
    return PreviewSessionResponse(session_token=session_token, expires_in=SESSION_TTL_S)
