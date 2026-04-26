"""Tests for the storage_usage service.

Uses an in-memory SQLite DB rather than mocking SQLAlchemy, so the SUM
query is exercised end-to-end (catches things like a missing index hint
or a wrong filter just as well as Postgres would).
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.models.asset import Asset
from backend.models.base import Base
from backend.services import storage_usage


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:")
    # Create only the assets table — we don't need users/jobs/categories
    # for the SUM query, and pulling in the whole metadata would force
    # us to wire up Postgres-only column types.
    Asset.__table__.create(bind=engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


def _add_asset(db, user_id: uuid.UUID, *, file_size: int) -> None:
    asset = Asset(
        user_id=user_id,
        name="x.pdf",
        kind="pdf",
        r2_key="k",
        width_pt=10.0,
        height_pt=10.0,
        file_size=file_size,
    )
    # SQLite doesn't have gen_random_uuid(); set the PK explicitly so the
    # postgres server_default isn't invoked in tests.
    asset.id = uuid.uuid4()
    db.add(asset)
    db.commit()


def test_zero_when_user_has_no_assets(db):
    assert storage_usage.current_storage_bytes(db, uuid.uuid4()) == 0
    assert storage_usage.current_storage_mb(db, uuid.uuid4()) == 0.0


def test_sums_only_this_users_assets(db):
    me = uuid.uuid4()
    other = uuid.uuid4()
    _add_asset(db, me, file_size=10 * 1024 * 1024)        # 10 MB
    _add_asset(db, me, file_size=5 * 1024 * 1024)         #  5 MB
    _add_asset(db, other, file_size=999 * 1024 * 1024)    # noise

    assert storage_usage.current_storage_bytes(db, me) == 15 * 1024 * 1024
    assert storage_usage.current_storage_mb(db, me) == pytest.approx(15.0)


def test_would_exceed_cap_returns_false_when_unlimited(db):
    user = uuid.uuid4()
    _add_asset(db, user, file_size=999 * 1024 * 1024)
    assert storage_usage.would_exceed_cap(db, user, 999 * 1024 * 1024, None) is False


def test_would_exceed_cap_returns_false_with_headroom(db):
    user = uuid.uuid4()
    _add_asset(db, user, file_size=10 * 1024 * 1024)  # 10 MB used
    # Cap = 50 MB, incoming = 30 MB → 40 MB total, still under
    assert storage_usage.would_exceed_cap(db, user, 30 * 1024 * 1024, 50) is False


def test_would_exceed_cap_returns_true_when_over_limit(db):
    user = uuid.uuid4()
    _add_asset(db, user, file_size=40 * 1024 * 1024)  # 40 MB used
    # Cap = 50 MB, incoming = 20 MB → 60 MB total, over
    assert storage_usage.would_exceed_cap(db, user, 20 * 1024 * 1024, 50) is True


def test_exact_cap_boundary_is_allowed(db):
    """At cap == still allowed; only > cap should be rejected."""
    user = uuid.uuid4()
    _add_asset(db, user, file_size=49 * 1024 * 1024)  # 49 MB used
    # Cap = 50 MB, incoming = 1 MB → exactly 50 MB (allowed)
    assert storage_usage.would_exceed_cap(db, user, 1 * 1024 * 1024, 50) is False
