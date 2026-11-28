"""Sensors exposed by Steuertage."""
from __future__ import annotations

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .coordinator import DAY_TYPES, WorklogCoordinator


METRIC_SENSORS = (
    SensorEntityDescription(key="today_office_sites", translation_key="today_office_sites", icon="mdi:map-marker-multiple"),
    SensorEntityDescription(key="homeoffice_month", translation_key="homeoffice_month", icon="mdi:home-calendar"),
    SensorEntityDescription(key="office_month", translation_key="office_month", icon="mdi:office-building"),
    SensorEntityDescription(key="homeoffice_year", translation_key="homeoffice_year", icon="mdi:home-calendar"),
    SensorEntityDescription(key="office_year", translation_key="office_year", icon="mdi:office-building"),
    SensorEntityDescription(key="open_reviews", translation_key="open_reviews", icon="mdi:clipboard-alert-outline"),
    SensorEntityDescription(
        key="last_detection", translation_key="last_detection",
        icon="mdi:clock-check-outline", device_class=SensorDeviceClass.TIMESTAMP,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Create work-log sensors."""
    coordinator: WorklogCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            WorklogDurationSensor(coordinator, entry),
            WorklogDaySensor(coordinator, entry),
            *(WorklogMetricSensor(coordinator, entry, description) for description in METRIC_SENSORS),
        ]
    )


def _device_info(coordinator: WorklogCoordinator, entry: ConfigEntry) -> dict:
    return {
        "identifiers": {(DOMAIN, entry.entry_id)},
        "name": f"Steuertage – {coordinator.person_name}",
        "manufacturer": "Steuertage",
        "model": "Steuertage",
    }


class WorklogDurationSensor(CoordinatorEntity[WorklogCoordinator], SensorEntity):
    """Internal diagnostic duration; the dashboard does not use this sensor."""

    _attr_has_entity_name = True
    _attr_name = "Erkennungszeit heute"
    _attr_native_unit_of_measurement = "h"
    _attr_native_state_class = SensorStateClass.MEASUREMENT
    _attr_suggested_display_precision = 2

    def __init__(self, coordinator: WorklogCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_work_duration"
        self._attr_device_info = _device_info(coordinator, entry)

    @property
    def native_value(self):
        return self.coordinator.data["hours"]

    @property
    def extra_state_attributes(self):
        data = self.coordinator.data
        return {
            "datum": data["date"],
            "arbeitszone_sekunden": data["office_seconds"],
            "homeoffice_sekunden": data["homeoffice_seconds"],
            "schwellwert_stunden": data["threshold_hours"],
            "schwellwert_minuten": data["threshold_minutes"],
        }


class WorklogDaySensor(CoordinatorEntity[WorklogCoordinator], SensorEntity):
    """Expose the effective day classification."""

    _attr_has_entity_name = True
    _attr_translation_key = "day_type"
    _attr_icon = "mdi:briefcase-clock"
    _attr_device_class = SensorDeviceClass.ENUM

    def __init__(self, coordinator: WorklogCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_day_type"
        self._attr_device_info = _device_info(coordinator, entry)
        options = [
            day_type
            for day_type in DAY_TYPES
            if day_type not in {"home_office", "office_and_home_office"}
            or coordinator.homeoffice_enabled
        ]
        current_type = coordinator.data.get("day_type")
        if current_type and current_type not in options:
            options.append(current_type)
        self._attr_options = tuple(options)

    @property
    def native_value(self):
        return self.coordinator.data["day_type"]

    @property
    def extra_state_attributes(self):
        data = self.coordinator.data
        return {
            "person": self.coordinator.person_entity,
            "datum": data["date"],
            "schwellwert_minuten": data["threshold_minutes"],
            "arbeitszone_erreichbar": data["office_source_valid"],
            "homeoffice_erkennung_erreichbar": data["homeoffice_source_valid"],
            "person_status": data["person_status"],
            "geraet_status": data["device_status"],
            "erkennungsgrund": data["homeoffice_reason"],
            "arbeitszone_aktiv": data["office_active"],
            "homeoffice_aktiv": data["homeoffice_active"],
        }


class WorklogMetricSensor(CoordinatorEntity[WorklogCoordinator], SensorEntity):
    """Expose a person's existing effective history as native sensor states."""

    _attr_has_entity_name = True

    def __init__(
        self, coordinator: WorklogCoordinator, entry: ConfigEntry,
        description: SensorEntityDescription,
    ) -> None:
        super().__init__(coordinator)
        self.entity_description = description
        self._attr_unique_id = f"{entry.entry_id}_{description.key}"
        self._attr_device_info = _device_info(coordinator, entry)

    @property
    def native_value(self):
        key = self.entity_description.key
        if key == "last_detection":
            return self.coordinator._last_update
        if key == "today_office_sites":
            if self.coordinator.data["date"] != dt_util.now().date().isoformat():
                return None
            if self.coordinator.data["day_type"] not in {"office", "office_and_home_office"}:
                return None
            names = self._today_site_names()
            value = ", ".join(names)
            return (value if len(value) <= 255 else str(len(names))) or None
        return self.coordinator.entity_summary()[key]

    def _today_site_names(self) -> list[str]:
        sites = {site["id"]: site["name"] for site in self.coordinator.office_sites()}
        return [sites.get(site_id, site_id) for site_id in self.coordinator.data["office_site_ids"]]

    @property
    def extra_state_attributes(self):
        if self.entity_description.key != "today_office_sites":
            return None
        return {
            "office_site_ids": list(self.coordinator.data["office_site_ids"]),
            "office_site_names": self._today_site_names(),
        }
