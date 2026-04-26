"""Object-storage client - S3-compatible API via boto3.

Vendor-neutral. Works with anything that speaks S3:
  - Fly.io Tigris (recommended; provisioned with `fly storage create`)
  - Cloudflare R2
  - AWS S3
  - MinIO (local dev)

Settings come from `STORAGE_*` env vars. See `.env.example`.
"""

from __future__ import annotations

from functools import lru_cache
from typing import BinaryIO

import boto3
from botocore.client import Config

from backend.config import get_settings


class StorageNotConfigured(RuntimeError):
    pass


@lru_cache(maxsize=1)
def _client():
    settings = get_settings()
    if not (settings.storage_endpoint and settings.storage_access_key and settings.storage_secret_key):
        raise StorageNotConfigured(
            "Object storage is not configured. Set STORAGE_ENDPOINT, "
            "STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY via fly secrets (see SETUP.md)."
        )
    return boto3.client(
        "s3",
        endpoint_url=settings.storage_endpoint,
        aws_access_key_id=settings.storage_access_key,
        aws_secret_access_key=settings.storage_secret_key,
        region_name=settings.storage_region or "auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
    )


def _bucket() -> str:
    settings = get_settings()
    if not settings.storage_bucket:
        raise StorageNotConfigured("STORAGE_BUCKET not set")
    return settings.storage_bucket


def put_bytes(key: str, body: bytes, content_type: str = "application/octet-stream") -> str:
    _client().put_object(Bucket=_bucket(), Key=key, Body=body, ContentType=content_type)
    return key


def put_stream(key: str, fileobj: BinaryIO, content_type: str = "application/octet-stream") -> str:
    _client().upload_fileobj(
        Fileobj=fileobj,
        Bucket=_bucket(),
        Key=key,
        ExtraArgs={"ContentType": content_type},
    )
    return key


def get_bytes(key: str) -> bytes:
    obj = _client().get_object(Bucket=_bucket(), Key=key)
    return obj["Body"].read()


def delete(key: str) -> None:
    _client().delete_object(Bucket=_bucket(), Key=key)


def presigned_get(
    key: str,
    expires_in: int = 3600,
    download_filename: str | None = None,
    content_type: str | None = None,
) -> str:
    """Generate a presigned GET URL.

    `content_type` forces the response Content-Type header (overriding
    whatever the object was uploaded with). Useful for serving an
    original SVG that may have been stored as octet-stream so the
    browser renders it inline rather than downloading it."""
    params: dict = {"Bucket": _bucket(), "Key": key}
    if download_filename:
        params["ResponseContentDisposition"] = (
            f'attachment; filename="{download_filename}"'
        )
    if content_type:
        params["ResponseContentType"] = content_type
    return _client().generate_presigned_url("get_object", Params=params, ExpiresIn=expires_in)


def is_configured() -> bool:
    settings = get_settings()
    return bool(
        settings.storage_endpoint
        and settings.storage_access_key
        and settings.storage_secret_key
        and settings.storage_bucket
    )
