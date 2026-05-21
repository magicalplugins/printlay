"""Bulk messaging adapters for the admin outreach panel + transactional
invite emails.

Two channels:
- **Email** — prefers SMTP2GO (HTTP API at https://api.smtp2go.com),
  falls back to Resend if SMTP2GO isn't configured. Pick a provider
  per environment via `SMTP2GO_API_KEY` / `SMTP2GO_FROM_EMAIL` or the
  Resend equivalents.
- **SMS** via Twilio. Requires `TWILIO_ACCOUNT_SID` +
  `TWILIO_AUTH_TOKEN` + `TWILIO_FROM_NUMBER` (or Messaging Service SID).

Both functions are conservative: they send sequentially with a tiny
sleep between requests, swallow per-recipient failures into a result
record, and never raise to the caller. The admin endpoint surfaces the
per-recipient results so we can show a clear "23 sent / 2 failed" UI.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from typing import Iterable, Literal

import httpx

from backend.config import get_settings

log = logging.getLogger(__name__)


@dataclass
class SendResult:
    recipient: str
    ok: bool
    error: str | None = None


EmailProvider = Literal["smtp2go", "resend", "none"]


def active_email_provider() -> EmailProvider:
    """Which provider will actually be used on the next send. SMTP2GO
    wins if both are configured, so the UI can show "SMTP2GO" rather
    than the legacy provider."""
    s = get_settings()
    if s.smtp2go_api_key and s.smtp2go_from_email:
        return "smtp2go"
    if s.resend_api_key and s.resend_from_email:
        return "resend"
    return "none"


def email_configured() -> bool:
    return active_email_provider() != "none"


def sms_configured() -> bool:
    s = get_settings()
    return bool(s.twilio_account_sid and s.twilio_auth_token and s.twilio_from_number)


# SMTP2GO wants the sender as separate "name" + "address" fields rather
# than a single RFC-5322 string, so we split a "Name <addr@x>" form
# defensively here. Plain `addr@x` is also accepted.
_RFC5322_RE = re.compile(r"\s*(?P<name>.*?)\s*<(?P<addr>[^>]+)>\s*$")


def _split_sender(raw: str) -> tuple[str | None, str]:
    """Return (display_name, email_address) for a sender string."""
    m = _RFC5322_RE.match(raw or "")
    if m:
        name = m.group("name").strip().strip('"') or None
        return name, m.group("addr").strip()
    return None, (raw or "").strip()


def _send_via_smtp2go(
    client: httpx.Client,
    *,
    api_key: str,
    sender: str,
    rcpt: str,
    subject: str,
    text_body: str,
    html_body: str | None,
) -> SendResult:
    """SMTP2GO HTTP API. Auth via X-Smtp2go-Api-Key header; one
    recipient per call so per-recipient errors surface cleanly."""
    name, addr = _split_sender(sender)
    sender_field = f'"{name}" <{addr}>' if name else addr
    payload: dict = {
        "sender": sender_field,
        "to": [rcpt],
        "subject": subject,
        "text_body": text_body,
    }
    if html_body:
        payload["html_body"] = html_body
    try:
        r = client.post(
            "https://api.smtp2go.com/v3/email/send",
            json=payload,
            headers={
                "X-Smtp2go-Api-Key": api_key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
    except httpx.HTTPError as exc:
        return SendResult(rcpt, False, str(exc))

    # SMTP2GO always returns HTTP 200 (even on auth/quota failures) with
    # the real error inside `data.error_code`. Treat any non-zero
    # `succeeded` as success, otherwise extract a useful message.
    try:
        body = r.json()
    except ValueError:
        return SendResult(rcpt, False, f"HTTP {r.status_code}: non-JSON response")
    data = body.get("data") or {}
    if r.status_code >= 300:
        return SendResult(
            rcpt, False, f"HTTP {r.status_code}: {body.get('error') or r.text[:160]}"
        )
    if int(data.get("succeeded", 0)) >= 1:
        return SendResult(rcpt, True)
    err = data.get("error") or data.get("error_code") or "unknown error"
    failures = data.get("failures") or []
    if failures:
        err = f"{err}: {failures[0]}"
    return SendResult(rcpt, False, str(err)[:200])


def _send_via_resend(
    client: httpx.Client,
    *,
    api_key: str,
    sender: str,
    rcpt: str,
    subject: str,
    text_body: str,
    html_body: str | None,
) -> SendResult:
    payload: dict = {
        "from": sender,
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
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )
    except httpx.HTTPError as exc:
        return SendResult(rcpt, False, str(exc))
    if r.status_code >= 300:
        return SendResult(rcpt, False, f"HTTP {r.status_code}: {r.text[:160]}")
    return SendResult(rcpt, True)


def send_email_bulk(
    recipients: Iterable[str],
    *,
    subject: str,
    text_body: str,
    html_body: str | None = None,
    throttle_s: float = 0.05,
) -> list[SendResult]:
    """Send one email per recipient via the active provider. SMTP2GO is
    preferred when configured; falls back to Resend, then returns a
    clear "not configured" SendResult per recipient if neither is set."""
    s = get_settings()
    provider = active_email_provider()
    recipients_list = list(recipients)

    if provider == "none":
        return [
            SendResult(r, False, "Email provider not configured")
            for r in recipients_list
        ]

    out: list[SendResult] = []
    with httpx.Client(timeout=20.0) as client:
        for rcpt in recipients_list:
            if provider == "smtp2go":
                out.append(
                    _send_via_smtp2go(
                        client,
                        api_key=s.smtp2go_api_key or "",
                        sender=s.smtp2go_from_email or "",
                        rcpt=rcpt,
                        subject=subject,
                        text_body=text_body,
                        html_body=html_body,
                    )
                )
            else:
                out.append(
                    _send_via_resend(
                        client,
                        api_key=s.resend_api_key or "",
                        sender=s.resend_from_email,
                        rcpt=rcpt,
                        subject=subject,
                        text_body=text_body,
                        html_body=html_body,
                    )
                )
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
