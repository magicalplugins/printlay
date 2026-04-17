import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class OutputOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    job_id: uuid.UUID
    name: str
    file_size: int
    slots_filled: int
    slots_total: int
    created_at: datetime
