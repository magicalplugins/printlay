"""PrintLay product telemetry.

Stub module kept for import compatibility. Previously posted to a WordPress
plugin on magicalplugins.com — that integration has been removed. All calls
to `emit()` are now no-ops. The module is preserved so callers don't need to
be updated; it can be replaced with a real analytics sink (Posthog, Segment,
etc.) in a future phase without touching routers.
"""
from __future__ import annotations

from typing import Any

from backend.models import User


def emit(user: User | None, event: str, data: dict[str, Any] | None = None) -> None:
    """No-op stub. Wire up a real sink here when ready."""
    return
