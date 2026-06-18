# Stripe Subscription & Trial System Reference

> Complete architecture for integrating Stripe subscription billing with a
> trial-based access system. Covers the full lifecycle: signup → trial →
> checkout → active subscriber → cancellation/renewal. Designed to be
> portable to any new product — replace plan names, prices, and feature
> gates with your own.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Database Schema](#2-database-schema)
3. [Trial System](#3-trial-system)
4. [Entitlements (Access Resolution)](#4-entitlements-access-resolution)
5. [Stripe Configuration](#5-stripe-configuration)
6. [API Endpoints](#6-api-endpoints)
7. [Checkout Flow](#7-checkout-flow)
8. [Webhook Handling](#8-webhook-handling)
9. [Founder / Coupon Pricing](#9-founder--coupon-pricing)
10. [Frontend Implementation](#10-frontend-implementation)
11. [Feature Gates & Quota Enforcement](#11-feature-gates--quota-enforcement)
12. [Edge Cases & Important Notes](#12-edge-cases--important-notes)
13. [Architecture Diagram](#13-architecture-diagram)

---

## 1. System Overview

The billing system has three interacting layers:

```
┌─────────────────────────────────────────────────┐
│  ENTITLEMENTS (computed on every request)        │
│  Inputs: stripe_subscription_status,            │
│          stripe_price_id, trial_ends_at, tier   │
│  Output: plan, limits{}, features[], is_trial   │
└─────────────────────────────────────────────────┘
         ▲                        ▲
         │                        │
┌────────┴────────┐    ┌─────────┴─────────┐
│  STRIPE BILLING │    │  TRIAL SYSTEM     │
│  Webhooks sync  │    │  7-day default    │
│  user columns   │    │  Custom via invite│
└─────────────────┘    └───────────────────┘
```

**Key principle:** Entitlements are NEVER stored — they're computed lazily on
every request from the user's current state. No cron jobs needed.

---

## 2. Database Schema

### Users table — billing fields

```sql
ALTER TABLE users ADD COLUMN trial_ends_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN stripe_customer_id VARCHAR(64) UNIQUE;
ALTER TABLE users ADD COLUMN stripe_subscription_id VARCHAR(64) UNIQUE;
ALTER TABLE users ADD COLUMN stripe_subscription_status VARCHAR(32);
ALTER TABLE users ADD COLUMN stripe_price_id VARCHAR(64);
ALTER TABLE users ADD COLUMN stripe_current_period_end TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN founder_member BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN tier VARCHAR(32) NOT NULL DEFAULT 'locked';
```

| Field | Purpose |
|-------|---------|
| `trial_ends_at` | Absolute datetime when trial expires. Set on signup, **cleared** when subscription becomes `active`. Null = no trial (locked unless subscribed). |
| `stripe_customer_id` | Stripe Customer ID. Created on first checkout. |
| `stripe_subscription_id` | Current subscription ID. Cleared on cancellation. |
| `stripe_subscription_status` | Mirrors Stripe: `active`, `past_due`, `canceled`, `trialing`, etc. |
| `stripe_price_id` | Active price ID → mapped to plan tier in entitlements. |
| `stripe_current_period_end` | Next renewal date. Used for admin views / churn detection. |
| `founder_member` | Set permanently when a founder coupon is detected. Never unset. |
| `tier` | Manual override. Only `"enterprise"` is used (admin-invoiced deals). Everything else resolves from Stripe + trial. |

### Stripe events table (webhook idempotency)

```sql
CREATE TABLE stripe_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id VARCHAR(128) UNIQUE NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Before processing any webhook, INSERT the event ID. If it already exists
(duplicate delivery), return 200 immediately without processing.

---

## 3. Trial System

### How trials are granted

| Scenario | Trial Duration | Mechanism |
|----------|---------------|-----------|
| Normal signup | 7 days | `trial_ends_at = now() + 7 days` |
| Signup with invite token | Custom (1–180 days) | `trial_ends_at = now() + invite.trial_days` |
| Affiliate-only signup (no invite) | None | `trial_ends_at = null` → locked |
| Admin sets trial | Custom | `PATCH /api/admin/users/{id}` |

### Trial lifecycle

```
SIGNUP
  │
  ▼
trial_ends_at = now + N days  ──────────────────► Pro features (capped storage)
  │                                                      │
  │  (user subscribes)                                   │ (trial expires)
  ▼                                                      ▼
trial_ends_at = NULL  ◄── webhook clears it         LOCKED STATE
stripe_subscription_status = "active"               (no features, upgrade CTA)
  │
  ▼
PAID SUBSCRIBER (plan from stripe_price_id)
```

### Trial display formula (frontend)

```typescript
const daysLeft = Math.max(0, Math.ceil(
  (new Date(trial_ends_at).getTime() - Date.now()) / 86_400_000
));
```

### Where trial status is shown

| Location | Format | When |
|----------|--------|------|
| Admin user list | `trial · {N}d` (color: green >5d, amber 3–5d, rose ≤2d) | Always for trialing users |
| Trial banner (app shell) | "X days left on your free trial" | When ≤7 days remain |
| Settings page | "X days remaining" + progress bar | Always during trial |
| Locked overlay | Blocks entire UI | When trial expired AND no subscription |

### Trial → Subscription transition

When `apply_subscription_to_user()` runs (from webhook):
```python
if sub.status == "active" and user.trial_ends_at is not None:
    user.trial_ends_at = None  # Clear trial — subscription takes over
```

This is the critical handoff: once the user pays, trial_ends_at is nullified
and entitlements resolve from `stripe_price_id` instead.

---

## 4. Entitlements (Access Resolution)

### Resolution priority (checked on EVERY API request)

```python
def for_user(user) -> Entitlement:
    # 0. Admin bypass — full access
    if is_admin(user):
        return enterprise_entitlement()

    # 1. Active Stripe subscription (primary billing path)
    if user.stripe_subscription_status == "active":
        plan = plan_from_price_id(user.stripe_price_id)
        return Entitlement(plan=plan, is_trialing=False, limits=PLAN_LIMITS[plan])

    # 2. Enterprise override (admin-set, invoiced deals)
    if user.tier == "enterprise":
        return Entitlement(plan="enterprise", is_trialing=False, limits=UNLIMITED)

    # 3. Active trial (Pro features, capped storage)
    if user.trial_ends_at and user.trial_ends_at > now():
        limits = PLAN_LIMITS["pro"].copy()
        limits["storage_mb_max"] = 3072  # 3 GB cap during trial
        return Entitlement(plan="pro", is_trialing=True, limits=limits)

    # 4. Nothing — locked
    return Entitlement(plan="locked", is_trialing=False, limits=ZERO_LIMITS)
```

**Critical:** Only `stripe_subscription_status == "active"` unlocks paid features.
Stripe's own `trialing` status, `past_due`, etc. do NOT grant access through
the subscription path — the user falls through to the app-side trial or locked.

### Price ID → Plan mapping

```python
def plan_from_price_id(price_id: str) -> str:
    settings = get_settings()
    starter_ids = {settings.stripe_price_starter_monthly, settings.stripe_price_starter_annual}
    pro_ids = {settings.stripe_price_pro_monthly, settings.stripe_price_pro_annual}
    studio_ids = {settings.stripe_price_studio_monthly, settings.stripe_price_studio_annual}

    if price_id in starter_ids: return "starter"
    if price_id in pro_ids: return "pro"
    if price_id in studio_ids: return "studio"
    return "pro"  # fallback for unknown prices
```

### Plan limits (adapt to your product)

| Plan | templates | exports/mo | categories | profiles | storage |
|------|-----------|------------|------------|----------|---------|
| locked | 0 | 0 | 0 | 0 | 0 |
| starter | 10 | 50 | 10 | 2 | 20 GB |
| pro | 20 | 200 | 30 | 5 | 50 GB |
| studio | 50 | 500 | 100 | 20 | 250 GB |
| enterprise | ∞ | ∞ | ∞ | ∞ | ∞ |

> **For your product:** Replace these keys and values with whatever resources
> your product meters (e.g., projects, API calls, team members, etc.)

---

## 5. Stripe Configuration

### Environment variables

```bash
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Price IDs from your Stripe dashboard (or created via script)
STRIPE_PRICE_STARTER_MONTHLY=price_xxx
STRIPE_PRICE_STARTER_ANNUAL=price_xxx
STRIPE_PRICE_PRO_MONTHLY=price_xxx
STRIPE_PRICE_PRO_ANNUAL=price_xxx
STRIPE_PRICE_STUDIO_MONTHLY=price_xxx
STRIPE_PRICE_STUDIO_ANNUAL=price_xxx
```

### Stripe setup script (one-time)

Creates products + prices + coupon in Stripe:

```python
import stripe

# Products
for tier in ["starter", "pro", "studio"]:
    product = stripe.Product.create(name=f"MyApp {tier.title()}")
    monthly = stripe.Price.create(
        product=product.id,
        unit_amount=PRICES[tier]["monthly"],  # in pence/cents
        currency="gbp",
        recurring={"interval": "month"},
        lookup_key=f"myapp_{tier}_monthly",
    )
    annual = stripe.Price.create(
        product=product.id,
        unit_amount=PRICES[tier]["annual"],
        currency="gbp",
        recurring={"interval": "year"},
        lookup_key=f"myapp_{tier}_annual",
    )

# Founder coupon (optional)
stripe.Coupon.create(
    id="FOUNDERS50",
    percent_off=50,
    duration="forever",
    name="Founder Member — 50% Off Forever",
)
```

### Webhook events to register

In Stripe Dashboard → Webhooks, subscribe to:
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`
- `invoice.payment_succeeded` (for affiliate/conversion tracking)

---

## 6. API Endpoints

### `GET /api/billing/status` (authenticated)

Returns current entitlement state for the logged-in user.

```json
{
  "plan": "pro",
  "is_trialing": true,
  "limits": { "templates_max": 20, "exports_per_month": 200, ... },
  "features": ["pdf_export", "catalogue", "sticker_editor", ...],
  "trial_ends_at": "2026-06-20T10:00:00Z",
  "stripe_subscription_status": null,
  "stripe_current_period_end": null,
  "founder_member": false
}
```

### `GET /api/billing/usage` (authenticated)

Returns current resource consumption vs caps.

```json
{
  "templates": { "used": 5, "limit": 20 },
  "exports_this_month": { "used": 12, "limit": 200 },
  "storage_mb": { "used": 450, "limit": 3072 },
  ...
}
```

### `GET /api/billing/plans` (public)

Marketing pricing data + founder offer state.

```json
{
  "plans": [
    {
      "key": "starter",
      "name": "Starter",
      "monthly_display": 25,
      "annual_display": 250,
      "effective_monthly_display": 12.5,
      "effective_annual_display": 125,
      "monthly_price_id": "price_xxx",
      "annual_price_id": "price_xxx",
      "features": ["10 templates", "50 exports/month", ...],
      "highlight": false
    },
    ...
  ],
  "founder_offer": {
    "active": true,
    "code": "FOUNDERS50",
    "discount_pct": 50,
    "ends_at": "2026-07-30T23:59:59Z",
    "ends_at_label": "30 July 2026"
  }
}
```

### `POST /api/billing/checkout` (authenticated)

Creates a Stripe Checkout session.

```json
// Request
{
  "price_id": "price_xxx",
  "success_url": "https://myapp.com/billing/success?session_id={CHECKOUT_SESSION_ID}",
  "cancel_url": "https://myapp.com/pricing?canceled=1",
  "coupon": "FOUNDERS50"  // optional
}

// Response
{ "url": "https://checkout.stripe.com/c/pay/cs_xxx" }
```

**Validation:**
- `price_id` must be in the known set of env-configured prices
- Returns **409** if user already has a live subscription (`active`, `trialing`, or `past_due`)
- Creates Stripe Customer if one doesn't exist yet

### `POST /api/billing/change-plan` (authenticated)

Opens a Stripe Customer Portal session for plan upgrade/downgrade.

```json
// Request
{ "price_id": "price_xxx", "return_url": "https://myapp.com/app/settings?plan_changed=1" }

// Response
{ "url": "https://billing.stripe.com/p/session/..." }
```

Requires an existing live subscription.

### `POST /api/billing/portal` (authenticated)

Opens the Stripe Customer Portal (manage card, view invoices, cancel).

```json
// Request
{ "return_url": "https://myapp.com/app/settings" }

// Response
{ "url": "https://billing.stripe.com/p/session/..." }
```

### `POST /api/billing/webhook` (public, Stripe-signed)

Receives Stripe webhook events. Verified via `stripe.Webhook.construct_event()`.

---

## 7. Checkout Flow

### Sequence

```
User on /pricing
    │
    ├─ No existing subscription:
    │   POST /api/billing/checkout
    │     → Creates Stripe Customer (if needed)
    │     → Creates Checkout Session (with coupon if founder)
    │     → Returns checkout URL
    │   User redirected to Stripe Checkout
    │   User pays
    │   Stripe fires checkout.session.completed webhook
    │     → apply_subscription_to_user()
    │     → trial_ends_at = NULL, status = "active"
    │   Stripe redirects to /billing/success?session_id=cs_xxx
    │   Frontend polls GET /status until plan !== "locked"
    │   Redirects to /app
    │
    └─ Existing subscription:
        POST /api/billing/change-plan
          → Opens Portal with subscription_update_confirm flow
          → User picks new plan in Stripe Portal
          → Stripe fires customer.subscription.updated webhook
          → apply_subscription_to_user() with new price_id
          → Redirects back to return_url
```

### Checkout session creation (backend)

```python
def create_checkout_session(user, price_id, success_url, cancel_url, coupon=None):
    # Get or create Stripe Customer
    customer_id = user.stripe_customer_id
    if not customer_id:
        customer = stripe.Customer.create(
            email=user.email,
            metadata={"user_id": str(user.id)},
        )
        user.stripe_customer_id = customer.id
        customer_id = customer.id

    params = {
        "mode": "subscription",
        "customer": customer_id,
        "client_reference_id": str(user.id),
        "line_items": [{"price": price_id, "quantity": 1}],
        "success_url": success_url,
        "cancel_url": cancel_url,
        "allow_promotion_codes": True,
        "subscription_data": {
            "metadata": {"user_id": str(user.id)},
        },
    }

    if coupon:
        params["discounts"] = [{"coupon": coupon}]
        params.pop("allow_promotion_codes", None)

    session = stripe.checkout.Session.create(**params)
    return session.url
```

---

## 8. Webhook Handling

### Verification + idempotency pattern

```python
@router.post("/webhook")
async def stripe_webhook(request: Request, db: Session):
    payload = await request.body()
    sig = request.headers.get("stripe-signature")

    # 1. Verify signature
    event = stripe.Webhook.construct_event(payload, sig, WEBHOOK_SECRET)

    # 2. Idempotency check
    result = db.execute(
        text("INSERT INTO stripe_events (event_id, event_type) "
             "VALUES (:eid, :etype) ON CONFLICT (event_id) DO NOTHING RETURNING id"),
        {"eid": event.id, "etype": event.type}
    )
    if result.rowcount == 0:
        return {"ok": True}  # Already processed

    # 3. Dispatch
    try:
        dispatch_event(db, event)
        db.commit()
    except Exception:
        db.rollback()
        # Delete idempotency record so it can be retried
        db.execute(text("DELETE FROM stripe_events WHERE event_id = :eid"), {"eid": event.id})
        db.commit()
        raise

    return {"ok": True}
```

### Event handlers

| Event | Handler |
|-------|---------|
| `checkout.session.completed` | Look up user by `client_reference_id`, retrieve subscription, call `apply_subscription_to_user()` |
| `customer.subscription.created` | Find user by subscription metadata `user_id`, call `apply_subscription_to_user()` |
| `customer.subscription.updated` | Same — updates plan/status/period |
| `customer.subscription.deleted` | Call `clear_subscription_on_user()` |
| `invoice.payment_failed` | Set `stripe_subscription_status = "past_due"` |
| `invoice.payment_succeeded` | Record affiliate conversion (if applicable) |

### `apply_subscription_to_user()`

```python
def apply_subscription_to_user(db, user, subscription):
    user.stripe_subscription_id = subscription.id
    user.stripe_subscription_status = subscription.status

    # Extract price from first subscription item
    price_id = subscription["items"]["data"][0]["price"]["id"]
    if price_id:
        user.stripe_price_id = price_id

    # Extract period end
    period_end = subscription.get("current_period_end")
    if period_end:
        user.stripe_current_period_end = datetime.fromtimestamp(period_end, tz=timezone.utc)

    # CRITICAL: Clear trial when subscription activates
    if subscription.status == "active" and user.trial_ends_at is not None:
        user.trial_ends_at = None

    # Detect founder coupon (permanent badge)
    if not user.founder_member:
        coupon_id = _extract_coupon_id(subscription)
        if coupon_id in FOUNDER_COUPON_IDS:
            user.founder_member = True

    db.commit()
```

### `clear_subscription_on_user()`

```python
def clear_subscription_on_user(db, user):
    user.stripe_subscription_status = "canceled"
    user.stripe_subscription_id = None
    user.stripe_price_id = None
    user.stripe_current_period_end = None
    db.commit()
    # User now resolves to "locked" in entitlements
    # (unless they have an active trial or enterprise tier)
```

---

## 9. Founder / Coupon Pricing

### Configuration

```python
FOUNDER_OFFER = {
    "code": "FOUNDERS50",
    "discount_pct": 50,
    "ends_at": datetime(2026, 7, 30, 23, 59, 59, tzinfo=timezone.utc),
    "ends_at_label": "30 July 2026",
}
FOUNDER_COUPON_IDS = {"FOUNDERS50", "founders50"}
```

### How it works

1. `GET /plans` checks if `now < ends_at` → includes `founder_offer.active = true`
2. Frontend displays discounted prices: `effective_monthly = monthly * (1 - discount_pct/100)`
3. On checkout, frontend passes `coupon: "FOUNDERS50"`
4. Backend applies `discounts: [{"coupon": coupon}]` to Checkout Session
5. Stripe applies 50% off forever to the subscription
6. On webhook, `apply_subscription_to_user()` detects the coupon → sets `founder_member = true`
7. `founder_member` is permanent — shown as a badge in UI, never cleared

### Adapting for your product

Replace with your own promotion structure. The pattern is:
- Server-side offer config (code, discount, expiry)
- `/plans` endpoint exposes offer state
- Frontend auto-applies coupon at checkout when active
- Webhook detects coupon for permanent badge/flag

---

## 10. Frontend Implementation

### Pages & components

| Component | Route/Location | Purpose |
|-----------|----------------|---------|
| `Pricing.tsx` | `/pricing` | Plan cards, checkout/change-plan triggers |
| `BillingSuccess.tsx` | `/billing/success` | Polls `/status` until active, then redirects to app |
| `Settings.tsx` | `/app/settings` | Shows current plan, trial status, portal button |
| `TrialBanner.tsx` | App layout shell | "X days left" warning bar (shows when ≤7d) |
| `LockedOverlay.tsx` | Feature pages | Blocks UI when locked, links to /pricing |

### Frontend API client (`billing.ts`)

```typescript
export function getBillingStatus(): Promise<BillingStatus> {
  return get("/api/billing/status");
}

export function getBillingUsage(): Promise<BillingUsage> {
  return get("/api/billing/usage");
}

export function getPlans(): Promise<PlansResponse> {
  return get("/api/billing/plans");
}

export function startCheckout(params: {
  price_id: string;
  success_url: string;
  cancel_url: string;
  coupon?: string;
}): Promise<{ url: string }> {
  return post("/api/billing/checkout", params);
}

export function changePlan(params: {
  price_id: string;
  return_url: string;
}): Promise<{ url: string }> {
  return post("/api/billing/change-plan", params);
}

export function openCustomerPortal(params: {
  return_url: string;
}): Promise<{ url: string }> {
  return post("/api/billing/portal", params);
}
```

### Lock detection hook

```typescript
export function useIsLocked(): boolean {
  const { me } = useAuth();
  if (!me) return true;
  if (me.stripe_subscription_status === "active") return false;
  if (me.tier === "enterprise") return false;
  if (me.trial_ends_at) {
    const end = new Date(me.trial_ends_at).getTime();
    if (end > Date.now()) return false;
  }
  return true;
}
```

### BillingSuccess polling

```typescript
// After Stripe checkout redirects here with ?session_id=
function BillingSuccess() {
  const [ready, setReady] = useState(false);
  
  useEffect(() => {
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      const status = await getBillingStatus();
      if (status.stripe_subscription_status === "active") {
        setReady(true);
        clearInterval(poll);
      }
      if (attempts > 30) clearInterval(poll); // ~30s timeout
    }, 1000);
    return () => clearInterval(poll);
  }, []);

  if (ready) return <Navigate to="/app" />;
  return <LoadingSpinner message="Activating your subscription..." />;
}
```

### Pricing page checkout logic

```typescript
const onSelectPlan = async (plan) => {
  const priceId = isAnnual ? plan.annual_price_id : plan.monthly_price_id;

  if (hasLiveSubscription) {
    // Already subscribed — open portal to switch plans
    const { url } = await changePlan({
      price_id: priceId,
      return_url: `${origin}/app/settings?plan_changed=1`,
    });
    window.location.href = url;
  } else {
    // New checkout
    const { url } = await startCheckout({
      price_id: priceId,
      success_url: `${origin}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pricing?canceled=1`,
      coupon: founderOffer?.active ? founderOffer.code : undefined,
    });
    window.location.href = url;
  }
};

// "hasLiveSubscription" includes active, trialing (Stripe), or past_due
const hasLiveSubscription = ["active", "trialing", "past_due"].includes(
  me.stripe_subscription_status
);
```

---

## 11. Feature Gates & Quota Enforcement

### Backend pattern

```python
from backend.services import entitlements

@router.post("/some-action")
def some_action(user = Depends(get_current_user), db = Depends(get_db)):
    ent = entitlements.for_user(user)

    # Feature gate
    if not ent.allows("pdf_export"):
        raise HTTPException(402, detail={
            "code": "plan_locked",
            "message": "Upgrade your plan to access this feature.",
            "upgrade_url": "/pricing",
        })

    # Quota check
    current_count = count_user_exports_this_month(db, user.id)
    if not ent.under_quota("exports_per_month", current_count):
        raise HTTPException(402, detail={
            "code": "quota_exceeded",
            "limit": "exports_per_month",
            "used": current_count,
            "max": ent.quota("exports_per_month"),
        })

    # ... proceed with action
```

### Frontend handling of 402

```typescript
try {
  await someAction();
} catch (err) {
  if (err.status === 402) {
    const detail = err.data;
    if (detail.code === "plan_locked") {
      showUpgradeModal(detail.message);
    } else if (detail.code === "quota_exceeded") {
      showQuotaWarning(detail.limit, detail.used, detail.max);
    }
  }
}
```

### Entitlement helper methods

```python
class Entitlement:
    plan: str           # "locked", "starter", "pro", "studio", "enterprise"
    is_trialing: bool
    limits: dict        # { "templates_max": 20, "exports_per_month": 200, ... }
    features: list[str] # ["pdf_export", "catalogue", ...]

    def allows(self, feature: str) -> bool:
        return feature in self.features

    def quota(self, key: str) -> int:
        return self.limits.get(key, 0)

    def under_quota(self, key: str, current: int) -> bool:
        limit = self.limits.get(key, 0)
        if limit == -1:  # unlimited (enterprise)
            return True
        return current < limit
```

---

## 12. Edge Cases & Important Notes

### Past-due subscriptions
- Stripe status `past_due` means payment failed but sub isn't canceled yet.
- **Entitlements treat this as locked** (only `active` unlocks).
- But checkout/change-plan treat it as "live" (prevent creating a second sub).
- User must fix payment via Portal to return to `active`.

### Stripe's own `trialing` status
- If you use Stripe's built-in trial (via `subscription_data.trial_period_days`),
  the status will be `trialing` until payment, then `active`.
- PrintLay does NOT use Stripe trials — it manages trials app-side via `trial_ends_at`.
- This means `stripe_subscription_status = "trialing"` does NOT grant access in this system.

### Enterprise override
- `user.tier = "enterprise"` bypasses all billing checks.
- Set manually by admin for invoiced/custom deals.
- Not affected by Stripe webhooks.

### Cancellation behavior
- `customer.subscription.deleted` → user becomes locked immediately.
- No grace period after cancellation (Stripe handles access until `current_period_end`
  for cancel-at-period-end; the `deleted` event fires when it actually ends).
- If user re-subscribes: normal checkout flow, new subscription created.

### Duplicate webhook protection
- Stripe can deliver the same event multiple times.
- The `stripe_events` table ensures each event is processed exactly once.
- On processing failure, the idempotency record is deleted so Stripe can retry.

### Admin bypass
- Admin users (detected by email) get enterprise entitlements regardless of billing state.
- They can still subscribe (for testing) but features are never gated.

---

## 13. Architecture Diagram

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   SIGNUP    │     │  STRIPE CHECKOUT │     │  STRIPE PORTAL  │
│             │     │                  │     │                 │
│ trial_ends  │     │  Creates sub     │     │  Change plan    │
│ = now + 7d  │     │  Redirects back  │     │  Update card    │
└──────┬──────┘     └────────┬─────────┘     │  Cancel         │
       │                     │               └────────┬────────┘
       ▼                     ▼                        │
┌──────────────────────────────────────────────────────────────┐
│                    WEBHOOK HANDLER                            │
│                                                              │
│  checkout.session.completed → apply_subscription_to_user()   │
│  subscription.updated       → apply_subscription_to_user()   │
│  subscription.deleted       → clear_subscription_on_user()   │
│  invoice.payment_failed     → status = "past_due"            │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                    users TABLE                                │
│                                                              │
│  stripe_subscription_status │ stripe_price_id │ trial_ends_at│
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│              ENTITLEMENTS (computed per-request)              │
│                                                              │
│  active sub? → plan from price_id                            │
│  enterprise? → unlimited                                     │
│  trial?      → pro (capped storage)                          │
│  else        → LOCKED                                        │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│              FEATURE GATES (in each API endpoint)            │
│                                                              │
│  ent.allows("feature")  → 402 plan_locked                   │
│  ent.under_quota("key") → 402 quota_exceeded                │
└──────────────────────────────────────────────────────────────┘
```

---

## Adapting for Your Product

### Must configure
- [ ] Your plan names, prices, and Stripe price IDs
- [ ] Your feature list and quota keys
- [ ] Your trial duration (or make it configurable)
- [ ] Your founder/launch coupon (or remove)
- [ ] Your webhook URL in Stripe Dashboard

### Keep as-is (patterns that work regardless of product)
- Entitlement resolution from user columns (no cron needed)
- Webhook idempotency via event table
- `apply_subscription_to_user()` / `clear_subscription_on_user()` pattern
- Trial clearing on subscription activation
- 402 error pattern for feature gates
- BillingSuccess polling pattern
- useIsLocked() hook for frontend gating
- Portal for self-service billing management

### Optional additions (not in current system)
- Stripe's built-in free trials (trial_period_days on subscription)
- Usage-based billing (metered prices)
- Team/seat-based plans
- Webhook retry queue (current system relies on Stripe retries)
- Dunning emails for failed payments (use Stripe's built-in or add custom)
