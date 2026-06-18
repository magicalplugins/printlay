"""Local disk cache for R2 object downloads.

Transparently caches files fetched from R2 on the server's filesystem,
avoiding repeated multi-MB downloads for the same asset across
consecutive generation runs. Uses an LRU eviction strategy with a
configurable max size (default 1 GB).
"""

from __future__ import annotations

import hashlib
import os
import threading
import time
from pathlib import Path

from backend.services import storage

_CACHE_DIR = Path(os.environ.get("R2_CACHE_DIR", "/tmp/r2_cache"))
_MAX_BYTES = int(os.environ.get("R2_CACHE_MAX_MB", "1024")) * 1024 * 1024
_lock = threading.Lock()

# In-memory index: r2_key -> (local_path, size, last_access_time)
_index: dict[str, tuple[Path, int, float]] = {}
_total_bytes = 0


def _ensure_dir() -> None:
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _evict_if_needed(needed: int) -> None:
    """Evict oldest entries until there's room for `needed` bytes."""
    global _total_bytes
    while _total_bytes + needed > _MAX_BYTES and _index:
        oldest_key = min(_index, key=lambda k: _index[k][2])
        path, size, _ = _index.pop(oldest_key)
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        _total_bytes -= size


def _key_to_filename(r2_key: str) -> str:
    return hashlib.sha256(r2_key.encode()).hexdigest()


def get_bytes(r2_key: str) -> bytes:
    """Fetch bytes for an R2 key, using local cache when available."""
    global _total_bytes
    with _lock:
        if r2_key in _index:
            path, size, _ = _index[r2_key]
            if path.exists():
                _index[r2_key] = (path, size, time.time())
                return path.read_bytes()
            else:
                _total_bytes -= size
                del _index[r2_key]

    data = storage.get_bytes(r2_key)

    with _lock:
        _ensure_dir()
        _evict_if_needed(len(data))
        fname = _key_to_filename(r2_key)
        path = _CACHE_DIR / fname
        try:
            path.write_bytes(data)
            _index[r2_key] = (path, len(data), time.time())
            _total_bytes += len(data)
        except OSError:
            pass

    return data


def get_bytes_uncached(r2_key: str) -> bytes:
    """Bypass cache — direct R2 fetch."""
    return storage.get_bytes(r2_key)


def invalidate(r2_key: str) -> None:
    """Remove a specific key from the cache (e.g. after asset deletion)."""
    global _total_bytes
    with _lock:
        entry = _index.pop(r2_key, None)
        if entry:
            path, size, _ = entry
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
            _total_bytes -= size


def clear() -> None:
    """Wipe the entire cache."""
    global _total_bytes
    with _lock:
        for _, (path, _, _) in _index.items():
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        _index.clear()
        _total_bytes = 0
