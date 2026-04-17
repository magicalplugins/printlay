from functools import lru_cache
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    environment: str = Field(default="development")

    supabase_url: str | None = None
    supabase_anon_key: str | None = None
    supabase_service_role_key: str | None = None
    supabase_jwt_secret: str | None = None
    database_url: str | None = None

    r2_endpoint: str | None = None
    r2_access_key: str | None = None
    r2_secret_key: str | None = None
    r2_bucket: str | None = None
    r2_public_base_url: str | None = None

    cors_extra_origins: str = ""
    """Comma-separated list of additional origins to whitelist in production
    (the SPA's own origin is implicitly allowed via same-origin)."""

    rate_limit_generate_per_hour: int = 60
    """Max calls to `POST /api/jobs/{id}/generate` per user per hour."""

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"

    @property
    def cors_origins(self) -> list[str]:
        if not self.is_production:
            return ["*"]
        extras = [o.strip() for o in self.cors_extra_origins.split(",") if o.strip()]
        return extras


@lru_cache
def get_settings() -> Settings:
    return Settings()
