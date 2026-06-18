"""Generation settings — non-secret runtime-tunable parameters.

Stored in the `app_settings` table using the encrypted_value column
(Fernet-encrypted for consistency), but these are not truly secret.
We provide a simple get/set interface with sensible defaults.
"""

from __future__ import annotations

import os

from sqlalchemy.orm import Session

from backend.models.app_setting import AppSetting
from backend.services import secrets_store

_DEFAULT_THRESHOLD_MB = 75

# Register our key with the secrets store so it can be read/written
# through the same Fernet-encrypted mechanism.
_KEY = "generation.compression_threshold_mb"
if _KEY not in secrets_store.KNOWN_KEYS:
    secrets_store.KNOWN_KEYS[_KEY] = "GENERATION_COMPRESSION_THRESHOLD_MB"


def get_compression_threshold_mb() -> int:
    """Return the compression threshold in MB. Falls back to env then default."""
    val = secrets_store.get(_KEY)
    if val is not None:
        try:
            return int(val)
        except (ValueError, TypeError):
            pass
    env_val = os.environ.get("GENERATION_COMPRESSION_THRESHOLD_MB")
    if env_val:
        try:
            return int(env_val)
        except (ValueError, TypeError):
            pass
    return _DEFAULT_THRESHOLD_MB


def set_compression_threshold_mb(value: int, *, actor_user_id=None) -> None:
    """Persist the compression threshold."""
    secrets_store.set(_KEY, str(value), actor_user_id=actor_user_id)
