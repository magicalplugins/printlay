import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class OutputOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    job_id: uuid.UUID
    name: str
    file_size: int
    slots_filled: int
    slots_total: int
    created_at: datetime
    # Populated only on the response from POST /jobs/{id}/generate, so
    # the UI can show the user how many colour swaps actually fired,
    # which source colours weren't found in the document, and how many
    # gradients/raster assets were skipped. Listing endpoints leave it
    # unset (it isn't persisted on the Output row).
    color_swap_report: dict[str, Any] | None = Field(default=None)
