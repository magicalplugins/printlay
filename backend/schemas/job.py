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


class QueueRequest(BaseModel):
    """Replaces all assignments by walking `slot_order` and applying the queue
    in order: first item fills the first N slots, second item fills the next M,
    etc. If sum(quantity) > slot_order length, the surplus is silently ignored.
    """

    queue: list[QueueItem] = []
