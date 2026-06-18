"""Merchant API key generation + hashing.

Keys look like ``pl_live_<43 url-safe base64 chars>``. We show the plaintext
to the merchant exactly once at creation and store only a SHA-256 hash, so a
leaked database never exposes usable keys. Lookups hash the presented key and
match on the unique ``key_hash`` column.

The ``prefix`` (e.g. ``pl_live_a1b2c3d4``) is a non-secret identifier surfaced
in the admin UI so a merchant can recognise and rotate a key without seeing the
secret again.
"""
from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass

_KEY_PREFIX = "pl_live_"
_PREFIX_VISIBLE_CHARS = 8  # chars of the random body kept in the stored prefix


@dataclass(slots=True)
class GeneratedKey:
    plaintext: str
    """Full secret — return to the caller once, never stored."""
    prefix: str
    """Non-secret identifier stored + shown in the admin, e.g. 'pl_live_a1b2c3d4'."""
    key_hash: str
    """SHA-256 hex digest of the plaintext."""


def hash_key(plaintext: str) -> str:
    """SHA-256 hex digest of a full plaintext key. Used for both storage and
    constant-work lookup."""
    return hashlib.sha256(plaintext.strip().encode("utf-8")).hexdigest()


def generate_key() -> GeneratedKey:
    body = secrets.token_urlsafe(32)
    plaintext = f"{_KEY_PREFIX}{body}"
    prefix = f"{_KEY_PREFIX}{body[:_PREFIX_VISIBLE_CHARS]}"
    return GeneratedKey(
        plaintext=plaintext,
        prefix=prefix,
        key_hash=hash_key(plaintext),
    )


def looks_like_key(value: str | None) -> bool:
    """Cheap shape check so obviously-wrong bearer tokens (e.g. Supabase JWTs)
    can be rejected before a DB lookup."""
    return bool(value) and value.strip().startswith(_KEY_PREFIX)
