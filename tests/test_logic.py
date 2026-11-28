from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sys
from types import ModuleType

logic_path = Path(__file__).parents[1] / "custom_components" / "steuertage" / "logic.py"
package_name = "steuertage_test_package"
package = ModuleType(package_name)
package.__path__ = [str(logic_path.parent)]
sys.modules[package_name] = package

spec = spec_from_file_location(f"{package_name}.logic", logic_path)
logic = module_from_spec(spec)
sys.modules[spec.name] = logic
spec.loader.exec_module(logic)
classify_day = logic.classify_day
detect_homeoffice = logic.detect_homeoffice
append_manual_change = logic.append_manual_change
make_storage_key = logic.make_storage_key
normalize_day_record = logic.normalize_day_record
normalize_office_zones = logic.normalize_office_zones


def test_below_threshold_active_office_signal_is_tracking():
    assert classify_day(1799, 0, True, False, True, True) == "tracking"


def test_threshold_classifies_home_office():
    assert classify_day(0, 1800, False, False, True, True) == "home_office"


def test_threshold_classifies_office():
    assert classify_day(1800, 0, False, False, True, True) == "office"


def test_inactive_office_signal_is_no_work():
    assert classify_day(0, 0, False, False, False, True) == "no_work"


def test_no_active_signal_is_no_work():
    assert classify_day(0, 0, False, False, False, False) == "no_work"


def test_inactive_empty_day():
    assert classify_day(0, 0, False, False, True, True) == "no_work"


def test_homeoffice_requires_person_and_device_in_home_zone():
    assert detect_homeoffice(True, True, True, True, True) == (
        True,
        "person_and_device_in_home_zone",
    )
    assert detect_homeoffice(True, True, True, True, False) == (
        False,
        "device_outside_home_zone",
    )


def test_unavailable_homeoffice_inputs_fail_closed():
    assert detect_homeoffice(False, True, True, True, True) == (
        False,
        "person_unavailable",
    )
    assert detect_homeoffice(True, False, True, True, True) == (
        False,
        "home_zone_unavailable",
    )
    assert detect_homeoffice(True, True, False, True, True) == (
        False,
        "device_unavailable",
    )


def test_each_person_gets_separate_persistent_storage():
    assert make_storage_key("entry-a") != make_storage_key("entry-b")


def test_manual_change_history_appends_and_keeps_identity():
    history = append_manual_change(
        [{"old_value": "tracking"}],
        person_id="person.berta",
        changed_by="user-gustav",
        timestamp="2026-11-20T10:00:00+00:00",
        old_value="tracking",
        new_value="office",
        reason="Termin im Büro",
    )
    assert len(history) == 2
    assert history[-1] == {
        "person_id": "person.berta",
        "changed_by": "user-gustav",
        "timestamp": "2026-11-20T10:00:00+00:00",
        "old_value": "tracking",
        "new_value": "office",
        "reason": "Termin im Büro",
    }


def test_legacy_record_migration_preserves_manual_history():
    audit = [{"person_id": "person.berta", "changed_by": "user-gustav"}]
    migrated = normalize_day_record(
        {
            "date": "2026-11-19",
            "seconds": 1800,
            "day_type": "home_office",
            "manual_override": "vacation",
            "change_history": audit,
        },
        day_types=("no_work", "tracking", "home_office", "office", "vacation", "needs_review"),
        override_types=("no_work", "tracking", "home_office", "office", "vacation"),
    )
    assert migrated["office_seconds"] == 0
    assert migrated["homeoffice_seconds"] == 1800
    assert migrated["day_type"] == "vacation"
    assert migrated["change_history"] == audit


