"""Storage accounting — what is this user actually consuming?

The single source of truth for "how much disk does this user own?".
Used by:
  - Upload routes (catalogue, job-attached uploads) to enforce the
    `storage_mb_max` cap *before* writing to R2.
  - Billing usage endpoint to surface the bar on the dashboard.

What counts:
  - Catalogue assets (Asset rows the user owns)
  - Job-attached uploads (Asset rows scoped to a job)

What does NOT count:
  - Generated PDF outputs (Output rows). These are 100% reproducible
    from the job + template, so we treat them as derived artefacts
    rather than user storage. Counting them would create a perverse
    incentive: "don't generate, your bar will fill up".
  - Templates (small, infrequent, no file_size column today).

Performance: a single COALESCE(SUM, 0) — milliseconds even for shops
with thousands of assets, since `assets.user_id` is indexed.
"""
from __future__ import annotations

import uuid

from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.models import Asset

_BYTES_PER_MB = 1024 * 1024


def current_storage_bytes(db: Session, user_id: uuid.UUID) -> int:
    """Total bytes of artwork the user currently has on file.

    Sums `assets.file_size` across catalogue + job-attached uploads.
    Generated outputs are excluded (see module docstring).
    """
    total = (
        db.query(func.coalesce(func.sum(Asset.file_size), 0))
        .filter(Asset.user_id == user_id)
        .scalar()
    )
    return int(total or 0)


def current_storage_mb(db: Session, user_id: uuid.UUID) -> float:
    """Convenience: total storage in megabytes (float, for display)."""
    return current_storage_bytes(db, user_id) / _BYTES_PER_MB


def would_exceed_cap(
    db: Session,
    user_id: uuid.UUID,
    incoming_bytes: int,
    cap_mb: int | None,
) -> bool:
    """True when adding `incoming_bytes` would push the user over `cap_mb`.

    `cap_mb is None` means unlimited — always returns False.
    """
    if cap_mb is None:
        return False
    cap_bytes = cap_mb * _BYTES_PER_MB
    return current_storage_bytes(db, user_id) + incoming_bytes > cap_bytes
