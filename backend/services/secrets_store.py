"""Encrypted runtime credential store.

The admin Integrations page calls into this to read/write secret
values (SMTP2GO API key, Twilio auth token, etc.) without ever
touching plaintext on the way through the API. Everything written
here is Fernet-encrypted with `settings.app_secrets_master_key` and
persisted to the `app_settings` table.

Consumers (e.g. `messaging.py`) call `get(key)` to pull a decrypted
value, with a transparent env-var fallback so the bootstrap workflow
keeps working before the admin has typed anything into the UI.

Keys we currently manage (canonical names — keep them in sync with
the UI and the env-var fallbacks):
    smtp2go.api_key       <→ env SMTP2GO_API_KEY
    smtp2go.from_email    <→ env SMTP2GO_FROM_EMAIL
    resend.api_key        <→ env RESEND_API_KEY
    resend.from_email     <→ env RESEND_FROM_EMAIL
    twilio.account_sid    <→ env TWILIO_ACCOUNT_SID
    twilio.auth_token     <→ env TWILIO_AUTH_TOKEN
    twilio.from_number    <→ env TWILIO_FROM_NUMBER
"""
from __future__ import annotations

import logging
import os
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.database import get_session_factory
from backend.models import AppSetting

log = logging.getLogger(__name__)

# Public catalogue of known keys + the env var each one falls back to.
# Anything not in this map is rejected by `set()` to keep the namespace
# tidy and prevent typo'd keys from silently being ignored.
KNOWN_KEYS: dict[str, str] = {
    "smtp2go.api_key": "SMTP2GO_API_KEY",
    "smtp2go.from_email": "SMTP2GO_FROM_EMAIL",
    "resend.api_key": "RESEND_API_KEY",
    "resend.from_email": "RESEND_FROM_EMAIL",
    "twilio.account_sid": "TWILIO_ACCOUNT_SID",
    "twilio.auth_token": "TWILIO_AUTH_TOKEN",
    "twilio.from_number": "TWILIO_FROM_NUMBER",
}


class StoreUnavailable(Exception):
    """Raised when `APP_SECRETS_MASTER_KEY` isn't set — admin can't
    persist new values, but reads still work via env-var fallback."""


@dataclass(frozen=True)
class SettingMeta:
    key: str
    is_set: bool
    """True when either a DB value or an env fallback is present."""
    source: str
    """'db' | 'env' | 'none' — tells the UI whether the value is
    admin-managed (rotatable in-product) or env-only (rotatable only
    via fly secrets set)."""
    updated_at: datetime | None
    updated_by_user_id: uuid.UUID | None


# ---- internal: Fernet handling ------------------------------------------------


_fernet_lock = threading.Lock()
_fernet_cache: Fernet | None = None


def _fernet() -> Fernet:
    """Lazy, thread-safe Fernet instance. Reused across calls; rebuilt
    only if the master key changes (which we don't expect at runtime
    but handle defensively)."""
    global _fernet_cache
    s = get_settings()
    key = s.app_secrets_master_key
    if not key:
        raise StoreUnavailable(
            "APP_SECRETS_MASTER_KEY is not set; persistent secret storage is disabled."
        )
    with _fernet_lock:
        if _fernet_cache is None or getattr(_fernet_cache, "_key_str", None) != key:
            try:
                f = Fernet(key.encode() if isinstance(key, str) else key)
            except (ValueError, TypeError) as exc:
                raise StoreUnavailable(
                    f"APP_SECRETS_MASTER_KEY is not a valid Fernet key: {exc}"
                ) from exc
            setattr(f, "_key_str", key)
            _fernet_cache = f
    return _fernet_cache


def encryption_available() -> bool:
    """Cheap check for the UI ('Can the admin save anything?')."""
    try:
        _fernet()
    except StoreUnavailable:
        return False
    return True


def encrypt_value(plaintext: str) -> str:
    """Fernet-encrypt an arbitrary string (e.g. a per-user API key) and
    return an ASCII token suitable for storing in a DB column.

    Raises StoreUnavailable if APP_SECRETS_MASTER_KEY is missing."""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_value(token: str | None) -> str | None:
    """Decrypt a token produced by `encrypt_value`. Returns None on a
    missing/blank token, a bad token, or a missing master key."""
    if not token:
        return None
    try:
        fernet = _fernet()
    except StoreUnavailable:
        return None
    try:
        return fernet.decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError) as exc:
        log.warning("Failed to decrypt per-user secret: %s (master key rotated?)", exc)
        return None


# ---- public surface ----------------------------------------------------------


