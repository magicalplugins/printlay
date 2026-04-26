"""Bulk messaging adapters for the admin outreach panel.

Two channels:
- **Email** via Resend (https://resend.com). Cheap, simple, good
  deliverability. Requires `RESEND_API_KEY` and a `RESEND_FROM_EMAIL`
  matching a verified domain.
- **SMS** via Twilio. Requires `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`
  + `TWILIO_FROM_NUMBER` (or Messaging Service SID).

Both functions are conservative: they send sequentially with a tiny
sleep between requests, swallow per-recipient failures into a result
record, and never raise to the caller. The admin endpoint surfaces the
per-recipient results so we can show a clear "23 sent / 2 failed" UI.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Iterable

import httpx

from backend.config import get_settings

log = logging.getLogger(__name__)


@dataclass
class SendResult:
    recipient: str
    ok: bool
    error: str | None = None


def email_configured() -> bool:
    s = get_settings()
    return bool(s.resend_api_key and s.resend_from_email)


def sms_configured() -> bool:
    s = get_settings()
    return bool(s.twilio_account_sid and s.twilio_auth_token and s.twilio_from_number)


def send_email_bulk(
    recipients: Iterable[str],
    *,
    subject: str,
    text_body: str,
    html_body: str | None = None,
    throttle_s: float = 0.05,
) -> list[SendResult]:
    """Sends one email per recipient. Resend's batch API takes up to 100
    addresses per call but loses per-recipient failure detail; for early
    outreach volumes single-shot is fine."""
    s = get_settings()
    out: list[SendResult] = []
    if not email_configured():
        return [SendResult(r, False, "Email provider not configured") for r in recipients]

    headers = {
        "Authorization": f"Bearer {s.resend_api_key}",
        "Content-Type": "application/json",
    }

    with httpx.Client(timeout=20.0) as client:
        for rcpt in recipients:
            payload = {
                "from": s.resend_from_email,
                "to": [rcpt],
                "subject": subject,
                "text": text_body,
            }
            if html_body:
                payload["html"] = html_body
            try:
                r = client.post(
                    "https://api.resend.com/emails",
                    json=payload,
                    headers=headers,
                )
                if r.status_code >= 300:
                    out.append(SendResult(rcpt, False, f"HTTP {r.status_code}: {r.text[:160]}"))
                else:
                    out.append(SendResult(rcpt, True))
            except httpx.HTTPError as exc:
                out.append(SendResult(rcpt, False, str(exc)))
            if throttle_s:
                time.sleep(throttle_s)
    return out


def send_sms_bulk(
    recipients: Iterable[str],
    *,
    body: str,
    throttle_s: float = 0.1,
) -> list[SendResult]:
    s = get_settings()
    out: list[SendResult] = []
    if not sms_configured():
        return [SendResult(r, False, "SMS provider not configured") for r in recipients]

    url = f"https://api.twilio.com/2010-04-01/Accounts/{s.twilio_account_sid}/Messages.json"
    auth = (s.twilio_account_sid or "", s.twilio_auth_token or "")

    with httpx.Client(timeout=20.0, auth=auth) as client:
        for rcpt in recipients:
            data = {"To": rcpt, "From": s.twilio_from_number, "Body": body}
            try:
                r = client.post(url, data=data)
                if r.status_code >= 300:
                    out.append(SendResult(rcpt, False, f"HTTP {r.status_code}: {r.text[:160]}"))
                else:
                    out.append(SendResult(rcpt, True))
            except httpx.HTTPError as exc:
                out.append(SendResult(rcpt, False, str(exc)))
            if throttle_s:
                time.sleep(throttle_s)
    return out
