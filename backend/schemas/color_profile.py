import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ColorSwap(BaseModel):
    """One exact-match RGB swap. Both `source` and `target` are integer
    sRGB triples (0..255). Editing tools display them as either RGB or
    hex; the wire format is always RGB."""

    source: tuple[int, int, int]
    target: tuple[int, int, int]
    label: str | None = Field(default=None, max_length=80)

    @field_validator("source", "target")
    @classmethod
    def _validate_rgb(cls, v: tuple[int, int, int]) -> tuple[int, int, int]:
        if any(c < 0 or c > 255 for c in v):
            raise ValueError("RGB components must be 0..255")
        return v


class ColorProfileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    swaps: list[ColorSwap]
    created_at: datetime
    updated_at: datetime
    # Best-effort count of jobs currently linked to this profile - the
    # router fills it in with a separate query so the row stays cheap.
    job_count: int = 0


class ColorProfileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    swaps: list[ColorSwap] = []


class ColorProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    swaps: list[ColorSwap] | None = None


class JobColorAttach(BaseModel):
    """Attach (or detach with `null`) a saved profile, and/or set the
    job's draft swap list. Both fields are independent so the UI can
    update them in one round-trip."""

    color_profile_id: uuid.UUID | None = None
    color_swaps_draft: list[ColorSwap] | None = None
    # Discriminator so PATCH callers can clear the link with an
    # explicit `set_profile_null=true` (otherwise `None` is ambiguous
    # against "don't touch this field").
    clear_profile: bool = False
    clear_draft: bool = False


class JobColorsResponse(BaseModel):
    """Returned by detect + attached state endpoints. Mirrors the job's
    current state and the colours we found in its assigned assets."""

    detected: list[tuple[int, int, int]]
    color_profile_id: uuid.UUID | None
    color_swaps_draft: list[ColorSwap]
    profile: ColorProfileOut | None = None
