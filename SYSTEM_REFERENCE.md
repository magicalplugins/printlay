# Printlay System Reference — Trials, Leads, Chat, Users, Affiliates & Admin

> This document captures the complete architecture of Printlay's user management,
> trial system, lead capture, messaging, affiliate programme, and admin area.
> It is intended to be passed to another system to recreate equivalent functionality.
> Billing timescales, tiers, and notification preferences are left as placeholders
> since the target product has not finalised these.

---

## Table of Contents

1. [User Model & Authentication](#1-user-model--authentication)
2. [Trial System](#2-trial-system)
3. [Invite System](#3-invite-system)
4. [Lead Capture (Chat Widget)](#4-lead-capture-chat-widget)
5. [Admin Bulk Messaging (Compose)](#5-admin-bulk-messaging-compose)
6. [User Admin & Map View](#6-user-admin--map-view)
7. [Affiliate System](#7-affiliate-system)
8. [Entitlements & Access Control](#8-entitlements--access-control)
9. [Integration Credentials](#9-integration-credentials)
10. [Frontend Routes](#10-frontend-routes)

---

## 1. User Model & Authentication

### Database Schema — `users`

| Field | Type | Purpose |
|-------|------|---------|
| `id` | UUID (PK) | |
| `email` | string (unique) | Login identity |
| `phone` | string(40)? | Optional, used for SMS + map geolocation |
| `company_name` | string? | Business name |
| `trial_ends_at` | datetime? | Absolute trial expiry. Null = no trial granted (locked) |
| `stripe_customer_id` | string? | Stripe customer |
| `stripe_subscription_id` | string? | Active subscription |
| `stripe_subscription_status` | string? | `active`, `past_due`, `canceled`, `trialing` etc. |
| `plan` | string? | Plan key (e.g. `starter`, `pro`, `studio`) |
| `tier` | string? | Direct override (`enterprise`) |
| `founder_member` | bool | Founder pricing locked in |
| `is_admin` | bool | Super-admin flag |
| `is_active` | bool | Can be deactivated by admin |
| `referred_by_affiliate_id` | UUID? FK | Affiliate who brought this user |
| `created_at` | datetime | |
| `last_seen_at` | datetime? | Updated on activity |

### Authentication

- **Provider**: Supabase Auth (email + magic link, or email + password)
- **Session**: Supabase JWT → backend verifies via Supabase client
- **First provision**: `GET /api/auth/me` on first login creates the internal user record
  - Honors `?invite={token}` for trial days
  - Honors `?ref={code}` or `plref` cookie for affiliate attribution
  - Default trial: 7 days (configurable constant `TRIAL_DAYS`)

---

## 2. Trial System

### How Trials Work

1. User signs up → `trial_ends_at = now() + TRIAL_DAYS` (default 7)
2. If signup has a valid invite token → `trial_ends_at = now() + invite.trial_days`
3. Trial grants Pro-tier access (all features, capped storage)
4. When `trial_ends_at <= now()` and no active subscription → account is **locked**
5. Locked accounts see a `LockedOverlay` — must subscribe to continue

### Trial Duration Display

Formula (computed client-side):
```
daysLeft = Math.max(0, Math.ceil((trial_ends_at - Date.now()) / 86400000))
```

Display locations:
| Location | Format | Color coding |
|----------|--------|--------------|
| Admin user list pill | `trial · {N}d` | Green (>5d), Amber (3–5d), Rose (≤2d) |
| Admin invite list | `{trial_days}d` (grant length) | — |
| User trial banner | "X days left on your free trial" | Shows when ≤7d remain |
| User settings | "X days remaining" + progress bar | — |

### Trial Status Filters (Admin)

- `trialing`: `trial_ends_at > now AND stripe_subscription_status != 'active'`
- `locked`: `trial_ends_at <= now AND no active subscription`

---

## 3. Invite System

### Database Schema — `trial_invites`

| Field | Type | Purpose |
|-------|------|---------|
| `id` | UUID (PK) | |
| `email` | string | Recipient (lowercased) |
| `token` | string (unique) | URL token for `/register?invite={token}` |
| `trial_days` | int (1–180) | Days of Pro trial granted on redemption |
| `note` | text? | Admin-internal note |
| `invited_by_user_id` | UUID? FK | Admin who created it |
| `affiliate_id` | UUID? FK | Affiliate who promoted it |
| `expires_at` | datetime | Link expiry (30 days from creation) |
| `sent_at` | datetime? | Last email send timestamp |
| `accepted_at` | datetime? | When redeemed |
| `accepted_user_id` | UUID? FK | User who redeemed |
| `revoked_at` | datetime? | Soft-revoke |

### API Endpoints

**Public:**
- `GET /api/invites/{token}` → `{ email, trial_days }` (validates not expired/revoked/accepted)

**Admin** (requires admin):
- `GET /api/admin/invites?status=&limit=&offset=` → paginated list
- `POST /api/admin/invites` body `{ email, trial_days, note? }` → creates invite + sends email
- `POST /api/admin/invites/{id}/resend` → re-sends email (same token)
- `POST /api/admin/invites/{id}/revoke` body `{ revoke: bool }` → revoke/restore
- `GET /api/admin/invites/pending-count` → `{ pending: number }`

**Affiliate** (authenticated affiliate):
- `POST /api/affiliate/invites` body `{ email, note? }` → fixed 30-day invite
- `GET /api/affiliate/invites` → list sent invites

### Invite Flow

```
Admin/Affiliate → POST /api/admin/invites (or /api/affiliate/invites)
  → Creates TrialInvite record (token, expires_at = +30d)
  → Sends branded HTML email with link: /register?invite={token}
  → Recipient clicks → Register page pre-fills email, shows trial days
  → User signs up (Supabase) → sessionStorage stores token
  → First GET /api/auth/me?invite={token}
  → user_provisioning: trial_ends_at = now + invite.trial_days
  → invite.accepted_at = now, invite.accepted_user_id = user.id
```

### Invite Email Template

Branded HTML email sent via SMTP2GO or Resend. Contains:
- Product logo
- Personalized greeting
- Trial duration callout
- CTA button → `/register?invite={token}`
- Plain-text fallback

---

## 4. Lead Capture (Chat Widget)

### Database Schema — `leads`

| Field | Type | Purpose |
|-------|------|---------|
| `id` | UUID (PK) | |
| `name` | string(120) | Submitter name |
| `email` | string(320) | Contact email |
| `message` | text | Message body |
| `source` | string | Default `"widget"` |
| `page_url` | string(512)? | URL when submitted |
| `phone` | string(40)? | Optional (presales category) |
| `user_id` | UUID? FK | Set if submitter is logged in |
| `status` | enum | `new` → `read` → `responded` → `archived` |
| `category` | enum | `support`, `presales`, `bug_feature`, `general` |
| `created_at` | datetime | |

### Chat Widget (`LeadChatWidget.tsx`)

Floating bottom-right widget on all public pages (hidden on admin/auth routes).

**Flow:**
1. "Chat with us" pill → opens panel
2. Category picker: Support / Pre-Sales / Bug & Feature Request
3. Form fields:
   - Name (required)
   - Email (required, pre-filled if logged in)
   - Phone (optional, shown for presales only)
   - Message (required, textarea)
4. Submits `POST /api/leads` with `page_url` and affiliate `ref` from localStorage
5. Success confirmation, auto-closes after 4 seconds
6. Rate limited: 10 submissions per hour

### API Endpoints

**Public:**
- `POST /api/leads` body `{ name, email, message, page_url?, category, phone?, ref? }`
  - Optional auth: attaches `user_id` if logged in
  - Affiliate attribution: `ref` param or `plref` cookie → records `affiliate_event`

**Admin:**
- `GET /api/admin/leads?status=&category=&limit=&offset=` → `{ total, unread, items, counts_by_category }`
- `GET /api/admin/leads/unread-count` → `{ unread: number }`
- `PATCH /api/admin/leads/{id}` body `{ status }` → update lead status

### Admin Leads Inbox (`AdminLeads.tsx`)

- Filter by status (new/read/responded/archived) and category
- Search by email/name/message
- Date buckets (today, this week, older)
- Opening a lead auto-marks it `read`
- Reply via `mailto:` link (no in-app reply thread)
- Deep link: `?focus={lead_id}` opens detail pane
- Links to user detail if `user_id` is set
- Unread badge count shown in admin navigation

---

## 5. Admin Bulk Messaging (Compose)

### Overview

Admin can send email or SMS to user segments. Messages are delivered via
external providers and logged in audit — **not stored in a messages DB table**.
There is no in-app notification inbox for users.

### Compose UI — Exact Fields (`MessageComposer.tsx`)

| Field | Type | Options / Constraints |
|-------|------|----------------------|
| **Channel** | Toggle | `email` or `sms` |
| **Recipient segment** | Dropdown | 8 predefined segments (see below) |
| **Subject** | Text input | Max 200 chars, **email only**, required |
| **Body** | Textarea | Max 10,000 chars, plain text |
| **Preview** | Button | Dry run → shows recipient count |
| **Send** | Button | Requires preview first + confirm dialog |

### Segments (recipient groups)

| ID | Label | Backend Logic |
|----|-------|---------------|
| `all` | Everyone | All active users |
| `active_subscribers` | Active subscribers | `stripe_subscription_status == "active"` |
| `trialing` | On trial | Trial active, not subscribed |
| `dropouts` | Drop-offs | Canceled, past-due, or expired trial |
| `expiring_30d` | Renewing within 30 days | Active subs renewing within 30d |
| `most_active_30d` | Most active (last 30d) | Top users by output count |
| `stuck_signup` | Signed up · no template | Registered >7d, zero templates |
| `stuck_template` | Template · no PDF | Has templates >7d, zero outputs |

### API Endpoints

- `POST /api/admin/messages` body:
  ```json
  {
    "segment": "trialing",
    "channel": "email",
    "subject": "Your trial is ending soon",
    "body": "Plain text message...",
    "html_body": "<optional HTML>",
    "dry_run": false,
    "limit": 2000
  }
  ```
  Returns: `{ sent: number, failed: number, failures: [...] }`

- `GET /api/admin/messaging/status` → `{ email_configured, email_provider, sms_configured }`

### Delivery Pipeline

```
MessageComposer → POST /api/admin/messages
  → Resolve segment → list of users (email or phone)
  → Deduplicate, cap at limit (default 2000)
  → If dry_run: return count only
  → Sequential send with throttling (0.05s email, 0.1s SMS)
  → Log to audit_events: action="admin.message_sent", detail={segment, channel, sent, failed}
  → Return per-recipient success/failure
```

### Delivery Providers

| Channel | Primary | Fallback |
|---------|---------|----------|
| Email | SMTP2GO | Resend |
| SMS | Twilio | — |

---

## 6. User Admin & Map View

### Admin Users Page (`AdminUsers.tsx`)

**Features:**
- **Table / Map toggle** (two view modes)
- Search by email/company
- Status filter tabs: All, Active, Trialing, Past Due, Canceled, Locked, Deactivated
- "Affiliates only" toggle → `?affiliate=true`
- Pagination (50 per page)
- User rows show: email, company, plan pill, trial status, last seen

**User Detail Drawer:**
- Billing info (plan, subscription status, Stripe link)
- Usage stats (templates, outputs, storage)
- Recent jobs/outputs
- Admin actions: set tier, toggle founder, deactivate, expire trial, delete
- Impersonation link

### Plan/Status Pill (`PlanPill` component)

| Condition | Display | Color |
|-----------|---------|-------|
| Active subscription | Plan name (e.g. "Pro") | Green |
| Trialing, >5d left | `trial · {N}d` | Green |
| Trialing, 3–5d left | `trial · {N}d` | Amber |
| Trialing, ≤2d left | `trial · {N}d` | Rose |
| Trial expired / locked | `locked` | Gray |
| Canceled | `canceled` | Red |
| Deactivated | `deactivated` | Gray |

### Map View (`UserWorldMap.tsx`)

**Library:** `react-simple-maps` v3
- Components: `ComposableMap`, `ZoomableGroup`, `Geographies`, `Marker`, `Line`
- Basemap: TopoJSON from `https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json`
- Projection: `geoMercator`, scale 140, center `[10, 30]`

**Geolocation Method (approximate, phone-prefix based):**
1. Match user's phone number against `PHONE_PREFIX_TO_BBOX` (~40 country codes)
2. Place marker at a **seeded random point** inside that country's bounding box
   - Deterministic per user ID (same user always same position)
3. Users without a mappable phone prefix are excluded
4. UI shows "{N} without location" count

**Map Features:**
- Markers: colored initials ring (color derived from user ID hash)
- Tooltip on hover: email, company, subscription status
- Decorative network lines between nearby markers (max ~120 lines)
- Click marker → opens user detail drawer
- Loads up to 500 users when map mode is active

### API Endpoints

- `GET /api/admin/stats` → `{ total_users, trialing_users, active_subscribers, locked_users, ... }`
- `GET /api/admin/users?q=&stripe_status=&affiliate=&limit=&offset=` → paginated user list
- `GET /api/admin/users/active?limit=` → most active (30d)
- `GET /api/admin/users/subscribers` → paying users
- `GET /api/admin/users/dropouts` → churn/stuck users
- `GET /api/admin/users/{id}` → full user detail
- `PATCH /api/admin/users/{id}` body `{ tier?, founder_member?, is_active?, expire_trial? }`
- `DELETE /api/admin/users/{id}` → full account deletion

---

## 7. Affiliate System

### Database Schema

#### `affiliate_profiles`

| Field | Type | Purpose |
|-------|------|---------|
| `id` | UUID (PK) | |
| `user_id` | UUID? FK (unique) | Linked after login |
| `email` | string | Contact email |
| `name` | string | Display name |
| `ref_code` | string (unique, 8 chars) | Referral code |
| `status` | enum | `active`, `paused`, `banned` |
| `is_ghost` | bool | Admin-created partner |
| `vanity_slug` | string? (unique) | Custom URL slug |
| `welcome_email_sent_at` | datetime? | Ghost welcome email |
| `commission_rate` | float | Default 0.20 (20%) |
| `min_payout_threshold_pence` | int | Default 5000 (£50) |
| `payout_day_of_month` | int | Default 1 |
| `pending_balance_pence` | int | Earned but not yet paid |
| `total_earned_pence` | int | Lifetime earnings |
| `total_paid_pence` | int | Lifetime payouts |
| `stripe_connect_account_id` | string? | Stripe Express account |
| `stripe_connect_onboarding_complete` | bool | |
| `created_at` | datetime | |

#### `affiliate_clicks`

| Field | Type | Purpose |
|-------|------|---------|
| `id` | UUID (PK) | |
| `affiliate_id` | UUID FK | |
| `ip_hash` | string | Hashed IP for dedup |
| `user_agent_snippet` | string | Browser info |
| `landing_path` | string | Page they landed on |
| `clicked_at` | datetime | |
| `converted` | bool | Whether this click led to signup |

#### `affiliate_conversions`

| Field | Type | Purpose |
|-------|------|---------|
| `id` | UUID (PK) | |
| `affiliate_id` | UUID FK | |
| `click_id` | UUID? FK | Optional link to click |
| `referred_user_id` | UUID FK | |
| `stripe_invoice_id` | string? | First payment invoice |
| `stripe_charge_amount_pence` | int | Payment amount |
| `commission_pence` | int | Commission earned |
| `commission_type` | string | `first_payment` |
| `status` | enum | `pending` → `approved` / `reversed` |
| `approved_at` | datetime? | |
| `converted_at` | datetime | |

#### `affiliate_events`

| Field | Type | Purpose |
|-------|------|---------|
| `id` | UUID (PK) | |
| `affiliate_id` | UUID FK | |
| `event_type` | enum | `signup`, `lead`, `invite` |
| `referred_user_id` | UUID? | |
| `lead_id` | UUID? | |
| `detail` | string? | Description |
| `created_at` | datetime | |

#### `affiliate_payouts`

| Field | Type | Purpose |
|-------|------|---------|
| `id` | UUID (PK) | |
| `affiliate_id` | UUID FK | |
| `stripe_transfer_id` | string | |
| `amount_pence` | int | |
| `status` | string | |
| `period_start` | datetime | |
| `period_end` | datetime | |
| `paid_at` | datetime? | |

### Referral Link Format

1. **Regular affiliates:** `{base_url}/r/{ref_code}` (8-char alphanumeric)
2. **Ghost affiliates with vanity:** `{base_url}/{vanity_slug}` (e.g. `printlay.co.uk/partner-name`)
3. Share link function returns vanity URL if set, otherwise `/r/{ref_code}`

### Attribution Flow

```
1. Visitor hits /r/{ref_code} or /{vanity_slug}
2. Backend records click in affiliate_clicks
3. Sets 30-day first-party cookie "plref" (httponly, secure, samesite=lax)
4. Redirects to homepage (normal site experience)
5. On signup: GET /api/auth/me reads ?ref= query OR plref cookie
6. user_provisioning links referred_by_affiliate_id, records "signup" event
7. On lead submit: ref from body or plref cookie → "lead" event
8. On first Stripe payment (webhook): conversion created (14-day hold)
9. After 14 days: auto-approved, balance credited
10. Payout via Stripe Connect Express when balance ≥ threshold
```

### Attribution Priority (`user_provisioning.py`)

1. Explicit `affiliate_ref` (query param or cookie)
2. Else `trial_invites.affiliate_id` if invite was redeemed
3. Never self-attribute (affiliate referring themselves)

### Commission Model

- **First payment only** (`commission_type: first_payment`)
- Default **20%** commission, configurable per affiliate
- **14-day hold** before auto-approval
- Payout via **Stripe Connect Express** when balance ≥ threshold (default £50)
- Admin can manually approve/reverse conversions
- Admin can trigger payout runs

### Three Ways Affiliates Are Created

| Method | Flow | Access |
|--------|------|--------|
| **Public self-signup** | `/affiliate` page → `POST /api/affiliate/signup` (email+name, no account) | Must later register to get dashboard |
| **Existing customer joins** | Dashboard → `POST /api/affiliate/join` | Immediate dashboard access |
| **Admin ghost partner** | Admin UI → `POST /api/admin/affiliate/create-ghost` (email, name, vanity, commission) | Welcome email → `/register?partner=1` → locked account (no trial unless admin also sends invite) |

### Affiliate-Only vs Full User

| Scenario | Product Access | Affiliate Dashboard |
|----------|----------------|---------------------|
| Ghost partner registers | **Locked** (no trial_ends_at) | Yes, after email links profile |
| Ghost + admin sends invite | Full trial per invite days | Yes |
| Regular self-signup (pre-register) | N/A until register | Profile exists, no dashboard |
| Existing customer joins | Keeps existing access | Yes |
| Referred customer | Normal trial | No (unless also an affiliate) |

### API Endpoints

**Public:**
- `GET /api/affiliate/click/{ref_code}` → record click, set cookie, redirect
- `POST /api/affiliate/signup` body `{ email, name }`

**Authenticated affiliate:**
- `POST /api/affiliate/join` → existing user joins
- `GET /api/affiliate/dashboard` → stats, share link, balances
- `GET /api/affiliate/clicks` → recent clicks
- `GET /api/affiliate/conversions` → recent conversions
- `GET /api/affiliate/events` → funnel events
- `POST /api/affiliate/invites` → send 30-day trial invite
- `GET /api/affiliate/invites` → list sent invites
- `POST /api/affiliate/connect/onboard` → Stripe Connect setup
- `POST /api/affiliate/connect/check` → check onboarding status
- `GET /api/affiliate/connect/login-link` → Stripe Express dashboard

**Admin:**
- `GET /api/admin/affiliate/overview` → programme stats
- `GET /api/admin/affiliate/list?status=` → list affiliates
- `POST /api/admin/affiliate/create-ghost` body `{ email, name, vanity_slug?, commission_rate? }`
- `POST /api/admin/affiliate/{id}/resend-welcome` → re-send welcome email
- `GET /api/admin/affiliate/{id}/referrals` → drill-down on referrals + enquiries
- `PATCH /api/admin/affiliate/{id}` body `{ status?, commission_rate?, vanity_slug?, min_payout_threshold_pence? }`
- `DELETE /api/admin/affiliate/{id}` → delete (logic depends on linked account)
- `POST /api/admin/affiliate/conversions/{id}/override` body `{ action: "approve"|"reverse" }`
- `POST /api/admin/affiliate/payouts/run` → approve held + run payouts
- `GET /api/admin/affiliate/payouts` → recent payouts

### Deletion Logic

| Linked account? | Paying/admin? | Result |
|-----------------|---------------|--------|
| No | — | Affiliate records deleted only |
| Yes | Paying or admin | Affiliate records deleted, account preserved |
| Yes | Non-paying, non-admin | **Full account wipe** + affiliate records |

### Affiliate Dashboard Features

- Share link (vanity or `/r/` format)
- 30-day trial invites (send to prospects)
- Funnel stats: Clicks → Trials → Enquiries → Sales
- Conversion rates, commission %, balances
- Stripe Connect payout setup + dashboard link
- Recent activity: signups, leads, invites
- Recent conversions and clicks

---

## 8. Entitlements & Access Control

### Tier Resolution (`entitlements.py`)

Priority order:
1. `tier` field set directly (e.g. `"enterprise"`) → that tier
2. `stripe_subscription_status == "active"` → plan from subscription
3. `trial_ends_at > now()` → `"pro"` (trial gets Pro features)
4. None of above → `"locked"`

### What "Locked" Means

- `LockedOverlay` component covers the app UI
- User can still access: settings, billing page (to subscribe), affiliate dashboard
- Cannot access: templates, sheet builder, exports, catalogue

### Feature Gates (adapt to your tiers)

| Feature | Starter | Pro | Studio | Enterprise |
|---------|---------|-----|--------|------------|
| Templates | 10 | 20 | 50 | Unlimited |
| Exports/month | 50 | 200 | 500 | Unlimited |
| Categories | 10 | 30 | 100 | Unlimited |
| Colour profiles | 2 | 5 | 20 | Unlimited |
| Storage | 1 GB | 3 GB | 10 GB | Unlimited |

> **Note for target product:** Replace these limits with your own tiers.
> The entitlement system checks `tier` + `plan` and returns feature caps.

---

## 9. Integration Credentials

### Admin Integration Settings

Credentials stored encrypted in `app_settings` table (key-value, encrypted values).

| Provider | Keys | Purpose |
|----------|------|---------|
| SMTP2GO | `smtp2go.api_key`, `smtp2go.from_email` | Primary email delivery |
| Resend | `resend.api_key`, `resend.from_email` | Fallback email |
| Twilio | `twilio.account_sid`, `twilio.auth_token`, `twilio.from_number` | SMS delivery |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Billing (env vars) |
| Stripe Connect | Same Stripe key | Affiliate payouts |

### API Endpoints

- `GET /api/admin/integrations` → list credential keys (no values)
- `PUT /api/admin/integrations` body `{ key, value }` → set/clear credential
- `POST /api/admin/integrations/test` body `{ channel, recipient }` → send test

---

## 10. Frontend Routes

### Public Routes

| Route | Component | Purpose |
|-------|-----------|---------|
| `/` | Landing | Marketing page |
| `/register` | Register | Signup, honors `?invite=` and `?ref=` and `?partner=1` |
| `/login` | Login | Auth |
| `/affiliate` | AffiliateSignup | Public affiliate signup (no login) |
| `/r/{ref_code}` | — (server redirect) | Affiliate click tracking |
| `/{vanity_slug}` | — (server redirect) | Ghost affiliate vanity link |

### Authenticated App Routes

| Route | Component | Purpose |
|-------|-----------|---------|
| `/app` | Dashboard | Main dashboard |
| `/app/affiliate` | AffiliateDashboard | Affiliate stats + invites |
| `/app/settings` | Settings | Account, billing, trial display |

### Admin Routes

| Route | Component | Purpose |
|-------|-----------|---------|
| `/app/admin` | Admin | Stats overview + compose message button |
| `/app/admin/users` | AdminUsers | User table + map toggle |
| `/app/admin/leads` | AdminLeads | Lead inbox |
| `/app/admin/invites` | AdminInvites | Trial invite management |
| `/app/admin/affiliate` | AdminAffiliate | Affiliate programme management |
| `/app/admin/integrations` | AdminIntegrations | Messaging credentials |

### Global Components

| Component | Mount Point | Purpose |
|-----------|-------------|---------|
| `LeadChatWidget` | All pages (except admin/auth) | Floating contact form |
| `TrialBanner` | App shell | "X days left" warning |
| `LockedOverlay` | App shell | Blocks access when locked |

---

## Architecture Notes for Target Product

### What to keep as-is
- Trial invite system (flexible days, token-based, email delivery)
- Lead capture widget (category + form + admin inbox)
- Affiliate tracking (cookie + attribution + commission)
- User map (phone-prefix geolocation, react-simple-maps)
- Compose message (segment picker + channel + preview/send)
- Entitlement/access gating logic

### What to adapt
- **Billing timescales/tiers**: Replace Printlay's Starter/Pro/Studio with your own
- **Trial duration**: Make `TRIAL_DAYS` configurable
- **Notification preferences**: Not implemented yet in Printlay — build from scratch
- **Feature gates**: Map to your product's features instead of templates/exports
- **Segments**: Create segments relevant to your product's engagement metrics
- **Stripe plan IDs**: Wire to your own Stripe products

### What's intentionally absent (build if needed)
- In-app notification inbox for users
- Bidirectional chat/reply system
- Message templates in compose UI
- Scheduled/automated messaging
- Lead map view (currently users-only)
- Notification preferences page (planned but not built)
