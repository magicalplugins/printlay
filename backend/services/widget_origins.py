"""Resolve which origins are allowed to embed the widget / call the widget API.

Merchants add their shop domains at runtime (stored in `widget_settings.
allowed_origins`), so the global startup CORS list can't cover them. This module
keeps a short-TTL in-process cache of the union of all merchants' allowed
origins, refreshed lazily, so the scoped widget CORS middleware can decide
without a DB hit on every request.
"""
from __future__ import annotations

from threading import Lock
from time import monotonic

from backend.database import get_session_factory
from backend.models import WidgetSettings

_TTL_S = 30.0
_cache: set[str] = set()
_fetched_at: float = 0.0
_lock = Lock()


def _load() -> set[str]:
    factory = get_session_factory()
    db = factory()
    try:
        rows = db.query(WidgetSettings.allowed_origins).all()
    finally:
        db.close()
    origins: set[str] = set()
    for (value,) in rows:
        if not value:
            continue
        for origin in value:
            if isinstance(origin, str) and origin.strip():
                origins.add(origin.strip().rstrip("/"))
    return origins


def allowed_origins(force_refresh: bool = False) -> set[str]:
    global _cache, _fetched_at
    with _lock:
        if force_refresh or monotonic() - _fetched_at >= _TTL_S or not _cache:
            try:
                _cache = _load()
                _fetched_at = monotonic()
            except Exception:
                # On any DB hiccup keep serving the last known set rather than
                # breaking every widget request.
                pass
        return _cache


def is_allowed(origin: str | None) -> bool:
    if not origin:
        return False
    return origin.strip().rstrip("/") in allowed_origins()
