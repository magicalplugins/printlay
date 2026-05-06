import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class JobAssignment(BaseModel):
    asset_id: uuid.UUID
    asset_kind: str | None = None
    asset_name: str | None = None
    # Phase 1: 0/90/180/270 only. Phase 3 will allow free rotation.
    rotation_deg: int = 0
    # Phase 3 placeholders (kept for forward-compatibility; default = "contain"
    # i.e. fit-and-centre as before).
    fit_mode: str = "contain"  # "contain" | "cover" | "stretch" | "manual"
    x_mm: float = 0.0
    y_mm: float = 0.0
    w_mm: float | None = None
    h_mm: float | None = None
    # Visual filter applied at composition time. Matches the IDs in
    # `services/image_filters.py`. "none" preserves vector fidelity.
    filter_id: str = "none"
    # Non-destructive "safe crop" frame. When True, the compositor
    # tightens the per-slot clip box from slot+bleed down to slot-safe
    # — anything the user designed outside the safe rect renders as a
    # uniform white border. The placement coords above are unchanged
    # so the user can flip safe_crop off and the original layout is
    # exactly as they left it.
    safe_crop: bool = False


class JobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    template_id: uuid.UUID
    name: str
    slot_order: list[int]
    assignments: dict[str, JobAssignment]
    created_at: datetime
    color_profile_id: uuid.UUID | None = None
    color_swaps_draft: list[dict] | None = None


class JobCreate(BaseModel):
    template_id: uuid.UUID
    name: str = Field(min_length=1, max_length=200)
    slot_order: list[int] = []
    assignments: dict[str, JobAssignment] = {}


class JobUpdate(BaseModel):
    name: str | None = None
    slot_order: list[int] | None = None
    assignments: dict[str, JobAssignment] | None = None


class FillRequest(BaseModel):
    asset_id: uuid.UUID
    quantity: int = Field(ge=1, le=10000)


class QueueItem(BaseModel):
    asset_id: uuid.UUID
    quantity: int = Field(ge=1, le=10000)
    rotation_deg: int = 0
    fit_mode: str = "contain"
    x_mm: float = 0.0
    y_mm: float = 0.0
    w_mm: float | None = None
    h_mm: float | None = None
    filter_id: str = "none"
    safe_crop: bool = False


class QueueRequest(BaseModel):
    """Replaces all assignments by walking `slot_order` and applying the queue
    in order: first item fills the first N slots, second item fills the next M,
    etc. If sum(quantity) > slot_order length, the surplus is silently ignored.
    """

    queue: list[QueueItem] = []


class GenerateOptions(BaseModel):
    """Optional per-call modifiers for `POST /api/jobs/{id}/generate`. All
    fields default to the existing behaviour so callers that don't send a
    body still get an unmodified PDF."""

    include_cut_lines: bool = False
    """When True, the compositor draws the slot outlines onto the output
    PDF using a Separation colour space - print/cut RIPs route those
    paths to the cutter instead of inking them. Off by default so a
    plain artwork-only generate still works exactly as before."""

    cut_line_spot_color_id: uuid.UUID | None = None
    """Which entry from the user's spot-colour library to use for the
    cut path. None means "use the user's marked-default entry"; if no
    default is set and `include_cut_lines` is True, the request fails
    with 400 so the operator picks one explicitly."""
