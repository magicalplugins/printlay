import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    auth_id: uuid.UUID
    email: EmailStr
    tier: str
    is_active: bool
    created_at: datetime
    license_status: str | None = None
    license_expires_at: datetime | None = None


class PublicConfig(BaseModel):
    """Values the SPA needs to bootstrap. Anon key is intentionally public."""

    supabase_url: str | None
    supabase_anon_key: str | None
    environment: str
