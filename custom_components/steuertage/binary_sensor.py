"""Home-office presence sensor for each configured person."""
from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import WorklogCoordinator


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Create the person's home-office presence sensor when tracker-based setup is used."""
    coordinator: WorklogCoordinator = hass.data[DOMAIN][entry.entry_id]
    entities = [WorklogReviewSensor(coordinator, entry)]
    if coordinator.homeoffice_enabled and not coordinator.legacy_mode:
        entities.append(WorklogHomeOfficeSensor(coordinator, entry))
    async_add_entities(entities)


class WorklogHomeOfficeSensor(
    CoordinatorEntity[WorklogCoordinator], BinarySensorEntity
):
    """Report home-office presence when person and device are both in the home zone."""

    _attr_has_entity_name = True
    _attr_name = "Homeoffice erkannt"
    _attr_icon = "mdi:home-account"
    _attr_device_class = BinarySensorDeviceClass.PRESENCE

    def __init__(self, coordinator: WorklogCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_homeoffice_presence"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": f"Steuertage – {coordinator.person_name}",
            "manufacturer": "Steuertage",
            "model": "Steuertage",
        }

    @property
    def is_on(self) -> bool:
        """Return true only when both configured presence sources match."""
        return bool(self.coordinator.data["homeoffice_active"])

    @property
    def available(self) -> bool:
        """A missing source is unavailable, never a positive detection."""
        return bool(self.coordinator.data["homeoffice_source_valid"])

    @property
    def extra_state_attributes(self) -> dict[str, str | bool]:
        """Expose why detection is active, inactive, or unavailable."""
        data = self.coordinator.data
        return {
            "person": self.coordinator.person_entity,
            "person_status": data["person_status"],
            "person_source_available": data["person_source_valid"],
            "home_zone": self.coordinator.home_zone_entity,
            "device_tracker": self.coordinator.homeoffice_device_entity or "",
            "device_status": data["device_status"],
            "device_source_available": data["device_source_valid"],
            "detection_reason": data["homeoffice_reason"],
        }


class WorklogReviewSensor(CoordinatorEntity[WorklogCoordinator], BinarySensorEntity):
    """Report whether this person's history contains unresolved review days."""

    _attr_has_entity_name = True
    _attr_translation_key = "review_required"
    _attr_icon = "mdi:clipboard-alert-outline"
    _attr_device_class = BinarySensorDeviceClass.PROBLEM

    def __init__(self, coordinator: WorklogCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_review_required"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": f"Steuertage – {coordinator.person_name}",
            "manufacturer": "Steuertage",
            "model": "Steuertage",
        }

    @property
    def is_on(self) -> bool:
        return self.coordinator.entity_summary()["open_reviews"] > 0
