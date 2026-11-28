"""Read-only daily work-day history calendar."""
from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta
from typing import Any

from homeassistant.components.calendar import CalendarEntity, CalendarEvent
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import dt as dt_util

from .const import (
    CONF_HOLIDAY_COUNTRY,
    CONF_HOLIDAY_SUBDIVISION,
    CONF_SHOW_HOLIDAYS,
    DOMAIN,
)
from .coordinator import WorklogCoordinator

DAY_LABELS = {
    "no_work": "Kein Arbeitstag",
    "tracking": "Erkennung läuft",
    "home_office": "Homeoffice-Tag",
    "office": "Arbeitsstätte",
    "office_and_home_office": "Arbeitsstätte + Homeoffice",
    "needs_review": "Bitte prüfen",
    "business_trip": "Dienstreise",
    "vacation": "Urlaub",
    "sick_leave": "Krankheit",
}


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Create one daily history calendar per person."""
    coordinator: WorklogCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([WorklogCalendar(coordinator, entry)])


class WorklogCalendar(CoordinatorEntity[WorklogCoordinator], CalendarEntity):
    """Expose one all-day event for every tracked date."""

    _attr_has_entity_name = True
    _attr_name = "Arbeitskalender"
    _attr_icon = "mdi:calendar-month"

    def __init__(self, coordinator: WorklogCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        settings = {**entry.data, **entry.options}
        self._holiday_country = (
            settings.get(CONF_HOLIDAY_COUNTRY) if settings.get(CONF_SHOW_HOLIDAYS) else None
        )
        self._holiday_subdivision = (
            settings.get(CONF_HOLIDAY_SUBDIVISION) if self._holiday_country else None
        )
        self._attr_unique_id = f"{entry.entry_id}_work_calendar"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": f"Steuertage – {coordinator.person_name}",
            "manufacturer": "Steuertage",
            "model": "Steuertage",
        }

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose the panel's calendar-to-person mapping."""
        person_state = self.hass.states.get(self.coordinator.person_entity)
        return {
            "worklog_person_entity": self.coordinator.person_entity,
            "worklog_person_name": self.coordinator.person_name,
            "worklog_user_id": (
                person_state.attributes.get("user_id") if person_state else None
            ),
            "worklog_entry_id": self.coordinator.entry_id,
            "worklog_home_zone_entity": self.coordinator.home_zone_entity,
            "worklog_office_zone_entity": self.coordinator.office_zone_entities[0] if self.coordinator.office_zone_entities else None,
            "worklog_office_zone_entities": self.coordinator.office_zone_entities,
            "worklog_office_sites": self.coordinator.panel_office_sites(),
            "worklog_device_tracker": self.coordinator.homeoffice_device_entity,
            "worklog_legacy_signal": self.coordinator.legacy_signal_entity,
            "worklog_threshold_hours": self.coordinator.threshold_hours,
            "worklog_threshold_minutes": self.coordinator.threshold_minutes,
            "worklog_homeoffice_enabled": self.coordinator.homeoffice_enabled,
            "worklog_homeoffice_years": self.coordinator.homeoffice_years(),
            "worklog_work_calendar_entity": self.coordinator.work_calendar_entity,
            "worklog_holiday_country": self._holiday_country,
            "worklog_holiday_subdivision": self._holiday_subdivision,
        }

    @property
    def event(self) -> CalendarEvent | None:
        """Return today's all-day calendar event."""
        today = dt_util.now().date()
        record = self._record_for_day(today)
        if record is None:
            return None
        return self._event_for_day(today, record)

    def _record_for_day(self, day: date) -> dict[str, Any] | None:
        """Return live data for today and stored data for previous days."""
        if day.isoformat() == self.coordinator.data["date"]:
            return self.coordinator.data
        return self.coordinator._history.get(day.isoformat())

    @staticmethod
    def _event_for_day(day: date, record: dict[str, Any]) -> CalendarEvent:
        """Create an all-day event including the full manual-change history."""
        day_type = record.get("day_type", "needs_review")
        automatic = record.get("automatic_day_type", day_type)
        manual_override = record.get("manual_override")
        office_seconds = float(record.get("office_seconds", 0))
        homeoffice_seconds = float(record.get("homeoffice_seconds", 0))
        mixed_day = bool(record.get("mixed_day")) or (
            day_type == "office_and_home_office"
            or automatic == "office_and_home_office"
            or (
                office_seconds > 0
                and homeoffice_seconds > 0
                and (
                    day_type in {"office", "home_office", "office_and_home_office"}
                    or automatic in {"office", "home_office", "office_and_home_office"}
                )
            )
        )

        def primary_type(value: str) -> str:
            if value != "office_and_home_office":
                return value
            return "office" if office_seconds >= homeoffice_seconds else "home_office"

        day_type = primary_type(day_type)
        automatic = primary_type(automatic)
        summary = DAY_LABELS.get(day_type, DAY_LABELS["needs_review"])
        automatic_summary = DAY_LABELS.get(automatic, DAY_LABELS["needs_review"])
        description = f"Automatische Tageserkennung: {automatic_summary}."
        if mixed_day and day_type != "business_trip":
            description += "\nSTEUERTAGE_MIXED:true"
            description += f"\nSTEUERTAGE_PRIMARY:{day_type}"
        if manual_override:
            description += f" Manuell geändert zu: {summary}."
        site_ids = record.get("office_site_ids", [])
        if site_ids:
            description += "\nSTEUERTAGE_SITES:" + json.dumps(site_ids, ensure_ascii=False, separators=(",", ":"))
        change_history = record.get("change_history", [])
        if change_history:
            description += "\nSTEUERTAGE_HISTORY:" + json.dumps(
                change_history, ensure_ascii=False, separators=(",", ":")
            )
        return CalendarEvent(
            start=day,
            end=day + timedelta(days=1),
            summary=summary,
            description=description,
        )

    async def async_get_events(
        self,
        hass: HomeAssistant,
        start_date: datetime,
        end_date: datetime,
    ) -> list[CalendarEvent]:
        """Return history events overlapping the requested range."""
        records = dict(self.coordinator._history)
        today = dt_util.now().date()
        current = self._record_for_day(today)
        if current is not None:
            records[today.isoformat()] = current

        events: list[CalendarEvent] = []
        for day_string, record in records.items():
            try:
                day = date.fromisoformat(day_string)
            except ValueError:
                continue
            local_start = datetime.combine(day, time.min, tzinfo=start_date.tzinfo)
            local_end = datetime.combine(
                day + timedelta(days=1), time.min, tzinfo=start_date.tzinfo
            )
            if local_end > start_date and local_start < end_date:
                events.append(self._event_for_day(day, record))
        return sorted(events, key=lambda item: item.start)
