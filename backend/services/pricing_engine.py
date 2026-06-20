"""Sticker price estimator for the embeddable widget.

Reuses the gang-sheet maths from the public calculator: DTF/UV-DTF/vinyl media
is roll-fed at a fixed width and sold by the linear metre, so the cost of an
order is driven by how much *length* of media the quantity consumes once the
single design is tiled across the roll width.

The customer designs ONE sticker (width x height in mm, bleed already baked in
by the cut-line stage). They order a quantity; the merchant gangs the copies
onto sheets later. The estimate:

    1. Tile the design across the roll width (best of both orientations) to get
       how many fit per row, and the row height.
    2. length = ceil(qty / per_row) * row_height  → linear metres of media.
    3. media_cost = price_per_metre * length_m
    4. + per-material and per-finish surcharges (flat per-metre values)
    5. + margin (percent markup)
    6. - the highest matching metre-based volume discount
    7. + a flat handling fee, then clamped to the order minimum.

All money is in the profile's currency. Pure functions — no DB or I/O — so the
result is trivially unit-testable and safe to call inside a request.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class PriceInputs:
    sheet_width_mm: float
    price_per_metre: float
    gap_mm: float
    margin_pct: float
    handling_fee: float
    min_order_price: float
    min_length_m: float  # minimum billable length (0 = pro-rata, 1 = DTF)
    vinyl_surcharge: float  # flat per-metre value (e.g. 2.0 = +2/m)
    finish_surcharge: float  # flat per-metre value


@dataclass(frozen=True)
class PriceBreakdown:
    currency: str
    quantity: int
    unit_price: float
    total: float
    media_cost: float
    length_m: float
    per_row: int
    rows: int
    rotated: bool
    vinyl_surcharge_per_m: float
    finish_surcharge_per_m: float
    margin_pct: float
    quantity_discount_pct: float
    handling_fee: float

    def to_dict(self) -> dict:
        return asdict(self)


def _best_fit(
    sheet_w: float, gap: float, w: float, h: float, qty: int
) -> tuple[int, int, float, bool]:
    """Return (per_row, rows, length_mm, rotated) for the orientation that uses
    the least media length for `qty` copies."""

    def run(dw: float, dh: float) -> tuple[int, int, float]:
        if dw <= 0 or dh <= 0:
            return 0, 0, math.inf
        per_row = int((sheet_w + gap) // (dw + gap))
        if per_row < 1:
            per_row = 1
        rows = math.ceil(qty / per_row)
        length = rows * (dh + gap)
        return per_row, rows, length

    upright = run(w, h)
    rotated = run(h, w)
    if rotated[2] < upright[2]:
        return rotated[0], rotated[1], rotated[2], True
    return upright[0], upright[1], upright[2], False


def _volume_discount(quantity_breaks, length_m: float) -> float:
    """Highest matching metre-tier's discount percent (0 if none).
    Falls back to qty-based matching for legacy profiles."""
    if not quantity_breaks:
        return 0.0
    best = 0.0
    best_min = -1.0
    for brk in quantity_breaks:
        try:
            min_qty = float(brk.get("min_qty", 0))
            disc = float(brk.get("discount_pct", 0))
        except (AttributeError, TypeError, ValueError):
            continue
        if length_m >= min_qty and min_qty > best_min:
            best_min = min_qty
            best = disc
    return max(0.0, min(100.0, best))


def estimate(
    inputs: PriceInputs,
    *,
    currency: str,
    width_mm: float,
    height_mm: float,
    quantity: int,
    quantity_breaks=None,
) -> PriceBreakdown:
    qty = max(1, int(quantity))

    per_row, rows, length_mm, rotated = _best_fit(
        inputs.sheet_width_mm, inputs.gap_mm, width_mm, height_mm, qty
    )
    length_m = length_mm / 1000.0

    # Enforce minimum billable length (e.g. 1m for DTF sheets)
    billable_m = max(length_m, max(0.0, inputs.min_length_m))

    media_cost = max(0.0, inputs.price_per_metre) * billable_m

    # Surcharges are flat per-metre values added to the media cost
    surcharge_total = (max(0.0, inputs.vinyl_surcharge) + max(0.0, inputs.finish_surcharge)) * billable_m
    after_surcharge = media_cost + surcharge_total

    after_margin = after_surcharge * (1.0 + max(0.0, inputs.margin_pct) / 100.0)

    discount_pct = _volume_discount(quantity_breaks, billable_m)
    after_discount = after_margin * (1.0 - discount_pct / 100.0)

    total = after_discount + max(0.0, inputs.handling_fee)
    total = max(total, max(0.0, inputs.min_order_price))

    total = round(total, 2)
    unit_price = round(total / qty, 4)

    return PriceBreakdown(
        currency=currency,
        quantity=qty,
        unit_price=unit_price,
        total=total,
        media_cost=round(media_cost, 4),
        length_m=round(length_m, 4),
        per_row=per_row,
        rows=rows,
        rotated=rotated,
        vinyl_surcharge_per_m=round(max(0.0, inputs.vinyl_surcharge), 2),
        finish_surcharge_per_m=round(max(0.0, inputs.finish_surcharge), 2),
        margin_pct=round(max(0.0, inputs.margin_pct), 2),
        quantity_discount_pct=round(discount_pct, 2),
        handling_fee=round(max(0.0, inputs.handling_fee), 2),
    )


def inputs_from_profile(profile, *, vinyl: str | None, finish: str | None) -> PriceInputs:
    """Build PriceInputs from a PricingProfile row + selected vinyl/finish."""
    vinyl_map = profile.vinyl_surcharges or {}
    finish_map = profile.finish_surcharges or {}
    return PriceInputs(
        sheet_width_mm=float(profile.sheet_width_mm or 0.0),
        price_per_metre=float(profile.price_per_metre or 0.0),
        gap_mm=float(profile.gap_mm or 0.0),
        margin_pct=float(profile.margin_pct or 0.0),
        handling_fee=float(profile.handling_fee or 0.0),
        min_order_price=float(profile.min_order_price or 0.0),
        min_length_m=float(getattr(profile, "min_length_m", 0.0) or 0.0),
        vinyl_surcharge=float(vinyl_map.get(vinyl, 0.0)) if vinyl else 0.0,
        finish_surcharge=float(finish_map.get(finish, 0.0)) if finish else 0.0,
    )
