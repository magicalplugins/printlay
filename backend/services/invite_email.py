"""Branded transactional email for an admin-issued trial invite.

Design intent:
    The recipient should *feel* hand-picked — copy is short, warm and
    deliberately exclusive. Visual treatment mirrors the in-app gradient
    (violet → fuchsia) on a near-black background so it lands as
    unmistakably Printlay.

    Email clients are notoriously fussy with CSS, so every style is
    inlined and we avoid background-images, web fonts, flexbox and
    grid. The layout is a single 600px-wide centred table that
    degrades gracefully on Gmail, Outlook and Apple Mail.

The HTML body is built with simple f-strings rather than a templating
engine — there's exactly one template and we want zero new deps.
"""
from __future__ import annotations

import html
from dataclasses import dataclass

from backend.config import get_settings
from backend.services import messaging


@dataclass
class InviteSendResult:
    ok: bool
    error: str | None = None


def build_invite_url(token: str) -> str:
    """The recipient lands on /register?invite=<token>. The SPA picks
    up the token and shows the special welcome hero before handing
    off to Supabase sign-up."""
    base = get_settings().public_base_url.rstrip("/")
    return f"{base}/register?invite={token}"


def _html_body(*, trial_days: int, invite_url: str, recipient_email: str) -> str:
    safe_url = html.escape(invite_url, quote=True)
    safe_email = html.escape(recipient_email)
    # Plural-safe — "1 day" / "2 days". The body uses this directly so
    # we never get "30-day of full Pro access" again.
    days_label = f"{trial_days} day" if trial_days == 1 else f"{trial_days} days"

    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>You're invited to Printlay</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a0a;">
  <tr>
    <td align="center" style="padding:40px 20px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#0f0f0f;border:1px solid #262626;border-radius:16px;overflow:hidden;">
        <!-- Gradient top bar -->
        <tr>
          <td style="height:6px;background:linear-gradient(90deg,#8b5cf6 0%,#d946ef 100%);font-size:0;line-height:0;">&nbsp;</td>
        </tr>
        <!-- Header -->
        <tr>
          <td style="padding:36px 40px 0 40px;">
            <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#a3a3a3;font-weight:600;">
              Printlay
            </div>
            <h1 style="margin:24px 0 0 0;font-size:30px;line-height:1.15;font-weight:700;letter-spacing:-0.02em;color:#fafafa;">
              You've been<br>
              <span style="color:#e879f9;">personally invited.</span>
            </h1>
          </td>
        </tr>
        <!-- Body copy -->
        <tr>
          <td style="padding:24px 40px 0 40px;">
            <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;color:#d4d4d4;">
              We only send a handful of these — Printlay is brand new and we're
              hand-picking a small group of print operators to use it free,
              full-access, before we open the doors properly.
            </p>
            <p style="margin:0 0 0 0;font-size:16px;line-height:1.6;color:#d4d4d4;">
              Your invite is good for
              <strong style="color:#fafafa;">{days_label} of full Pro access</strong> —
              every feature, no card required, no automatic charge at the end.
              When the trial winds down we'll quietly let you know; if you love
              it, you stay on (with our Founder's discount). If not, no hard
              feelings.
            </p>
          </td>
        </tr>
        <!-- Stat card -->
        <tr>
          <td style="padding:32px 40px 0 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.25);border-radius:12px;">
              <tr>
                <td align="center" style="padding:24px;">
                  <div style="font-size:12px;letter-spacing:2.5px;text-transform:uppercase;color:#a78bfa;font-weight:600;">
                    Your exclusive trial
                  </div>
                  <div style="margin-top:6px;font-size:44px;line-height:1;font-weight:700;color:#fafafa;letter-spacing:-0.02em;">
                    {days_label}
                  </div>
                  <div style="margin-top:6px;font-size:13px;color:#a3a3a3;">
                    Full Pro features · No card required
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- CTA button -->
        <tr>
          <td align="center" style="padding:32px 40px 0 40px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#8b5cf6" style="background:linear-gradient(90deg,#8b5cf6 0%,#d946ef 100%);border-radius:10px;">
                  <a href="{safe_url}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.2px;">
                    Activate your trial →
                  </a>
                </td>
              </tr>
            </table>
            <div style="margin-top:16px;font-size:12px;color:#737373;line-height:1.5;">
              Or paste this into your browser:<br>
              <a href="{safe_url}" style="color:#a78bfa;text-decoration:none;word-break:break-all;">{safe_url}</a>
            </div>
          </td>
        </tr>
        <!-- Fine print -->
        <tr>
          <td style="padding:32px 40px 40px 40px;">
            <hr style="border:none;border-top:1px solid #262626;margin:0 0 20px 0;">
            <p style="margin:0;font-size:12px;line-height:1.6;color:#737373;">
              This invitation was sent to <strong style="color:#a3a3a3;">{safe_email}</strong>
              and is single-use. The link expires in 30 days.
              If you weren't expecting this, you can safely ignore it — nothing
              happens until you click through and sign up.
            </p>
          </td>
        </tr>
      </table>
      <!-- Footer -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;margin-top:24px;">
        <tr>
          <td align="center" style="padding:0 20px;font-size:11px;color:#525252;line-height:1.6;">
            Printlay · print-ready in four moves<br>
            <a href="https://printlay.co.uk" style="color:#737373;text-decoration:none;">printlay.co.uk</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>
"""


def _text_body(*, trial_days: int, invite_url: str) -> str:
    days_label = f"{trial_days} day" if trial_days == 1 else f"{trial_days} days"
    return (
        "You've been personally invited to Printlay.\n\n"
        "We're hand-picking a small group of print operators to use Printlay\n"
        "free and full-access before we open the doors properly. Your invite is\n"
        f"good for {days_label} of full Pro access — every feature, no card\n"
        "required, no automatic charge at the end.\n\n"
        f"Activate your trial: {invite_url}\n\n"
        "The link expires in 30 days. If you weren't expecting this, you can\n"
        "safely ignore it.\n\n"
        "— The Printlay team\n"
        "https://printlay.co.uk\n"
    )


def send(*, recipient_email: str, trial_days: int, token: str) -> InviteSendResult:
    """Send a single invite email. Wraps `messaging.send_email_bulk` (one
    recipient) so we get its retry/error handling for free."""
    if not messaging.email_configured():
        return InviteSendResult(
            ok=False,
            error="Email provider not configured (RESEND_API_KEY missing)",
        )

    url = build_invite_url(token)
    days_label = f"{trial_days} day" if trial_days == 1 else f"{trial_days} days"
    subject = f"You're invited — {days_label} of Printlay, on us"
    results = messaging.send_email_bulk(
        [recipient_email],
        subject=subject,
        text_body=_text_body(trial_days=trial_days, invite_url=url),
        html_body=_html_body(
            trial_days=trial_days, invite_url=url, recipient_email=recipient_email
        ),
    )
    if not results:
        return InviteSendResult(ok=False, error="No result returned from mailer")
    r = results[0]
    return InviteSendResult(ok=r.ok, error=r.error)
