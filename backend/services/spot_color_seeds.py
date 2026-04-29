"""Seed presets for the per-user spot colour library.

Run once per user, the first time they hit the spot-colour list endpoint
without any rows of their own. Three industry-standard names cover the
overwhelming majority of cutters out there; users add their own machine-
specific entries as needed (Summa, CCI, custom workflows, etc.).
"""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from backend.models import SpotColor

# Industry-standard cutter spot colours. Pure magenta is the de-facto
# tint - cuts read clearly against any artwork at preview time and the
# RIP routes the geometry by NAME, not by colour. The default flag goes
# on Roland's CutContour because Roland VersaWorks dominates the small-
# shop print/cut market we ship to.
DEFAULT_PRESETS: tuple[dict, ...] = (
    {
        "name": "CutContour",
        "rgb": [255, 0, 255],
        "is_cut_line_default": True,
    },
    {
        "name": "Through-cut",
        "rgb": [255, 0, 255],
        "is_cut_line_default": False,
    },
    {
        "name": "Score",
        "rgb": [0, 0, 255],
        "is_cut_line_default": False,
    },
)


def seed_for_user(db: Session, user_id: uuid.UUID) -> list[SpotColor]:
    """Insert the default presets for ``user_id``. Caller is responsible
    for checking that the user has zero existing rows first; we don't
    re-check inside so concurrent seeders can't double-insert silently
    (the partial unique index on ``is_cut_line_default`` would catch it
    anyway). Returns the freshly created rows."""
    rows: list[SpotColor] = []
    for preset in DEFAULT_PRESETS:
        row = SpotColor(
            user_id=user_id,
            name=preset["name"],
            rgb=list(preset["rgb"]),
            is_cut_line_default=preset["is_cut_line_default"],
        )
        db.add(row)
        rows.append(row)
    db.commit()
    for row in rows:
        db.refresh(row)
    return rows
