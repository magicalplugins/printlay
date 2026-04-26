"""Per-user rate limiting via slowapi.

Keyed by the authenticated user's `auth_id` when present, falling back to
client IP for anonymous endpoints. We use the in-memory backend - good enough
for a single-machine Fly deployment with `min_machines_running = 0`. If we
later scale to N replicas we can swap in Redis / Upstash.
"""

from __future__ import annotations

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from backend.config import get_settings


def _key_func(request: Request) -> str:
    auth = getattr(request.state, "auth_user", None)
    if auth and getattr(auth, "auth_id", None):
        return f"user:{auth.auth_id}"
    header = request.headers.get("authorization")
    if header and header.lower().startswith("bearer "):
        return f"token:{header[-32:]}"
    return f"ip:{get_remote_address(request)}"


limiter = Limiter(
    key_func=_key_func,
    default_limits=[],
    storage_uri="memory://",
)


def generate_limit() -> str:
    return f"{get_settings().rate_limit_generate_per_hour}/hour"


def generate_burst_limit() -> str:
    """Per-minute cap stacked alongside the hourly limit on `/generate`.
    See `rate_limit_generate_per_minute` in config for the rationale."""
    return f"{get_settings().rate_limit_generate_per_minute}/minute"
