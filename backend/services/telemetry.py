"""PrintLay product telemetry.

Posts events to the dedicated `printlay/v1` REST namespace on
magicalplugins.com so they're isolated from the Murphy's connector's stream.
The matching WP plugin (`printlay-telemetry.php`) must be installed on the
host - until then, set `TELEMETRY_ENABLED=false` (the default) and these calls
are no-ops.

All sends are fire-and-forget on a background thread - they MUST NEVER block
or fail the request that triggered them. Errors are swallowed and logged at
DEBUG only.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from typing import Any

import httpx

from backend.config import get_settings
from backend.models import User
from backend.services.lmfwc import location_for_user

log = logging.getLogger(__name__)

TELEMETRY_PATH = "/wp-json/printlay/v1/telemetry"
TIMEOUT_S = 5.0


def emit(user: User | None, event: str, data: dict[str, Any] | None = None) -> None:
    """Queue a telemetry event for delivery on a background thread."""
    s = get_settings()
    if not s.telemetry_enabled or not s.license_server_url:
        return
    payload = {
        "shop": location_for_user(str(user.id)) if user else "anonymous",
        "license_key": (user.license_key if user else "") or "",
        "event": event,
        "data": data or {},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    threading.Thread(
        target=_post_safe,
        args=(f"{s.license_server_url.rstrip('/')}{TELEMETRY_PATH}", payload),
        daemon=True,
    ).start()


def _post_safe(url: str, payload: dict[str, Any]) -> None:
    try:
        httpx.post(
            url,
            json=payload,
            timeout=TIMEOUT_S,
            headers={"Content-Type": "application/json"},
        )
    except Exception as exc:
        log.debug("telemetry post failed: %s", exc)
