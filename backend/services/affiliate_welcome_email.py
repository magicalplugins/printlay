"""Branded welcome email for a hand-picked ("ghost") affiliate.

Sent automatically when an admin creates a ghost affiliate. It hands them
their vanity link, explains the deal (commission + 30-day trial invites)
and points them at the register page to set up their login. Setting up the
login does NOT unlock the product — the account is created locked; this
email is purely about getting them into their affiliate dashboard.

Mirrors invite_email.py: every style inlined, single 600px table, no web
fonts / flexbox / grid so it degrades on Gmail, Outlook and Apple Mail.
"""
from __future__ import annotations

import html
from dataclasses import dataclass

from backend.config import get_settings
from backend.services import messaging


@dataclass
class WelcomeSendResult:
    ok: bool
    error: str | None = None


def build_register_url() -> str:
    # The ?partner=1 flag tells the Register page to drop the "free trial"
    # language and present a partner-account setup instead (the affiliate
    # account is created locked, with no product trial).
    base = get_settings().public_base_url.rstrip("/")
    return f"{base}/register?partner=1"


def _html_body(
    *, name: str | None, share_url: str, commission_pct: int, register_url: str
) -> str:
    safe_share = html.escape(share_url, quote=True)
    safe_register = html.escape(register_url, quote=True)
    greeting = f"Hi {html.escape(name)}," if name else "Hi there,"

    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome to the Printlay partner programme</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a0a;">
  <tr>
    <td align="center" style="padding:40px 20px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#0f0f0f;border:1px solid #262626;border-radius:16px;overflow:hidden;">
        <tr>
          <td style="height:6px;background:linear-gradient(90deg,#8b5cf6 0%,#d946ef 100%);font-size:0;line-height:0;">&nbsp;</td>
        </tr>
        <tr>
          <td style="padding:36px 40px 0 40px;">
            <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#a3a3a3;font-weight:600;">
              Printlay · Partner programme
            </div>
            <h1 style="margin:24px 0 0 0;font-size:30px;line-height:1.15;font-weight:700;letter-spacing:-0.02em;color:#fafafa;">
              You're officially<br>
              <span style="color:#e879f9;">a Printlay partner.</span>
            </h1>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px 0 40px;">
            <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;color:#d4d4d4;">
              {greeting}
            </p>
            <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;color:#d4d4d4;">
              We've set you up as a hand-picked Printlay partner. You earn
              <strong style="color:#fafafa;">{commission_pct}% commission</strong>
              on every customer you bring in — and you can hand out
              <strong style="color:#fafafa;">30-day free trials</strong> to your
              contacts straight from your dashboard.
            </p>
          </td>
        </tr>
        <!-- Vanity link card -->
        <tr>
          <td style="padding:32px 40px 0 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.25);border-radius:12px;">
              <tr>
                <td align="center" style="padding:24px;">
                  <div style="font-size:12px;letter-spacing:2.5px;text-transform:uppercase;color:#a78bfa;font-weight:600;">
                    Your personal link
                  </div>
                  <div style="margin-top:10px;font-size:20px;line-height:1.3;font-weight:700;color:#fafafa;word-break:break-all;">
                    <a href="{safe_share}" style="color:#fafafa;text-decoration:none;">{safe_share}</a>
                  </div>
                  <div style="margin-top:8px;font-size:13px;color:#a3a3a3;">
                    Share it anywhere — we track every click, trial and sale back to you.
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
                  <a href="{safe_register}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.2px;">
                    Set up your dashboard →
                  </a>
                </td>
              </tr>
            </table>
            <div style="margin-top:16px;font-size:12px;color:#737373;line-height:1.5;">
              Sign up with <strong style="color:#a3a3a3;">this same email address</strong> and your
              partner dashboard unlocks automatically — track your funnel and send trial invites from there.
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px 40px 40px;">
            <hr style="border:none;border-top:1px solid #262626;margin:0 0 20px 0;">
            <p style="margin:0;font-size:12px;line-height:1.6;color:#737373;">
              Questions about payouts or how it all works? Just reply to this email.
            </p>
          </td>
        </tr>
      </table>
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


def _text_body(
    *, name: str | None, share_url: str, commission_pct: int, register_url: str
) -> str:
    greeting = f"Hi {name}," if name else "Hi there,"
    return (
        f"{greeting}\n\n"
        "You're officially a Printlay partner.\n\n"
        f"You earn {commission_pct}% commission on every customer you bring in,\n"
        "and you can hand out 30-day free trials to your contacts from your\n"
        "dashboard.\n\n"
        f"Your personal link: {share_url}\n\n"
        f"Set up your dashboard (use this same email): {register_url}\n\n"
        "Questions about payouts or how it works? Just reply to this email.\n\n"
        "— The Printlay team\n"
        "https://printlay.co.uk\n"
    )


def send(
    *,
    recipient_email: str,
    name: str | None,
    share_url: str,
    commission_rate: float,
) -> WelcomeSendResult:
    if not messaging.email_configured():
        return WelcomeSendResult(
            ok=False,
            error="Email provider not configured (RESEND_API_KEY missing)",
        )

    commission_pct = int(round(commission_rate * 100))
    register_url = build_register_url()
    subject = "Welcome to the Printlay partner programme"
    results = messaging.send_email_bulk(
        [recipient_email],
        subject=subject,
        text_body=_text_body(
            name=name,
            share_url=share_url,
            commission_pct=commission_pct,
            register_url=register_url,
        ),
        html_body=_html_body(
            name=name,
            share_url=share_url,
            commission_pct=commission_pct,
            register_url=register_url,
        ),
    )
    if not results:
        return WelcomeSendResult(ok=False, error="No result returned from mailer")
    r = results[0]
    return WelcomeSendResult(ok=r.ok, error=r.error)
