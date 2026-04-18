import os
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

    storage_endpoint: str | None = Field(
        default=None,
        validation_alias="STORAGE_ENDPOINT",
    )
    storage_access_key: str | None = Field(
        default=None,
        validation_alias="STORAGE_ACCESS_KEY",
    )
    storage_secret_key: str | None = Field(
        default=None,
        validation_alias="STORAGE_SECRET_KEY",
    )
    storage_bucket: str | None = Field(
        default=None,
        validation_alias="STORAGE_BUCKET",
    )
    storage_region: str | None = Field(
        default=None,
        validation_alias="STORAGE_REGION",
    )
    storage_public_base_url: str | None = None

    def model_post_init(self, __context) -> None:
        """Fly's `fly storage create` injects standard `AWS_*` and `BUCKET_NAME`
        env vars. Pick those up automatically so the deploy is zero-config.
        Explicit `STORAGE_*` values take precedence."""
        self.storage_endpoint = self.storage_endpoint or os.getenv("AWS_ENDPOINT_URL_S3")
        self.storage_access_key = self.storage_access_key or os.getenv("AWS_ACCESS_KEY_ID")
        self.storage_secret_key = self.storage_secret_key or os.getenv("AWS_SECRET_ACCESS_KEY")
        self.storage_bucket = self.storage_bucket or os.getenv("BUCKET_NAME")
        self.storage_region = self.storage_region or os.getenv("AWS_REGION") or "auto"

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
