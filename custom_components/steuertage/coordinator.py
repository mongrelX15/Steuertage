"""Coordinator that recognizes qualifying work days and stores per-person history."""
from __future__ import annotations

import copy
import logging
import math
import re
from datetime import date, datetime
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util import dt as dt_util

from .const import (
    BETA_THRESHOLD_SECONDS,
    CONF_DEVICE_TRACKER,
    CONF_HOME_OFFICE_ENABLED,
    CONF_HOME_ZONE,
    CONF_OFFICE_ZONE,
    CONF_PERSON,
    CONF_THRESHOLD_HOURS,
    CONF_THRESHOLD_MINUTES,
    CONF_WORK_CALENDAR,
    CONF_WORK_SIGNAL,
    DEFAULT_THRESHOLD_HOURS,
    DEFAULT_THRESHOLD_MINUTES,
    DOMAIN,
)
from .logic import (
    append_manual_change,
    classify_day,
    detect_homeoffice,
    make_storage_key,
    normalize_day_record,
)

_LOGGER = logging.getLogger(__name__)
DAY_TYPES = (
    "no_work",
    "tracking",
    "home_office",
    "office",
    "office_and_home_office",
    "needs_review",
    "business_trip",
    "vacation",
    "sick_leave",
)
OVERRIDE_TYPES = (*DAY_TYPES,)


class WorklogCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Track one person's office and home-office signals independently."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(hass, logger=_LOGGER, name=f"{DOMAIN}_{entry.entry_id}", update_interval=None)
        config = {**entry.data, **entry.options}
        self.entry_id = entry.entry_id
        self.person_entity = config[CONF_PERSON]
        person_state = hass.states.get(self.person_entity)
        self.person_name = (
            person_state.attributes.get("friendly_name", self.person_entity)
            if person_state
            else self.person_entity
        )
        self.homeoffice_enabled = bool(config.get(CONF_HOME_OFFICE_ENABLED, True))
        self.home_zone_entity = (
            config.get(CONF_HOME_ZONE) or "zone.home"
            if self.homeoffice_enabled
            else None
        )
        self.homeoffice_device_entity = (
            config.get(CONF_DEVICE_TRACKER) if self.homeoffice_enabled else None
        )
        self.legacy_signal_entity = (
            config.get(CONF_WORK_SIGNAL) if self.homeoffice_enabled else None
        )
        self.legacy_mode = bool(
            self.homeoffice_enabled
            and not self.homeoffice_device_entity
            and self.legacy_signal_entity
        )
        self.office_zone_entity = config.get(CONF_OFFICE_ZONE) or None
        self.work_calendar_entity = config.get(CONF_WORK_CALENDAR) or None
        raw_threshold_hours = config.get(CONF_THRESHOLD_HOURS)
        if raw_threshold_hours is None:
            raw_threshold_hours = (
                float(config.get(CONF_THRESHOLD_MINUTES, DEFAULT_THRESHOLD_MINUTES)) / 60
            )
        self.threshold_hours = max(0.5, min(24.0, float(raw_threshold_hours)))
        self.threshold_minutes = round(self.threshold_hours * 60)
        self.threshold_seconds = round(self.threshold_hours * 3600)
        self.store = Store(hass, 1, make_storage_key(entry.entry_id))
        self._office_seconds = 0.0
        self._homeoffice_seconds = 0.0
        self._last_update: datetime | None = None
        self._office_active = False
        self._homeoffice_active = False
        self._location: str | None = None
        self._office_source_valid = not bool(self.office_zone_entity)
        self._homeoffice_source_valid = not self.homeoffice_enabled
        self._person_source_valid = False
        self._device_source_valid = False
        self._person_status = "unknown"
        self._device_status = "unknown"
        self._homeoffice_reason = "not_evaluated"
        self._history: dict[str, dict[str, Any]] = {}
        self._date = dt_util.now().date().isoformat()

    async def async_initialize(self) -> None:
        """Restore today's totals and preserve previously stored history."""
        saved = await self.store.async_load()
        today = dt_util.now().date().isoformat()
        self._date = today

        if saved:
            history = saved.get("history", {})
            if isinstance(history, dict):
                self._history = {
                    day: self._normalize_record(record)
                    for day, record in history.items()
                    if isinstance(day, str) and isinstance(record, dict)
                }

            saved_date = saved.get("date")
            if saved_date == today:
                if "office_seconds" in saved or "homeoffice_seconds" in saved:
                    self._office_seconds = float(saved.get("office_seconds", 0))
                    self._homeoffice_seconds = float(saved.get("homeoffice_seconds", 0))
                else:
                    # Beta 0.1.0-beta.3 stored one combined counter.
                    legacy_seconds = float(saved.get("seconds", 0))
                    legacy_type = saved.get("day_type")
                    if legacy_type == "office" or saved.get("location") == "office":
                        self._office_seconds = legacy_seconds
                    elif legacy_type == "home_office" or saved.get("location") == "home":
                        self._homeoffice_seconds = legacy_seconds
            elif isinstance(saved_date, str) and saved_date < today:
                self._history[saved_date] = self._normalize_record(saved)

        self._last_update = dt_util.utcnow()
        self.data = self._snapshot()
        self._history[today] = self._history_record()
        await self._async_save()

    @staticmethod
    def _normalize_record(record: dict[str, Any]) -> dict[str, Any]:
        """Migrate older daily records without dropping manual audit entries."""
        return normalize_day_record(
            record,
            day_types=DAY_TYPES,
            override_types=OVERRIDE_TYPES,
        )

    def _history_record(self) -> dict[str, Any]:
        """Return the current record while preserving its manual change history."""
        previous = self._history.get(self._date, {})
        return {
            "day_type": self.data["day_type"],
            "automatic_day_type": self.data["automatic_day_type"],
            "manual_override": self.data["manual_override"],
            "mixed_day": self.data["mixed_day"],
            "office_seconds": round(self._office_seconds),
            "homeoffice_seconds": round(self._homeoffice_seconds),
            "change_history": list(previous.get("change_history", [])),
            "updated_at": dt_util.now().isoformat(),
        }

    def export_history(self) -> dict[str, dict[str, Any]]:
        """Return a detached copy of all saved day records, including today."""
        records = {
            day: copy.deepcopy(record)
            for day, record in self._history.items()
            if isinstance(day, str) and isinstance(record, dict)
        }
        records[self._date] = copy.deepcopy(self._history_record())
        return records

    async def async_restore_history(
        self,
        records: dict[str, Any],
        *,
        strategy: str = "merge_newer",
        backup_created_at: str | None = None,
    ) -> dict[str, int]:
        """Restore valid backup records by replacing or merging by update time."""
        if not isinstance(records, dict):
            raise ValueError("Die Sicherungsdatei enthält keine Tagesliste.")
        if strategy not in {"replace", "merge_newer"}:
            raise ValueError("Unbekannte Wiederherstellungsart.")

        backup_time = dt_util.parse_datetime(backup_created_at or "")
        imported = replaced = preserved_newer = invalid = 0
        changed_today = False
        for day_string, record in records.items():
            try:
                parsed = date.fromisoformat(day_string)
                if parsed.isoformat() != day_string or not isinstance(record, dict):
                    raise ValueError("Ungültiger Datensatz.")
                for field in ("office_seconds", "homeoffice_seconds", "seconds"):
                    if field in record:
                        seconds = float(record[field])
                        if not math.isfinite(seconds) or seconds < 0:
                            raise ValueError("Ungültige Zeitangabe.")
                normalized = self._normalize_record(record)
                current = self._history.get(day_string)
                if current is None:
                    self._history[day_string] = normalized
                    imported += 1
                    changed_today = changed_today or day_string == self._date
                    continue
                if strategy == "merge_newer":
                    local_time = dt_util.parse_datetime(str(current.get("updated_at", "")))
                    saved_time = dt_util.parse_datetime(str(normalized.get("updated_at", "")))
                    saved_time = saved_time or backup_time
                    if local_time is None or (saved_time is not None and local_time > saved_time):
                        preserved_newer += 1
                        continue
                    if saved_time is None:
                        preserved_newer += 1
                        continue
                self._history[day_string] = normalized
                replaced += 1
                changed_today = changed_today or day_string == self._date
            except (TypeError, ValueError, OverflowError):
                invalid += 1

        if imported or replaced:
            if changed_today and self._date in self._history:
                restored_today = self._history[self._date]
                self._office_seconds = float(restored_today.get("office_seconds", 0))
                self._homeoffice_seconds = float(restored_today.get("homeoffice_seconds", 0))
                self.data = self._snapshot()
                self._history[self._date] = self._history_record()
            await self._async_save()
            self.async_set_updated_data(self._snapshot())
        return {
            "imported": imported,
            "replaced": replaced,
            "preserved_newer": preserved_newer,
            "invalid": invalid,
        }

    async def async_set_day_override(
        self,
        day_string: str,
        day_type: str,
        *,
        changed_by: str,
        changed_by_name: str | None = None,
        reason: str | None = None,
    ) -> None:
        """Persist a manual correction and append an authenticated audit record."""
        if not self.homeoffice_enabled and day_type in {"home_office", "office_and_home_office"}:
            raise ValueError("Homeoffice-Tage sind für diese Person nicht aktiviert.")
        day = date.fromisoformat(day_string)
        key = day.isoformat()
        existing = self._history.get(key, {})
        if key == self._date:
            automatic = self.data.get("automatic_day_type", self.data["day_type"])
            office_seconds = round(self._office_seconds)
            homeoffice_seconds = round(self._homeoffice_seconds)
        else:
            office_seconds = int(existing.get("office_seconds", 0))
            homeoffice_seconds = int(existing.get("homeoffice_seconds", 0))
            automatic = existing.get(
                "automatic_day_type", existing.get("day_type", "no_work")
            )
            if day_type == "automatic":
                # Historical sensor states are not available live. Reclassify
                # from the signal time totals saved for that date.
                automatic = classify_day(
                    office_seconds,
                    homeoffice_seconds,
                    False,
                    False,
                    True,
                    True,
                    threshold_seconds=self.threshold_seconds,
                    homeoffice_enabled=self.homeoffice_enabled,
                )

        override = None if day_type == "automatic" else day_type
        new_value = override or automatic
        # Repeating the same manual choice is a no-op. For "automatic", only
        # skip if both the effective and stored automatic classifications match.
        if override is not None and existing.get("manual_override") == override:
            return
        if (
            override is None
            and existing.get("manual_override") is None
            and existing.get("day_type") == new_value
            and existing.get("automatic_day_type") == automatic
        ):
            return
        old_value = existing.get("manual_override") or automatic
        new_value = override or automatic
        change_history = append_manual_change(
            list(existing.get("change_history", [])),
            person_id=self.person_entity,
            changed_by=changed_by,
            timestamp=dt_util.utcnow().isoformat(),
            old_value=old_value,
            new_value=new_value,
            reason=reason,
        )
        change_history[-1]["changed_by_name"] = changed_by_name
        self._history[key] = {
            "day_type": new_value,
            "automatic_day_type": automatic,
            "manual_override": override,
            "mixed_day": bool(existing.get("mixed_day"))
            or (
                self.homeoffice_enabled
                and office_seconds > 0
                and homeoffice_seconds > 0
                and automatic in {"office", "home_office", "office_and_home_office"}
            ),
            "office_seconds": office_seconds,
            "homeoffice_seconds": homeoffice_seconds,
            "change_history": change_history,
            "updated_at": dt_util.now().isoformat(),
        }
        if key == self._date:
            self.data = self._snapshot()
        await self._async_save()
        self.async_set_updated_data(self._snapshot())

    async def _async_save(self) -> None:
        """Persist this person's counters and history under their own key."""
        await self.store.async_save({
            "date": self._date,
            "office_seconds": self._office_seconds,
            "homeoffice_seconds": self._homeoffice_seconds,
            "day_type": self.data["day_type"],
            "location": self._location,
            "history": self._history,
        })

    @staticmethod
    def _zone_tokens(zone_entity: str, zone_state) -> set[str]:
        """Return Home Assistant state forms that identify a selected zone."""
        tokens = {zone_entity.split(".", 1)[-1].casefold()}
        if zone_state is not None:
            friendly_name = str(zone_state.attributes.get("friendly_name", "")).strip()
            if friendly_name:
                tokens.add(friendly_name.casefold())
                tokens.add(re.sub(r"[^a-z0-9]+", "_", friendly_name.casefold()).strip("_"))
        if zone_entity == "zone.home":
            tokens.add("home")
        return {token for token in tokens if token}

    def _is_in_zone(self, entity_state, zone_entity: str | None) -> bool:
        """Check an entity against Home Assistant's zone state."""
        if entity_state is None or zone_entity is None:
            return False
        if entity_state.state in ("unknown", "unavailable", ""):
            return False
        if zone_entity in entity_state.attributes.get("in_zones", []):
            return True
        zone_state = self.hass.states.get(zone_entity)
        if zone_state is None or zone_state.state in ("unknown", "unavailable"):
            return False
        return entity_state.state.casefold() in self._zone_tokens(zone_entity, zone_state)

    def _presence(self) -> tuple[str | None, bool, bool]:
        """Update source diagnostics and return location and Homeoffice status."""
        person = self.hass.states.get(self.person_entity)
        person_valid = person is not None and person.state not in ("unknown", "unavailable")
        self._person_status = person.state if person else "unavailable"

        home_zone = (
            self.hass.states.get(self.home_zone_entity)
            if self.homeoffice_enabled and self.home_zone_entity
            else None
        )
        home_zone_valid = bool(
            not self.homeoffice_enabled
            or (
                home_zone is not None
                and home_zone.state not in ("unknown", "unavailable")
            )
        )
        self._person_source_valid = bool(person_valid and home_zone_valid)

        office_zone = (
            self.hass.states.get(self.office_zone_entity)
            if self.office_zone_entity
            else None
        )
        office_zone_valid = bool(
            not self.office_zone_entity
            or (office_zone is not None and office_zone.state not in ("unknown", "unavailable"))
        )
        if not person_valid:
            location = None
        elif self.homeoffice_enabled and self._is_in_zone(person, self.home_zone_entity):
            location = "home"
        elif self.office_zone_entity and self._is_in_zone(person, self.office_zone_entity):
            location = "office"
        else:
            location = "other"

        if not self.homeoffice_enabled:
            self._device_status = "disabled"
            self._device_source_valid = True
            self._homeoffice_source_valid = True
            self._homeoffice_reason = "homeoffice_disabled"
            homeoffice_active = False
        elif self.legacy_mode:
            signal = self.hass.states.get(self.legacy_signal_entity)
            signal_valid = signal is not None and signal.state not in ("unknown", "unavailable")
            self._device_status = signal.state if signal else "unavailable"
            self._device_source_valid = bool(signal_valid)
            self._homeoffice_source_valid = bool(signal_valid and home_zone_valid)
            homeoffice_active = bool(signal_valid and signal.state == "on")
            self._homeoffice_reason = (
                "legacy_signal_active" if homeoffice_active
                else "legacy_signal_inactive" if signal_valid
                else "legacy_signal_unavailable"
            )
        else:
            device = (
                self.hass.states.get(self.homeoffice_device_entity)
                if self.homeoffice_device_entity
                else None
            )
            device_present = device is not None
            device_valid = device_present and device.state not in ("unknown", "unavailable")
            self._device_status = device.state if device else "unavailable"
            # An existing tracker may be unavailable when its device is off.
            # Treat that as an inactive signal, not as a broken configuration.
            self._device_source_valid = bool(device_present)
            person_home = self._is_in_zone(person, self.home_zone_entity)
            device_home = self._is_in_zone(device, self.home_zone_entity)
            self._homeoffice_source_valid = bool(
                person_valid and home_zone_valid and device_present
            )
            homeoffice_active = bool(
                self._homeoffice_source_valid
                and device_valid
                and person_home
                and device_home
            )
            homeoffice_active, self._homeoffice_reason = detect_homeoffice(
                person_valid,
                home_zone_valid,
                device_valid,
                person_home,
                device_home,
            )

        calendar_state = (
            self.hass.states.get(self.work_calendar_entity)
            if self.work_calendar_entity
            else None
        )
        calendar_source_valid = bool(
            not self.work_calendar_entity
            or (
                calendar_state is not None
                and calendar_state.state not in ("unknown", "unavailable")
                and not calendar_state.attributes.get("worklog_person_entity")
            )
        )
        self._office_source_valid = bool(
            person_valid and office_zone_valid and calendar_source_valid
        )
        return location, bool(person_valid), homeoffice_active

    def _work_calendar_allows_office(self, now: datetime) -> bool:
        """Allow office-zone accumulation during a timed or all-day work event."""
        if not self.work_calendar_entity:
            return True
        state = self.hass.states.get(self.work_calendar_entity)
        if (
            state is None
            or state.state != "on"
            or state.attributes.get("worklog_person_entity")
        ):
            return False
        start_value = state.attributes.get("start_time")
        end_value = state.attributes.get("end_time")
        if not isinstance(start_value, str) or not isinstance(end_value, str):
            return False
        local_now = dt_util.as_local(now)
        has_start_time = "T" in start_value
        has_end_time = "T" in end_value
        if has_start_time != has_end_time:
            return False
        if not has_start_time:
            try:
                start_date = date.fromisoformat(start_value[:10])
                end_date = date.fromisoformat(end_value[:10])
            except ValueError:
                return False
            # Calendar all-day event end dates are exclusive.
            return start_date <= local_now.date() < end_date
        start = dt_util.parse_datetime(start_value)
        end = dt_util.parse_datetime(end_value)
        if start is None or end is None:
            return False
        if start.tzinfo is None:
            start = start.replace(tzinfo=local_now.tzinfo)
        else:
            start = dt_util.as_local(start)
        if end.tzinfo is None:
            end = end.replace(tzinfo=local_now.tzinfo)
        else:
            end = dt_util.as_local(end)
        return start <= local_now < end

    async def _async_update_data(self) -> dict[str, Any]:
        """Accumulate each configured signal independently."""
        now = dt_util.utcnow()
        current_date = dt_util.now().date().isoformat()
        same_date = current_date == self._date
        if not same_date:
            self._history[self._date] = self._history_record()
            self._date = current_date
            self._office_seconds = 0.0
            self._homeoffice_seconds = 0.0

        if same_date and self._last_update is not None:
            elapsed = min(max(0.0, (now - self._last_update).total_seconds()), 90.0)
            if self._office_active:
                self._office_seconds += elapsed
            if self._homeoffice_active:
                self._homeoffice_seconds += elapsed

        location, person_valid, homeoffice_active = self._presence()
        self._location = location
        self._office_active = bool(
            self.office_zone_entity
            and person_valid
            and location == "office"
            and self._work_calendar_allows_office(now)
        )
        self._homeoffice_active = homeoffice_active
        self._last_update = now
        self.data = self._snapshot()
        self._history[self._date] = self._history_record()
        await self._async_save()
        return self.data

    def _snapshot(self) -> dict[str, Any]:
        """Return the current day classification and source diagnostics."""
        automatic_day_type = classify_day(
            self._office_seconds,
            self._homeoffice_seconds,
            self._office_active,
            self._homeoffice_active,
            self._office_source_valid,
            self._homeoffice_source_valid,
            threshold_seconds=self.threshold_seconds,
            homeoffice_enabled=self.homeoffice_enabled,
        )
        mixed_day = bool(
            self.homeoffice_enabled
            and self._office_seconds > 0
            and self._homeoffice_seconds > 0
            and automatic_day_type
            in {"office", "home_office", "office_and_home_office"}
        )
        if mixed_day:
            # On an exact time tie, classify as on-site attendance.
            automatic_day_type = (
                "office"
                if self._office_seconds >= self._homeoffice_seconds
                else "home_office"
            )
        saved_record = self._history.get(self._date, {})
        manual_override = saved_record.get("manual_override")
        if manual_override not in OVERRIDE_TYPES:
            manual_override = None
        seconds = round(self._office_seconds + self._homeoffice_seconds)
        return {
            "date": self._date,
            "office_seconds": round(self._office_seconds),
            "homeoffice_seconds": round(self._homeoffice_seconds),
            "seconds": seconds,
            "hours": round(seconds / 3600, 2),
            "office_active": self._office_active,
            "homeoffice_active": self._homeoffice_active,
            "location": self._location,
            "threshold_hours": self.threshold_hours,
            "threshold_minutes": self.threshold_minutes,
            "homeoffice_enabled": self.homeoffice_enabled,
            "work_calendar_entity": self.work_calendar_entity,
            "day_type": manual_override or automatic_day_type,
            "automatic_day_type": automatic_day_type,
            "mixed_day": mixed_day,
            "manual_override": manual_override,
            "office_source_valid": self._office_source_valid,
            "homeoffice_source_valid": self._homeoffice_source_valid,
            "person_source_valid": self._person_source_valid,
            "device_source_valid": self._device_source_valid,
            "person_status": self._person_status,
            "device_status": self._device_status,
            "homeoffice_reason": self._homeoffice_reason,
        }