def get(key: str) -> str | None:
    """Return the plaintext value for `key`, preferring DB → env. Returns
    None if neither source has a non-empty value. Never raises on a
    missing master key — env fallback still works."""
    if key not in KNOWN_KEYS:
        return None

    # 1. DB (admin-managed)
    db_value = _read_db_value(key)
    if db_value is not None and db_value.strip():
        return db_value

    # 2. env fallback
    env_name = KNOWN_KEYS[key]
    env_value = os.environ.get(env_name)
    if env_value and env_value.strip():
        return env_value

    # 3. Pydantic settings (covers .env-file usage in dev)
    s = get_settings()
    attr_name = env_name.lower()
    attr_value = getattr(s, attr_name, None)
    if attr_value and str(attr_value).strip():
        return str(attr_value)
    return None


def set(
    key: str,
    value: str,
    *,
    actor_user_id: uuid.UUID | None,
) -> None:
    """Upsert an encrypted value. Empty value calls `clear()` instead so
    the UI can use a single field for both 'set' and 'unset'.

    Raises StoreUnavailable if the master key is missing — surface the
    error so the admin can fix the fly-secret first."""
    if key not in KNOWN_KEYS:
        raise ValueError(f"Unknown setting key: {key}")
    if not value:
        return clear(key, actor_user_id=actor_user_id)

    fernet = _fernet()
    token = fernet.encrypt(value.encode("utf-8")).decode("ascii")

    with get_session_factory()() as db:
        _upsert(db, key, token, actor_user_id)


def clear(key: str, *, actor_user_id: uuid.UUID | None) -> None:
    """Remove the DB row. Env-var fallback (if any) takes over again."""
    if key not in KNOWN_KEYS:
        raise ValueError(f"Unknown setting key: {key}")
    with get_session_factory()() as db:
        row = db.query(AppSetting).filter(AppSetting.key == key).one_or_none()
        if row is not None:
            db.delete(row)
            db.commit()


def list_meta(keys: Iterable[str] | None = None) -> list[SettingMeta]:
    """Status of each known key — used by the admin UI to render the
    "set / not set" badges without ever transmitting plaintext."""
    target_keys = list(keys) if keys is not None else list(KNOWN_KEYS)

    with get_session_factory()() as db:
        rows = (
            db.query(AppSetting)
            .filter(AppSetting.key.in_(target_keys))
            .all()
        )
        db_map: dict[str, AppSetting] = {r.key: r for r in rows}

    out: list[SettingMeta] = []
    for k in target_keys:
        row = db_map.get(k)
        if row is not None:
            out.append(
                SettingMeta(
                    key=k,
                    is_set=True,
                    source="db",
                    updated_at=row.updated_at,
                    updated_by_user_id=row.updated_by_user_id,
                )
            )
            continue

        # Fall back to env / pydantic settings for the "is set" badge —
        # the admin still wants to know the value is in effect even if
        # it came from a Fly secret rather than the UI.
        env_name = KNOWN_KEYS[k]
        env_value = os.environ.get(env_name)
        if env_value and env_value.strip():
            out.append(
                SettingMeta(
                    key=k, is_set=True, source="env",
                    updated_at=None, updated_by_user_id=None,
                )
            )
            continue
        s = get_settings()
        attr_value = getattr(s, env_name.lower(), None)
        if attr_value and str(attr_value).strip():
            out.append(
                SettingMeta(
                    key=k, is_set=True, source="env",
                    updated_at=None, updated_by_user_id=None,
                )
            )
            continue

        out.append(
            SettingMeta(
                key=k, is_set=False, source="none",
                updated_at=None, updated_by_user_id=None,
            )
        )
    return out


# ---- internals ---------------------------------------------------------------


def _read_db_value(key: str) -> str | None:
    """Read + decrypt a single key. Returns None on missing row, bad
    token, or missing master key — `messaging.py` then falls back to
    env. Decryption failures are logged because they almost always
    mean the master key was rotated without re-encrypting rows."""
    try:
        fernet = _fernet()
    except StoreUnavailable:
        return None

    with get_session_factory()() as db:
        row = (
            db.query(AppSetting.encrypted_value)
            .filter(AppSetting.key == key)
            .one_or_none()
        )
    if row is None or not row[0]:
        return None
    try:
        return fernet.decrypt(row[0].encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError) as exc:
        log.warning(
            "Failed to decrypt app_setting %s: %s (master key rotated?)",
            key,
            exc,
        )
        return None


def _upsert(
    db: Session, key: str, encrypted_value: str, actor: uuid.UUID | None
) -> None:
    now = datetime.now(timezone.utc)
    row = db.query(AppSetting).filter(AppSetting.key == key).one_or_none()
    if row is None:
        row = AppSetting(
            key=key,
            encrypted_value=encrypted_value,
            updated_at=now,
            updated_by_user_id=actor,
        )
        db.add(row)
    else:
        row.encrypted_value = encrypted_value
        row.updated_at = now
        row.updated_by_user_id = actor
    db.commit()
