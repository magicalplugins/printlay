import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class JobAssignment(BaseModel):
    asset_id: uuid.UUID
    asset_kind: str | None = None
    asset_name: str | None = None


class JobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    template_id: uuid.UUID
    name: str
    slot_order: list[int]
    assignments: dict[str, JobAssignment]
    created_at: datetime


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
