"""Sensors exposed by Steuertage."""
from __future__ import annotations

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import DAY_TYPES, WorklogCoordinator


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Create work-log sensors."""
    coordinator: WorklogCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            WorklogDurationSensor(coordinator, entry),
            WorklogDaySensor(coordinator, entry),
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
    _attr_name = "Tagestyp"
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
