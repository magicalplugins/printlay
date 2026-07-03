# Twilio SMS Integration — Implementation Reference

This document describes the Twilio SMS integration used in PrintLay for admin-to-user bulk messaging. It is intended as a self-contained reference for replicating this system in another project.

---

## Architecture Overview

```
Admin UI (MessageComposer / AdminIntegrations)
    │
    ▼
POST /api/admin/messages  ──or──  POST /api/admin/integrations/test
    │
    ▼
backend/routers/admin.py  (audience segmentation, dedup, dry-run)
    │
    ▼
backend/services/messaging.py  →  send_sms_bulk()
    │
    ▼
httpx POST → https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json
    ▲
    │
Credentials resolved from: encrypted DB store → env var → config.py
```

No Twilio SDK is used. SMS is sent via direct HTTP POST to the Twilio REST API using Python's `httpx` library with HTTP Basic auth.

---

## 1. Credentials

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `TWILIO_ACCOUNT_SID` | Twilio Account SID (starts with `AC...`) |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_FROM_NUMBER` | E.164 phone number **or** Messaging Service SID |

### Resolution Order

Credentials are resolved at runtime in this priority:

1. **Encrypted DB** — admin saves values via the Integrations UI; stored Fernet-encrypted in an `app_settings` table
2. **Environment variable** — fallback if no DB entry exists
3. **Pydantic settings** — final fallback from `backend/config.py`

If any of the three values is missing, SMS is **silently disabled** (no errors raised, functions return "not configured" results).

### Encrypted Store

The secrets store (`backend/services/secrets_store.py`) maps logical keys to env vars:

```python
KNOWN_KEYS = {
    "twilio.account_sid": "TWILIO_ACCOUNT_SID",
    "twilio.auth_token": "TWILIO_AUTH_TOKEN",
    "twilio.from_number": "TWILIO_FROM_NUMBER",
}
```

Encryption uses `cryptography.fernet.Fernet` with `APP_SECRETS_MASTER_KEY` as the key. If the master key isn't set, reads fall through to env vars; writes raise `StoreUnavailable`.

---

## 2. Backend Service (`backend/services/messaging.py`)

### Core Function: `send_sms_bulk()`

```python
from dataclasses import dataclass

@dataclass
class SendResult:
    recipient: str
    ok: bool
    error: str | None = None


def sms_configured() -> bool:
    """Returns True only if all three Twilio credentials are present."""
    return bool(
        _get("twilio.account_sid")
        and _get("twilio.auth_token")
        and _get("twilio.from_number")
    )


def send_sms_bulk(
    recipients: Iterable[str],
    *,
    body: str,
    throttle_s: float = 0.1,
) -> list[SendResult]:
    """Send one SMS per recipient via Twilio REST API.

    - Sequential sends with configurable throttle (default 100ms between)
    - Per-recipient error isolation (one failure doesn't abort the batch)
    - Returns a list of SendResult for the caller to surface in UI
    """
    if not sms_configured():
        return [SendResult(r, False, "SMS provider not configured") for r in recipients]

    sid = _get("twilio.account_sid") or ""
    token = _get("twilio.auth_token") or ""
    from_number = _get("twilio.from_number") or ""

    url = f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
    auth = (sid, token)  # HTTP Basic

    with httpx.Client(timeout=20.0, auth=auth) as client:
        for rcpt in recipients:
            data = {"To": rcpt, "From": from_number, "Body": body}
            try:
                r = client.post(url, data=data)
                if r.status_code >= 300:
                    results.append(SendResult(rcpt, False, f"HTTP {r.status_code}: {r.text[:160]}"))
                else:
                    results.append(SendResult(rcpt, True))
            except httpx.HTTPError as exc:
                results.append(SendResult(rcpt, False, str(exc)))
            if throttle_s:
                time.sleep(throttle_s)
    return results
