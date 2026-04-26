import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class CategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    created_at: datetime
    is_official: bool = False
    """True for admin-curated catalogues. The frontend renders these
    read-only and badges them so subscribers know they can't be edited."""
    subscribed: bool = False
    """For official categories: whether the calling user is opted in."""
    asset_count: int | None = None
    """Convenience for the browse panel; populated by list_official only."""


class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class AssetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    category_id: uuid.UUID | None = None
    job_id: uuid.UUID | None = None
    name: str
    kind: str
    width_pt: float
    height_pt: float
    file_size: int
    thumbnail_url: str | None = None
    preview_url: str | None = None
    """Highest-fidelity preview URL the browser can render directly.
    For SVG: the original SVG (vector, infinitely sharp). For raster /
    PDF: same as `thumbnail_url`. Frontend code should prefer this over
    `thumbnail_url` for the designer/filler displays."""
    created_at: datetime
    is_official: bool = False
