"""Pydantic schemas for the spot-colour library."""

from __future__ import annotations

import re
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


# Spot colour names go straight into the PDF as Separation /N values, so
# we constrain them to the same character class Adobe / Roland tooling
# accepts: ASCII letters, digits, hyphen, underscore, and a few
# punctuation chars. Spaces are NOT allowed (they would have to be
# encoded with #20 in the PDF name and most RIPs reject that).
_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9 _\-]{0,63}$")


def _validate_name(v: str) -> str:
    v = v.strip()
    if not _NAME_RE.match(v):
        raise ValueError(
            "Spot colour name must start with a letter and contain only "
            "letters, digits, spaces, hyphens or underscores (max 64 chars)."
        )
    return v


def _validate_rgb(v: list[int] | tuple[int, int, int]) -> list[int]:
    rgb = list(v)
    if len(rgb) != 3:
        raise ValueError("rgb must be a [r, g, b] triple")
    if any((not isinstance(c, int)) or c < 0 or c > 255 for c in rgb):
        raise ValueError("rgb components must be integers 0..255")
    return rgb


class SpotColorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    rgb: list[int]
    is_cut_line_default: bool
    created_at: datetime
    updated_at: datetime


class SpotColorCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    rgb: list[int] = Field(default_factory=lambda: [255, 0, 255])
    is_cut_line_default: bool = False

    _name_v = field_validator("name")(lambda cls, v: _validate_name(v))
    _rgb_v = field_validator("rgb")(lambda cls, v: _validate_rgb(v))


class SpotColorUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    rgb: list[int] | None = None
    is_cut_line_default: bool | None = None

    @field_validator("name")
    @classmethod
    def _name_v(cls, v: str | None) -> str | None:
        return _validate_name(v) if v is not None else v

    @field_validator("rgb")
    @classmethod
    def _rgb_v(cls, v: list[int] | None) -> list[int] | None:
        return _validate_rgb(v) if v is not None else v
