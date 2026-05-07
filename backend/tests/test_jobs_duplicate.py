"""Unit tests for :func:`backend.routers.jobs._remap_assignment_asset_ids`.

This is the helper that powers ``duplicate_job``'s "make the new job
fully independent" behaviour. Pre-fix, duplicating a job would copy
the assignments verbatim, so the new job's slot fills still pointed at
asset rows owned by the SOURCE job. JobFiller resolves uploads via
``listJobUploads(new_job.id)`` (which only returns assets tagged with
the new job's id) so the duplicate would open with all slots empty.

The fix clones the source job's uploaded asset rows (re-using the same
R2 keys for storage efficiency) and rewrites every assignment's
``asset_id`` from the source-asset id to the cloned-asset id. This
test pins the rewrite logic without standing up the SQLAlchemy / R2
machinery - the cloning + reference-counted purge are exercised by
deployment and by the existing ``_purge_job_uploads`` flow.
"""
from __future__ import annotations

from backend.routers.jobs import _remap_assignment_asset_ids


def test_remaps_assignment_asset_ids_when_in_map():
    src = {
        "0": {"asset_id": "src-aaa", "rotation_deg": 90, "fit_mode": "manual"},
        "1": {"asset_id": "src-bbb", "rotation_deg": 0},
    }
    mapping = {"src-aaa": "new-aaa", "src-bbb": "new-bbb"}

    out = _remap_assignment_asset_ids(src, mapping)

    assert out["0"]["asset_id"] == "new-aaa"
    assert out["1"]["asset_id"] == "new-bbb"
    # Non-asset_id fields survive intact - this is the per-slot
    # placement state (rotation, fit mode, x/y/w/h, filter, safe-crop)
    # the user paid attention to in the source job, and a "duplicate"
    # that loses it would be useless.
    assert out["0"]["rotation_deg"] == 90
    assert out["0"]["fit_mode"] == "manual"
    assert out["1"]["rotation_deg"] == 0


def test_preserves_assignment_when_asset_id_not_in_map():
    """Catalogue-asset assignments stay pointing at the same shared row.

    Catalogue assets aren't per-job uploads - they're user-level assets
    living under an asset_category and re-used across many jobs. The
    duplicate is meant to keep the same reference."""
    src = {"0": {"asset_id": "catalogue-xyz", "fit_mode": "contain"}}
    mapping = {"src-aaa": "new-aaa"}  # no entry for catalogue-xyz

    out = _remap_assignment_asset_ids(src, mapping)

    assert out["0"]["asset_id"] == "catalogue-xyz"
    assert out["0"]["fit_mode"] == "contain"


def test_handles_empty_assignments():
    assert _remap_assignment_asset_ids({}, {"a": "b"}) == {}
    assert _remap_assignment_asset_ids(None, {"a": "b"}) == {}


def test_handles_empty_mapping():
    """Job with assignments but nothing to remap (e.g. catalogue-only fills
    on a duplicate - no source-job uploads to clone). Assignments come
    out byte-identical."""
    src = {"0": {"asset_id": "cat-1"}, "1": {"asset_id": "cat-2"}}
    out = _remap_assignment_asset_ids(src, {})
    assert out == src
    # And it's a copy, not the same object - the caller is going to
    # assign this back to a different Job row, mutating it later
    # shouldn't bleed into the source.
    assert out is not src


def test_does_not_mutate_input():
    src = {"0": {"asset_id": "src-aaa", "rotation_deg": 0}}
    mapping = {"src-aaa": "new-aaa"}

    _remap_assignment_asset_ids(src, mapping)

    assert src["0"]["asset_id"] == "src-aaa"


def test_coerces_non_string_asset_id_for_lookup():
    """Assignments come out of JSONB as plain dicts; in normal use
    asset_id is a UUID-string, but we don't want a stray non-string
    (e.g. from a hand-edited row in admin tooling) to crash the
    duplicator. The lookup goes through ``str(...)`` so anything
    stringifiable is matched against the map."""
    src = {"0": {"asset_id": 12345}}
    mapping = {"12345": "remapped"}

    out = _remap_assignment_asset_ids(src, mapping)

    assert out["0"]["asset_id"] == "remapped"


def test_empty_or_missing_asset_id_passes_through_unchanged():
    """An assignment row without an asset_id (shouldn't happen in
    practice, but defensiveness costs nothing) just stays as-is. We
    don't want the duplicator to invent an id from thin air."""
    src = {
        "0": {"asset_id": ""},
        "1": {"rotation_deg": 0},  # asset_id absent entirely
    }
    out = _remap_assignment_asset_ids(src, {"src-aaa": "new-aaa"})
    assert out["0"] == {"asset_id": ""}
    assert out["1"] == {"rotation_deg": 0}
