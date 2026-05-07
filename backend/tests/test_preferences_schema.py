"""Schema-level tests for `PreferencesUpdate`.

The frontend mirrors these bounds for UX, but the backend is the
authority - we don't want a malicious or hand-crafted request to slip
in a per-slot value of 99999 and have a user discover their dashboard
claims they "saved 4.7 years this month" off one job. The whole point
of the time-saved surface is honesty; broken bounds would undermine
that on day one.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.schemas.auth import PreferencesUpdate


class TestSetupMinutesBounds:
    def test_accepts_default(self):
        assert PreferencesUpdate(time_saved_setup_minutes=10).time_saved_setup_minutes == 10

    def test_accepts_lower_bound(self):
        assert PreferencesUpdate(time_saved_setup_minutes=0).time_saved_setup_minutes == 0

    def test_accepts_upper_bound(self):
        assert PreferencesUpdate(time_saved_setup_minutes=600).time_saved_setup_minutes == 600

    def test_rejects_negative(self):
        with pytest.raises(ValidationError):
            PreferencesUpdate(time_saved_setup_minutes=-1)

    def test_rejects_above_upper_bound(self):
        with pytest.raises(ValidationError):
            PreferencesUpdate(time_saved_setup_minutes=601)


class TestPerSlotSecondsBounds:
    def test_accepts_default(self):
        assert (
            PreferencesUpdate(time_saved_per_slot_seconds=40).time_saved_per_slot_seconds
            == 40
        )

    def test_accepts_lower_bound(self):
        assert (
            PreferencesUpdate(time_saved_per_slot_seconds=0).time_saved_per_slot_seconds
            == 0
        )

    def test_accepts_upper_bound(self):
        assert (
            PreferencesUpdate(time_saved_per_slot_seconds=600).time_saved_per_slot_seconds
            == 600
        )

    def test_rejects_negative(self):
        with pytest.raises(ValidationError):
            PreferencesUpdate(time_saved_per_slot_seconds=-1)

    def test_rejects_above_upper_bound(self):
        with pytest.raises(ValidationError):
            PreferencesUpdate(time_saved_per_slot_seconds=601)


class TestPartialUpdate:
    def test_all_fields_optional_so_spa_can_partial_update(self):
        # Empty body is legal - lets the SPA flip a single toggle without
        # round-tripping the per-unit values it doesn't want to change.
        p = PreferencesUpdate()
        assert p.time_saved_show_enabled is None
        assert p.time_saved_setup_minutes is None
        assert p.time_saved_per_slot_seconds is None

    def test_just_the_toggle(self):
        p = PreferencesUpdate(time_saved_show_enabled=False)
        assert p.time_saved_show_enabled is False
        assert p.time_saved_setup_minutes is None
        assert p.time_saved_per_slot_seconds is None

    def test_just_the_setup_minutes(self):
        p = PreferencesUpdate(time_saved_setup_minutes=15)
        assert p.time_saved_setup_minutes == 15
        assert p.time_saved_show_enabled is None
        assert p.time_saved_per_slot_seconds is None