```

### Key Design Decisions

- **No SDK** — avoids a dependency; the Messages endpoint is simple enough for raw HTTP
- **Sequential with throttle** — respects Twilio rate limits; 0.1s default = ~10 SMS/sec
- **Never raises** — failures are captured per-recipient so the admin sees "23 sent / 2 failed"
- **`httpx.Client` context manager** — connection pooling across the batch

---

## 3. API Endpoints (`backend/routers/admin.py`)

All endpoints require admin authentication (`require_admin` dependency).

### `POST /api/admin/messages` — Send Bulk Message

**Request body:**

```json
{
  "segment": "all",
  "channel": "sms",
  "body": "Your message text here",
  "subject": null,
  "html_body": null,
  "dry_run": false,
  "limit": 2000
}
```

| Field | Type | Notes |
|-------|------|-------|
| `segment` | enum | One of: `all`, `active_subscribers`, `trialing`, `dropouts`, `most_active_30d`, `stuck_signup`, `stuck_template`, `expiring_30d` |
| `channel` | `"email" \| "sms"` | Determines provider and recipient field |
| `body` | string (1–10,000 chars) | Message text |
| `subject` | string (optional) | Required for email, ignored for SMS |
| `html_body` | string (optional) | Email only |
| `dry_run` | boolean | If true, resolves recipients but doesn't send |
| `limit` | int (1–10,000) | Max recipients per send |

**Response:**

```json
{
  "segment": "all",
  "channel": "sms",
  "recipients_total": 25,
  "sent": 23,
  "failed": 2,
  "dry_run": false,
  "results": [
    { "recipient": "+447...", "ok": true, "error": null },
    { "recipient": "+447...", "ok": false, "error": "HTTP 400: ..." }
  ]
}
```

**Flow:**
1. Validates channel config (raises 503 if not configured and not dry_run)
2. Resolves segment → users with non-empty `phone` field
3. Deduplicates recipients
4. If `dry_run: true` → returns recipient list without sending
5. Calls `messaging.send_sms_bulk(recipients, body=payload.body)`
6. Logs audit event `admin.message_sent`

### `GET /api/admin/messaging/status` — Check Configuration

**Response:**

```json
{
  "email_configured": true,
  "email_provider": "smtp2go",
  "sms_configured": true
}
```

### `GET /api/admin/integrations` — List Credentials

Returns which keys are set (never returns plaintext values):

```json
{
  "email_configured": true,
  "sms_configured": true,
  "settings": [
    { "key": "twilio.account_sid", "is_set": true },
    { "key": "twilio.auth_token", "is_set": true },
    { "key": "twilio.from_number", "is_set": true }
  ]
}
```

### `PUT /api/admin/integrations` — Save/Clear Credential

```json
{ "key": "twilio.account_sid", "value": "ACxxxxxxxx" }
```

Pass empty string to clear. Values are Fernet-encrypted before storage.

### `POST /api/admin/integrations/test` — Send Test SMS

```json
{ "channel": "sms", "recipient": "+447123456789" }
```

**Response:**

```json
{ "ok": true, "error": null, "provider": "twilio" }
```

Sends a real SMS: "Printlay integration test — your SMS integration works."

---

## 4. Audience Segmentation

The `_resolve_segment(db, segment, limit)` function in `admin.py` queries users based on these segments:

| Segment | Description | Filter Logic |
|---------|-------------|--------------|
| `all` | All active users | Has `email`, not deleted |
| `active_subscribers` | Paying users | `stripe_subscription_status = 'active'` |
| `trialing` | Trial users | `stripe_subscription_status = 'trialing'` |
| `dropouts` | Churned users | Status in `canceled`, `past_due`, `unpaid`, OR trial expired |
| `most_active_30d` | Power users | Most PDF exports in last 30 days |
| `stuck_signup` | Onboarding stuck | Signed up >7 days ago, no template created |
| `stuck_template` | Template but no output | Has templates but never generated a PDF |
| `expiring_30d` | Renewal approaching | Active subscription ending within 30 days |

For SMS, only users with a non-empty `phone` field are included (phone is collected during profile setup in E.164 format).

---

## 5. Frontend UI

### MessageComposer (`frontend/src/components/admin/MessageComposer.tsx`)

A modal component rendered on the Admin page with:

- **Channel toggle** — email / SMS radio buttons
- **Segment picker** — 8 segments with descriptive hints
- **Body textarea** — with character count hint for SMS (~160 chars per segment)
- **Dry-run button** — resolves recipients without sending, shows preview list
- **Send button** — fires the real send, shows results summary
- **Status warnings** — if Twilio not configured, shows inline alert

**Usage:**

```tsx
import { MessageComposer } from "../components/admin/MessageComposer";