def test_multiuser_conflicts_reject_reuse_but_allow_shared_zones():
    existing = [
        {
            "entry_id": "entry-a",
            "values": {
                "person_entity": "person.gustav",
                "homeoffice_device": "device_tracker.phone",
                "ha_user_id": "user-gustav",
                "home_zone": "zone.home",
            },
        }
    ]
    conflicts = logic.find_person_configuration_conflicts(
        {
            "person_entity": "person.gustav",
            "homeoffice_device": "device_tracker.phone",
            "ha_user_id": "user-gustav",
            "home_zone": "zone.home",
        },
        existing,
    )
    assert conflicts == {
        "already_configured",
        "device_already_configured",
        "user_already_configured",
    }
    assert logic.find_person_configuration_conflicts(
        {
            "person_entity": "person.berta",
            "homeoffice_device": "device_tracker.berta_phone",
            "ha_user_id": "user-berta",
            "home_zone": "zone.home",
        },
        existing,
    ) == set()


def test_options_flow_excludes_its_own_entry_from_conflict_checks():
    existing = [
        {
            "entry_id": "entry-a",
            "values": {
                "person_entity": "person.gustav",
                "homeoffice_device": "device_tracker.phone",
                "ha_user_id": "user-gustav",
            },
        }
    ]
    assert logic.find_person_configuration_conflicts(
        {
            "person_entity": "person.gustav",
            "homeoffice_device": "device_tracker.phone",
            "ha_user_id": "user-gustav",
        },
        existing,
        exclude_entry_id="entry-a",
    ) == set()


def test_office_zone_migration_and_unlimited_selection():
    assert normalize_office_zones("zone.office") == ["zone.office"]
    assert normalize_office_zones(None) == []
    assert normalize_office_zones(["zone.a", "zone.b", "zone.c", "zone.b"]) == [
        "zone.a", "zone.b", "zone.c"
    ]
    assert normalize_office_zones(["zone.a", "unavailable", None]) == ["zone.a"]


def test_historical_office_days_stay_unassigned_without_evidence():
    old = normalize_day_record(
        {"day_type": "office", "office_seconds": 3600},
        day_types=("office", "home_office", "no_work", "needs_review"),
        override_types=("office", "home_office", "no_work"),
    )
    assert old["office_site_ids"] == []
    assert old["manual_office_site_ids"] is None


def test_site_assignments_and_audit_survive_normalization():
    record = normalize_day_record(
        {"day_type": "office", "office_seconds": 3600,
         "office_site_ids": ["site_1", "site_2", "site_1"],
         "automatic_office_site_ids": ["site_1"],
         "manual_office_site_ids": ["site_2"],
         "change_history": [{"changed_by": "user-a",
                             "old_office_site_ids": ["site_1"],
                             "new_office_site_ids": ["site_2"]}]},
        day_types=("office", "no_work", "needs_review"),
        override_types=("office", "no_work"),
    )
    assert record["office_site_ids"] == ["site_1", "site_2"]
    assert record["automatic_office_site_ids"] == ["site_1"]
    assert record["manual_office_site_ids"] == ["site_2"]
    assert record["change_history"][0]["new_office_site_ids"] == ["site_2"]


def test_overlapping_sites_match_same_position_without_double_time():
    person = {"latitude": 50.7, "longitude": 7.1}
    first = {"latitude": 50.7, "longitude": 7.1, "radius": 100}
    second = {"latitude": 50.7001, "longitude": 7.1, "radius": 100}
    far = {"latitude": 51.0, "longitude": 7.1, "radius": 100}
    assert logic.within_zone_coordinates(person, first)
    assert logic.within_zone_coordinates(person, second)
    assert not logic.within_zone_coordinates(person, far)
    assert classify_day(1800, 0, False, False, True, True) == "office"


def test_invalid_or_missing_gps_does_not_assign_sites():
    assert not logic.within_zone_coordinates({}, {"latitude": 50, "longitude": 7, "radius": 100})
    assert not logic.within_zone_coordinates(
        {"latitude": 50, "longitude": 7},
        {"latitude": 50, "longitude": 7, "radius": float("nan")},
    )
