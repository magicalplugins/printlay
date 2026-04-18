import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ShapeSchema(BaseModel):
    page_index: int = 0
    shape_index: int
    bbox: list[float] = Field(min_length=4, max_length=4)
    layer: str | None = None
    is_position_slot: bool = False


class TemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    source: Literal["uploaded", "generated"]
    units: str
    page_width: float
    page_height: float
    positions_layer: str
    has_ocg: bool
    shapes: list[dict[str, Any]]
    generation_params: dict[str, Any] | None = None
    created_at: datetime


class GenerateArtboard(BaseModel):
    width: float = Field(gt=0)
    height: float = Field(gt=0)
    units: Literal["mm", "pt", "in"] = "mm"


class GenerateShape(BaseModel):
    kind: Literal["rect", "circle"] = "rect"
    width: float = Field(gt=0)
    height: float = Field(gt=0)
    gap_x: float = Field(ge=0, default=0)
    """Horizontal spacing between shapes when ``spacing_mode='fixed'``."""
    gap_y: float = Field(ge=0, default=0)
    """Vertical spacing between shapes when ``spacing_mode='fixed'``."""
    center: bool = True
    """In fixed mode, centre the grid inside the available area."""
    edge_margin: float = Field(ge=0, default=0)
    """Inviolable margin (in template ``units``) on all four sides of the
    artboard. No slot will be placed inside this margin. Increasing the
    margin shrinks the available area and may drop a row/column."""
    spacing_mode: Literal["fixed", "even"] = "fixed"
    """``fixed``: slots are spaced exactly ``gap_x``/``gap_y`` apart.
    ``even``: pack as many slots as fit edge-to-edge inside the available
    area, then distribute the leftover space evenly between them so the
    outermost slots sit flush against the safe-zone edges."""


class GenerateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    artboard: GenerateArtboard
    shape: GenerateShape
