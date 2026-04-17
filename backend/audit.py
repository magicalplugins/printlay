"""Lightweight audit log helper.

Use `record(db, user, action, ...)` from any router; we always commit the
audit row in its own savepoint so a failure in audit logging never aborts
the user's request.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy.orm import Session

from backend.models import User
from backend.models.audit import AuditEvent

log = logging.getLogger(__name__)


def record(
    db: Session,
    user: User | None,
    action: str,
    *,
    target_type: str | None = None,
    target_id: uuid.UUID | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    try:
        event = AuditEvent(
            user_id=user.id if user else None,
            action=action,
            target_type=target_type,
            target_id=target_id,
            payload=payload or {},
        )
        db.add(event)
        db.commit()
    except Exception:
        log.exception("audit log write failed (action=%s)", action)
        try:
            db.rollback()
        except Exception:
            pass
