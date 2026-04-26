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
    rate_limit_generate_per_minute: int = 30
    """Anti-burst cap on PDF generation. Stops automation abuse without
    affecting humans (a real user never clicks 'Generate' 30 times a
    minute). Stacked with the per-hour limit on the same endpoint."""

    # ---- Billing (Stripe) ----
    stripe_secret_key: str | None = None
    """Stripe secret key (sk_live_... or sk_test_...). Required for billing."""
    stripe_webhook_secret: str | None = None
    """Stripe webhook endpoint secret (whsec_...). Required for webhook verification."""
    stripe_price_starter_monthly: str | None = None
    stripe_price_starter_annual: str | None = None
    stripe_price_pro_monthly: str | None = None
    stripe_price_pro_annual: str | None = None
    stripe_price_studio_monthly: str | None = None
    stripe_price_studio_annual: str | None = None

    # ---- Admin access ----
    admin_emails: str = ""
    """Comma-separated list of email addresses granted admin access (case
    insensitive). Lets the owner manage the install without a separate user
    role table - keep it small and secret. Example:
        ADMIN_EMAILS=anthony@magicalplugins.com,ops@printlay.io"""

    # ---- Bulk messaging (admin outreach) ----
    resend_api_key: str | None = None
    """Set to enable transactional email sending. Free tier 3k/month is plenty
    for early-stage outreach."""
    resend_from_email: str = "Printlay <hello@printlay.io>"
    """Verified sender. Must match a domain you've verified in Resend."""
    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_from_number: str | None = None
    """E.164 number / Messaging Service SID. Optional - SMS is silently
    disabled if any of these three are missing."""

    @property
    def admin_email_set(self) -> set[str]:
        """Lower-cased set of admin emails for O(1) membership checks."""
        return {e.strip().lower() for e in self.admin_emails.split(",") if e.strip()}

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