// In your admin page:
{showComposer && <MessageComposer onClose={() => setShowComposer(false)} />}
```

### AdminIntegrations (`frontend/src/pages/AdminIntegrations.tsx`)

Page at `/app/admin/integrations` with:

- Input fields for each credential key (masked for secrets)
- Save button per field (calls `PUT /api/admin/integrations`)
- "Send test" button for SMS (calls `POST /api/admin/integrations/test`)
- Status indicators showing which integrations are configured

### Frontend API Client (`frontend/src/api/admin.ts`)

```typescript
export type Segment =
  | "all" | "active_subscribers" | "trialing" | "dropouts"
  | "most_active_30d" | "stuck_signup" | "stuck_template" | "expiring_30d";

export type MessageRequest = {
  segment: Segment;
  channel: "email" | "sms";
  subject?: string;
  body: string;
  html_body?: string | null;
  dry_run?: boolean;
  limit?: number;
};

export type MessagingStatus = {
  email_configured: boolean;
  email_provider: "smtp2go" | "resend" | "none";
  sms_configured: boolean;
};

export const sendAdminMessage = (req: MessageRequest) =>
  api<MessageResponse>("/api/admin/messages", {
    method: "POST",
    body: JSON.stringify(req),
  });

export const getMessagingStatus = () =>
  api<MessagingStatus>("/api/admin/messaging/status");

export const getIntegrations = () =>
  api<IntegrationsResponse>("/api/admin/integrations");

export const setIntegration = (key: string, value: string) =>
  api<IntegrationsResponse>("/api/admin/integrations", {
    method: "PUT",
    body: JSON.stringify({ key, value }),
  });

export const testIntegration = (channel: "email" | "sms", recipient: string) =>
  api<IntegrationTestResult>("/api/admin/integrations/test", {
    method: "POST",
    body: JSON.stringify({ channel, recipient }),
  });
```

---

## 6. Key Implementation Patterns

### Graceful Disable

If Twilio credentials are missing, `sms_configured()` returns `false`. The UI shows a warning; the send endpoint returns HTTP 503. No crashes, no partial state.

### Dry-Run Preview

Setting `dry_run: true` resolves the full recipient list (segment query + dedup) and returns it without sending. The admin can review who would receive the message before committing.

### Deduplication

Recipients are deduplicated by value before sending:

```python
seen: set[str] = set()
deduped: list[str] = []
for r in recipients:
    if r in seen:
        continue
    seen.add(r)
    deduped.append(r)
```

### Audit Logging

Every send is recorded via `record(db, admin, "admin.message_sent", payload={...})` with segment, channel, recipient count, sent/failed counts.

### Per-Recipient Error Isolation

One failed send doesn't abort the batch. Each recipient gets its own `SendResult` with a clear error message. The admin sees the full breakdown.

### Throttling

Default 100ms between SMS sends (~10/sec). Configurable via `throttle_s` parameter. Integration tests use `throttle_s=0` for instant feedback.

---

## 7. Database Requirements

### User Model

Users must have a `phone` field (nullable string, E.164 format like `+447123456789`). Only users with a populated phone field receive SMS.

### App Settings Table (for encrypted store)

```sql
CREATE TABLE app_settings (
    id UUID PRIMARY KEY,
    key VARCHAR(100) UNIQUE NOT NULL,
    encrypted_value TEXT NOT NULL,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Dependencies

```
httpx>=0.24
cryptography>=41.0
```

No `twilio` Python package is needed.

---

## 8. Quick-Start Checklist

1. Set env vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
2. Ensure users have a `phone` field in E.164 format
3. Implement `send_sms_bulk()` as shown above
4. Wire up admin endpoints with authentication
5. Build a composer UI with segment picker, dry-run, and results display
6. Test with `POST /api/admin/integrations/test` before going live

---

## 9. Twilio Console Setup

1. Create a Twilio account at https://www.twilio.com
2. Get your Account SID and Auth Token from the dashboard
3. Buy a phone number or create a Messaging Service
4. If using a Messaging Service SID as `TWILIO_FROM_NUMBER`, prefix it with `MG...`
5. Verify your sender number is SMS-capable for your target countries
6. For UK numbers, ensure regulatory bundle is approved
