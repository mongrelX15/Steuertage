"""Native entity regression checks using the existing coordinator test harness."""
import asyncio
from datetime import datetime, timezone
from importlib import import_module
import sys
from types import ModuleType, SimpleNamespace

from test_backups import modules, make_person


def _entity_modules(monkeypatch):
    def stub(name, **values):
        module = ModuleType(name)
        module.__dict__.update(values)
        monkeypatch.setitem(sys.modules, name, module)

    class CoordinatorEntity:
        @classmethod
        def __class_getitem__(cls, _):
            return cls

        def __init__(self, coordinator):
            self.coordinator = coordinator

    class Description:
        def __init__(self, **values):
            self.__dict__.update(values)

    stub("homeassistant.components", __path__=[])
    stub("homeassistant.components.sensor", SensorDeviceClass=SimpleNamespace(ENUM="enum", TIMESTAMP="timestamp"),
         SensorEntity=type("SensorEntity", (), {}), SensorEntityDescription=Description,
         SensorStateClass=SimpleNamespace(MEASUREMENT="measurement"))
    stub("homeassistant.components.binary_sensor",
         BinarySensorDeviceClass=SimpleNamespace(PRESENCE="presence", PROBLEM="problem"),
         BinarySensorEntity=type("BinarySensorEntity", (), {}))
    stub("homeassistant.helpers.entity_platform", AddEntitiesCallback=object)
    stub("homeassistant.helpers.update_coordinator", CoordinatorEntity=CoordinatorEntity, DataUpdateCoordinator=object)
    sensor = import_module("steuertage_backup_tests.sensor")
    binary = import_module("steuertage_backup_tests.binary_sensor")
    return sensor, binary


def test_per_person_metrics_sites_review_and_period_rollover(modules, monkeypatch):
    _, coordinator_module, clock = modules
    person = make_person(coordinator_module, "alpha")
    other = make_person(coordinator_module, "beta")
    person._office_sites.extend([{"id": "site_4", "number": 4, "name": "Koblenz"}])
    person._history.update({
        "2026-11-02": {"day_type": "office", "office_site_ids": ["site_2", "site_4"]},
        "2026-11-03": {"day_type": "home_office"},
        "2026-10-03": {"day_type": "office_and_home_office"},
        "2026-09-04": {"day_type": "needs_review"},
    })
    person.data = {"date": "2026-11-27", "day_type": "office",
                   "office_site_ids": ["site_2", "site_4"]}
    person._history[person._date] = {"day_type": "needs_review"}
    assert person.entity_summary() == {
        "homeoffice_month": 1, "office_month": 2,
        "homeoffice_year": 2, "office_year": 3, "open_reviews": 1,
    }
    assert other.entity_summary()["office_year"] == 0
    sensor, binary = _entity_modules(monkeypatch)
    entry = SimpleNamespace(entry_id="stable-alpha")
    site_sensor = sensor.WorklogMetricSensor(person, entry, sensor.METRIC_SENSORS[0])
    assert site_sensor.native_value == "Bonn, Koblenz"
    assert site_sensor.extra_state_attributes["office_site_ids"] == ["site_2", "site_4"]
    assert binary.WorklogReviewSensor(person, entry).is_on
    person._history["2026-09-04"]["day_type"] = "no_work"
    assert not binary.WorklogReviewSensor(person, entry).is_on
    person.data["day_type"] = "home_office"
    assert site_sensor.native_value is None
    assert person.entity_summary()["homeoffice_month"] == 2
    # Restores replace the same in-memory history and notify the coordinator.
    person._history = {"2026-11-10": {"day_type": "needs_review"}}
    assert person.entity_summary()["open_reviews"] == 1
    clock.now = lambda: datetime(2027, 1, 1, tzinfo=timezone.utc)
    assert person.entity_summary()["office_year"] == 0
    assert person.entity_summary()["homeoffice_month"] == 0


def test_entity_registration_reuses_day_id_and_survives_rename(modules, monkeypatch):
    _, coordinator_module, clock = modules
    sensor, binary = _entity_modules(monkeypatch)
    people = [make_person(coordinator_module, suffix) for suffix in ("alpha", "beta")]
    created = []
    for person in people:
        person.homeoffice_enabled = False
        person.legacy_mode = False
        person._last_update = None
        person.data.update({"date": person._date, "office_site_ids": [],
                            "hours": 0, "day_type": "no_work"})
        hass = SimpleNamespace(data={sensor.DOMAIN: {person.entry_id: person}})
        entry = SimpleNamespace(entry_id=person.entry_id)
        asyncio.run(sensor.async_setup_entry(hass, entry, created.extend))
        asyncio.run(binary.async_setup_entry(hass, entry, created.extend))
    ids = [entity._attr_unique_id for entity in created]
    assert len(ids) == len(set(ids)) == 20  # Ten entities for each of two profiles.
    assert "alpha_day_type" in ids and "beta_day_type" in ids
    assert "alpha_review_required" in ids and "beta_review_required" in ids
    person = people[0]
    stamp = next(entity for entity in created if entity._attr_unique_id == "alpha_last_detection")
    assert stamp.native_value is None
    person._last_update = datetime(2026, 11, 27, 8, tzinfo=timezone.utc)
    assert stamp.native_value == person._last_update
    person.person_name = "Neuer Name"
    assert stamp._attr_unique_id == "alpha_last_detection"


def test_manual_changes_notify_native_metrics_immediately(modules):
    _, coordinator_module, _ = modules
    person = make_person(coordinator_module, "manual")
    person.homeoffice_enabled = True
    person._history[person._date] = person._normalize_record({
        "day_type": "no_work", "automatic_day_type": "no_work",
        "office_site_ids": [], "updated_at": "2026-11-27T08:00:00+00:00",
    })
    person.data.update({
        "date": person._date, "office_site_ids": [], "day_type": "no_work",
        "automatic_day_type": "no_work", "manual_override": None,
    })
    person._snapshot = lambda: {
        **person.data,
        "day_type": person._history[person._date]["day_type"],
        "manual_override": person._history[person._date]["manual_override"],
        "office_site_ids": person._history[person._date]["office_site_ids"],
    }
    published = []
    person.async_set_updated_data = lambda value: published.append(value["day_type"])
    asyncio.run(person.async_set_day_override(
        person._date, "office", changed_by="test", office_site_ids=["site_2"],
    ))
    assert published == ["office"]
    assert person.entity_summary()["office_month"] == 1
