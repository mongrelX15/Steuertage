"""Coordinator that recognizes qualifying work days and stores per-person history."""
from __future__ import annotations

import asyncio
import copy
import logging
import math
import re
from datetime import date, datetime
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.helpers import entity_registry
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
    normalize_office_zones,
    append_manual_change,
    classify_day,
    detect_homeoffice,
    make_storage_key,
    normalize_day_record,
    within_zone_coordinates,
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
        self.office_zone_entities = normalize_office_zones(config.get(CONF_OFFICE_ZONE))
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
        self._history_lock = asyncio.Lock()
        self._next_site_number = 1
        self._configured_sites: set[str] = set()
        self._site_deletions: list[dict[str, Any]] = []
        self._office_sites: list[dict[str, Any]] = []
        self._office_site_ids: set[str] = set()
        self._active_office_site_ids: set[str] = set()
        self._last_update: datetime | None = None
        self._office_active = False
        self._homeoffice_active = False
        self._location: str | None = None
        self._office_source_valid = not bool(self.office_zone_entities)
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
            self._office_sites = [site for site in saved.get("office_sites", []) if isinstance(site, dict) and isinstance(site.get("id"), str) and isinstance(site.get("number"), int)]
            self._office_site_ids = {item for item in saved.get("office_site_ids", []) if isinstance(item, str)} if isinstance(saved.get("office_site_ids"), list) else set()
            self._next_site_number = saved.get("next_site_number", 1)
            self._site_deletions = saved.get("site_deletions", [])
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

        self._sync_office_sites()
        self._backfill_sole_office_site()
        self._office_site_ids.update(self._history.get(today, {}).get("automatic_office_site_ids", []))
        self.data = self._snapshot()
        self._history[today] = self._history_record()
        await self._async_save()

    def _sync_office_sites(self) -> None:
        """Assign persistent numbers and resolve entity-ID changes through the registry."""
        registry = entity_registry.async_get(self.hass)
        for site in self._office_sites:
            platform, unique_id = site.get("platform"), site.get("unique_id")
            if platform and unique_id:
                current = registry.async_get_entity_id("zone", platform, unique_id)
                if current and site.get("entity_id") in self.office_zone_entities:
                    self.office_zone_entities = [current if zone == site["entity_id"] else zone for zone in self.office_zone_entities]
                    site["entity_id"] = current
        self._next_site_number = max(
            self._next_site_number,
            max((site["number"] for site in self._office_sites), default=0) + 1,
        )
        self._configured_sites.clear()
        for zone in self.office_zone_entities:
            entry = registry.async_get(zone)
            site = next((item for item in self._office_sites if
                (entry and item.get("platform") == entry.platform and item.get("unique_id") == entry.unique_id)
                or (item.get("entity_id") == zone and (not entry or not item.get("unique_id")))), None)
            state = self.hass.states.get(zone)
            if site is None:
                next_number = self._next_site_number
                site = {"id": f"site_{next_number}", "number": next_number, "entity_id": zone,
                        "name": state.attributes.get("friendly_name", zone) if state else zone}
                self._office_sites.append(site)
                self._next_site_number += 1
            self._configured_sites.add(site["id"])
            site["entity_id"] = zone
            if entry:
                site["platform"], site["unique_id"] = entry.platform, entry.unique_id
            if state:
                site["name"] = state.attributes.get("friendly_name", zone)

    def office_sites(self) -> list[dict[str, Any]]:
        """Provide configured and historical sites for this person's panel."""
        return copy.deepcopy(self._office_sites)

    def homeoffice_years(self) -> list[int]:
        """Years containing effective Homeoffice days for the calendar legend."""
        return sorted({int(day[:4]) for day, record in self._history.items()
                       if record.get("day_type") in {"home_office", "office_and_home_office"}})

    def _office_sites_for_day(self, day_type: str, sites: list[str]) -> list[str]:
        """Infer a missing site only when this person has no other known site."""
        if (
            not sites and day_type in {"office", "office_and_home_office"}
            and len(self._configured_sites) == len(self._office_sites) == 1
        ):
            return list(self._configured_sites)
        return sites

    def _backfill_sole_office_site(self) -> None:
        """Persist inferred locations without rewriting existing assignments."""
        if not self._office_sites_for_day("office", []):
            return
        for day, record in self._history.items():
            sites = self._office_sites_for_day(record["day_type"], record["office_site_ids"])
            automatic_sites = self._office_sites_for_day(
                record["automatic_day_type"], record["automatic_office_site_ids"]
            )
            manual_sites = record["manual_office_site_ids"]
            if record["manual_override"] in {"office", "office_and_home_office"}:
                manual_sites = manual_sites or sites
            if (sites, automatic_sites, manual_sites) != (
                record["office_site_ids"], record["automatic_office_site_ids"], record["manual_office_site_ids"]
            ):
                self._history[day] = {
                    **record, "office_site_ids": sites, "automatic_office_site_ids": automatic_sites,
                    "manual_office_site_ids": manual_sites,
                }

    def panel_office_sites(self) -> list[dict[str, Any]]:
        """Include the configuration status of each site."""
        return [{**site, "active": site["id"] in self._configured_sites} for site in self.office_sites()]

    def history_backup(self) -> dict[str, Any]:
        """Build a per-person backup for downloads and historical-site deletion."""
        return {
            "format": "steuertage_backup",
            "version": 1,
            "person_entity": self.person_entity,
            "person_name": self.person_name,
            "created_at": dt_util.now().isoformat(),
            "records": self.export_history(),
            "office_sites": self.office_sites(),
            "next_site_number": self._next_site_number,
            "site_deletions": copy.deepcopy(self._site_deletions),
        }

    def historical_office_sites(self) -> dict[str, Any]:
        """Return inactive sites and their day counts across all years."""
        sites = {
            site["id"]: {**site, "days": 0}
            for site in self.office_sites() if site["id"] not in self._configured_sites
        }
        for record in self._history.values():
            if record.get("day_type") in {"office", "office_and_home_office", "home_office"}:
                for site_id in set(record.get("office_site_ids", [])) & sites.keys():
                    sites[site_id]["days"] += 1
        return {
            "sites": sorted(sites.values(), key=lambda site: site["number"]),
            "deletions": copy.deepcopy(self._site_deletions),
        }

    async def async_delete_office_site(
        self, site_id: str, confirmed_days: int, *, changed_by: str, changed_by_name: str
    ) -> dict[str, Any]:
        """Back up and remove an inactive site without changing any day types."""
        async with self._history_lock:
            site = next((site for site in self.historical_office_sites()["sites"] if site["id"] == site_id), None)
            if site is None:
                raise ValueError("Nur historische Arbeitsstandorte können gelöscht werden.")
            if site["days"] != confirmed_days:
                raise ValueError("Die Zahl betroffener Tage hat sich geändert. Bitte erneut bestätigen.")
            backup = Store(self.hass, 1, make_storage_key(self.entry_id) + "_pre_site_delete")
            await backup.async_save(self.history_backup())

            history = self._history.copy()
            site_label = {key: site[key] for key in ("id", "number", "name")}
            timestamp = dt_util.utcnow().isoformat()
            for day, original in self._history.items():
                record = original.copy()
                for key in ("office_site_ids", "automatic_office_site_ids", "manual_office_site_ids"):
                    ids = original.get(key)
                    if isinstance(ids, list) and site_id in ids:
                        record[key] = [item for item in ids if item != site_id]
                if record == original:
                    continue
                old_sites = original.get("office_site_ids", [])
                if record["office_site_ids"] != old_sites:
                    value = original["manual_override"] or original["day_type"]
                    changes = append_manual_change(
                        original["change_history"], person_id=self.person_entity,
                        changed_by=changed_by, timestamp=timestamp, old_value=value, new_value=value,
                        reason="Historischer Arbeitsstandort gelöscht",
                    )
                    changes[-1].update(
                        changed_by_name=changed_by_name, old_office_site_ids=old_sites,
                        new_office_site_ids=record["office_site_ids"], deleted_office_site=site_label,
                    )
                    record["change_history"] = changes
                record["updated_at"] = timestamp
                history[day] = record

            previous = (self._history, self._office_sites, self._office_site_ids, self._site_deletions)
            self._history = history
            self._office_sites = [item for item in self._office_sites if item["id"] != site_id]
            self._office_site_ids = self._office_site_ids - {site_id}
            self._site_deletions = [{
                **site_label, "days": site["days"], "timestamp": timestamp,
                "changed_by": changed_by, "changed_by_name": changed_by_name,
            }, *self._site_deletions]
            self._backfill_sole_office_site()
            snapshot = self._snapshot()
            try:
                await self._async_save(snapshot)
            except Exception:
                self._history, self._office_sites, self._office_site_ids, self._site_deletions = previous
                raise
            self.async_set_updated_data(snapshot)
            return self.historical_office_sites()

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
            "office_site_ids": list(self.data["office_site_ids"]),
            "automatic_office_site_ids": self._office_sites_for_day(
                self.data["automatic_day_type"], sorted(self._office_site_ids)
            ),
            "manual_office_site_ids": previous.get("manual_office_site_ids"),
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

    def entity_summary(self) -> dict[str, Any]:
        """Read dashboard values from the same effective daily records as the calendar."""
        today = dt_util.now().date().isoformat()
        month = today[:7]
        year = today[:4]
        counts = {
            "homeoffice_month": 0, "office_month": 0,
            "homeoffice_year": 0, "office_year": 0, "open_reviews": 0,
        }
        for day, record in {**self._history, self._date: self.data}.items():
            if not isinstance(day, str) or not isinstance(record, dict):
                continue
            day_type = record.get("day_type")
            if day_type == "needs_review":
                counts["open_reviews"] += 1
            if day[:4] != year:
                continue
            if day_type in {"home_office", "office_and_home_office"}:
                counts["homeoffice_year"] += 1
                if day[:7] == month:
                    counts["homeoffice_month"] += 1
            if day_type in {"office", "office_and_home_office"}:
                counts["office_year"] += 1
                if day[:7] == month:
                    counts["office_month"] += 1
        return counts

    def _restore_state(self) -> tuple:
        return (
            self._history, self._office_sites, self._next_site_number, self._site_deletions,
            self._office_seconds, self._homeoffice_seconds, self._office_site_ids, self.data,
        )

    def _set_restore_state(self, state: tuple) -> None:
        (
            self._history, self._office_sites, self._next_site_number, self._site_deletions,
            self._office_seconds, self._homeoffice_seconds, self._office_site_ids, self.data,
        ) = state

    def _stage_history_restore(
        self,
        records: dict[str, Any],
        *,
        strategy: str = "merge_newer",
        backup_created_at: str | None = None,
        office_sites: list[dict[str, Any]] | None = None,
        next_site_number: int = 1,
        site_deletions: list[dict] | None = None,
    ) -> dict[str, int]:
        """Validate and stage a person's restore under the history lock."""
        if not isinstance(records, dict):
            raise ValueError("Die Sicherungsdatei enthält keine Tagesliste.")
        if strategy not in {"replace", "merge_newer"}:
            raise ValueError("Unbekannte Wiederherstellungsart.")

        if type(next_site_number) is not int or next_site_number < 1:
            raise ValueError("Ungültige nächste Standortnummer.")
        if backup_created_at is not None and not isinstance(backup_created_at, str):
            raise ValueError("Ungültiges Sicherungsdatum.")
        backup_time = dt_util.parse_datetime(backup_created_at) if backup_created_at else None
        if backup_created_at and (backup_time is None or backup_time.tzinfo is None):
            raise ValueError("Ungültiges Sicherungsdatum.")
        self._history = self._history.copy()
        self._office_sites = self._office_sites.copy()
        if site_deletions is not None:
            if not isinstance(site_deletions, list) or any(
                not isinstance(item, dict)
                or not all(isinstance(item.get(key), str) for key in ("id", "timestamp", "name"))
                or not all(type(item.get(key)) is int and item[key] >= 0 for key in ("number", "days"))
                for item in site_deletions
            ):
                raise ValueError("Ungültiges Standort-Löschprotokoll.")
            events = {(item["id"], item["timestamp"]): item for item in [*site_deletions, *self._site_deletions]}
            self._site_deletions = sorted(events.values(), key=lambda item: item["timestamp"], reverse=True)
        if office_sites is not None:
            if not isinstance(office_sites, list):
                raise ValueError("Ungültige Standortliste.")
            known = {site["id"]: site for site in self._office_sites}
            numbers = {site["number"]: site["id"] for site in self._office_sites}
            additions = []
            for site in office_sites:
                if (not isinstance(site, dict) or not isinstance(site.get("id"), str)
                        or type(site.get("number")) is not int or site["number"] < 1
                        or not isinstance(site.get("name"), str)):
                    raise ValueError("Ungültige Standortliste.")
                current = known.get(site["id"])
                if current:
                    identity_mismatch = (
                        (current.get("platform") and site.get("platform") and current["platform"] != site["platform"])
                        or (current.get("unique_id") and site.get("unique_id") and current["unique_id"] != site["unique_id"])
                    )
                    if current["number"] != site["number"] or identity_mismatch:
                        raise ValueError("Standortkennung der Sicherung widerspricht der vorhandenen Konfiguration.")
                    continue
                if site["number"] in numbers:
                    raise ValueError("Standortnummer der Sicherung ist bereits vergeben.")
                known[site["id"]] = site
                numbers[site["number"]] = site["id"]
                additions.append(copy.deepcopy(site))
            self._office_sites.extend(additions)
        self._next_site_number = max(
            self._next_site_number, next_site_number,
            max((site["number"] for site in self._office_sites), default=0) + 1,
        )
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
                for field in ("office_site_ids", "automatic_office_site_ids", "manual_office_site_ids"):
                    ids = record.get(field)
                    if (field in record and not (field == "manual_office_site_ids" and ids is None)
                            and (not isinstance(ids, list) or any(not isinstance(item, str) for item in ids))):
                        raise ValueError("Ungültige Standortzuordnung.")
                normalized = self._normalize_record(record)
                timestamp = normalized.get("updated_at")
                if timestamp:
                    parsed_timestamp = dt_util.parse_datetime(timestamp)
                    if parsed_timestamp is None or parsed_timestamp.tzinfo is None:
                        raise ValueError("Ungültiger Zeitstempel.")
                current = self._history.get(day_string)
                if current and normalized["day_type"] in {"office", "home_office", "office_and_home_office"}:
                    # Legacy exports without location fields carry no instruction to clear them.
                    for field in ("office_site_ids", "automatic_office_site_ids", "manual_office_site_ids"):
                        if field not in record:
                            normalized[field] = current[field]
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
            except (TypeError, ValueError, OverflowError) as err:
                raise ValueError(f"Ungültiger Datensatz für {day_string}.") from err

        if imported or replaced or office_sites is not None or next_site_number > 1:
            self._backfill_sole_office_site()
            if changed_today and self._date in self._history:
                restored_today = self._history[self._date]
                self._office_seconds = float(restored_today.get("office_seconds", 0))
                self._homeoffice_seconds = float(restored_today.get("homeoffice_seconds", 0))
                self._office_site_ids = set(restored_today.get("automatic_office_site_ids", restored_today.get("office_site_ids", [])))
                self.data = self._snapshot()
                self._history[self._date] = self._history_record()
            self.data = self._snapshot()
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
        office_site_ids: list[str] | None = None,
    ) -> None:
        """Persist a manual correction and append an authenticated audit record."""
        async with self._history_lock:
            if self._set_day_override(
                day_string, day_type, changed_by=changed_by, changed_by_name=changed_by_name,
                reason=reason, office_site_ids=office_site_ids,
            ):
                self.data = self._snapshot()
                await self._async_save()
                self.async_set_updated_data(self.data)

    async def async_toggle_office_site(
        self, days: list[str], site_id: str, *, changed_by: str, changed_by_name: str,
    ) -> list[dict[str, Any]]:
        """Apply one site change to a selection while retaining its other assignments."""
        keys = sorted({date.fromisoformat(day).isoformat() for day in days})
        async with self._history_lock:
            if site_id not in {site["id"] for site in self._office_sites}:
                raise ValueError("Unbekannter Arbeitsstandort.")
            records = {day: self._history.get(day, {}) for day in keys}
            remove = site_id not in self._configured_sites or all(
                site_id in record.get("office_site_ids", [])
                and record.get("day_type") in {"office", "office_and_home_office"}
                for record in records.values()
            )
            operations = []
            try:
                for day, record in records.items():
                    before_sites = record.get("office_site_ids", [])
                    is_office = record.get("day_type") in {"office", "office_and_home_office"}
                    assigned = is_office and site_id in before_sites
                    if assigned != remove:
                        continue
                    after_sites = [item for item in before_sites if item != site_id]
                    if not remove:
                        after_sites.append(site_id)
                    after = "office_and_home_office" if record.get("day_type") == "office_and_home_office" else "office"
                    if self._set_day_override(
                        day, after, changed_by=changed_by, changed_by_name=changed_by_name,
                        office_site_ids=after_sites,
                    ):
                        operations.append({
                            "date": day, "before": record.get("manual_override") or "automatic",
                            "beforeSites": before_sites, "after": after, "afterSites": after_sites,
                        })
                if operations:
                    snapshot = self._snapshot()
                    await self._async_save(snapshot)
                    self.async_set_updated_data(snapshot)
            except Exception:
                for day, record in records.items():
                    if record:
                        self._history[day] = record
                    else:
                        self._history.pop(day, None)
                raise
            return operations

    def _set_day_override(
        self, day_string: str, day_type: str, *, changed_by: str,
        changed_by_name: str | None, reason: str | None = None,
        office_site_ids: list[str] | None = None,
    ) -> bool:
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

        known_sites = {site["id"] for site in self._office_sites}
        if office_site_ids is not None and (
            not isinstance(office_site_ids, list)
            or any(not isinstance(site_id, str) or site_id not in known_sites for site_id in office_site_ids)
        ):
            raise ValueError("Unbekannter Arbeitsstandort.")
        previous_sites = list(existing.get("office_site_ids", []))
        new_sites = (list(dict.fromkeys(office_site_ids)) if office_site_ids is not None
                     else previous_sites)
        if day_type not in {"office", "office_and_home_office", "automatic"}:
            new_sites = []
        if day_type == "automatic":
            new_sites = sorted(self._office_site_ids) if key == self._date else list(existing.get("automatic_office_site_ids", previous_sites))
        override = None if day_type == "automatic" else day_type
        new_value = override or automatic
        new_sites = self._office_sites_for_day(new_value, new_sites)
        manual_sites = existing.get("manual_office_site_ids")
        if day_type == "automatic":
            manual_sites = None
        elif office_site_ids is not None or (new_sites and self._office_sites_for_day(day_type, [])):
            manual_sites = new_sites
        # Repeating the same manual choice is a no-op. For "automatic", only
        # skip if both the effective and stored automatic classifications match.
        if override is not None and existing.get("manual_override") == override and previous_sites == new_sites:
            return False
        if (
            override is None
            and existing.get("manual_override") is None
            and existing.get("day_type") == new_value
            and existing.get("automatic_day_type") == automatic
            and previous_sites == new_sites
        ):
            return False
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
        change_history[-1]["old_office_site_ids"] = previous_sites
        change_history[-1]["new_office_site_ids"] = new_sites
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
            "office_site_ids": new_sites,
            "automatic_office_site_ids": sorted(self._office_site_ids) if key == self._date else list(existing.get("automatic_office_site_ids", previous_sites)),
            "manual_office_site_ids": manual_sites,
            "change_history": change_history,
            "updated_at": dt_util.now().isoformat(),
        }
        return True

    async def _async_save(self, snapshot: dict[str, Any] | None = None) -> None:
        """Persist this person's counters and history under their own key."""
        await self.store.async_save(self._storage_data(snapshot))

    def _storage_data(self, snapshot: dict[str, Any] | None = None) -> dict[str, Any]:
        return {
            "date": self._date,
            "office_seconds": self._office_seconds,
            "homeoffice_seconds": self._homeoffice_seconds,
            "day_type": (snapshot or self.data)["day_type"],
            "location": self._location,
            "history": self._history,
            "office_sites": self._office_sites,
            "next_site_number": self._next_site_number,
            "site_deletions": self._site_deletions,
            "office_site_ids": sorted(self._office_site_ids),
        }

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

    def _is_at_office_site(self, person, zone_entity: str) -> bool:
        """Include every intersecting office zone without changing day classification."""
        if self._is_in_zone(person, zone_entity):
            return True
        zone = self.hass.states.get(zone_entity)
        return bool(person and zone and zone.state not in ("unknown", "unavailable")
                    and within_zone_coordinates(person.attributes, zone.attributes))

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

        available_office_zones = [
            zone for zone in self.office_zone_entities
            if (state := self.hass.states.get(zone)) is not None
            and state.state not in ("unknown", "unavailable")
        ]
        office_zone_valid = not self.office_zone_entities or bool(available_office_zones)
        if not person_valid:
            location = None
        elif self.homeoffice_enabled and self._is_in_zone(person, self.home_zone_entity):
            location = "home"
        elif any(self._is_in_zone(person, zone) for zone in available_office_zones):
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
        async with self._history_lock:
            now = dt_util.utcnow()
            current_date = dt_util.now().date().isoformat()
            same_date = current_date == self._date
            if not same_date:
                self._history[self._date] = self._history_record()
                self._date = current_date
                self._office_seconds = 0.0
                self._homeoffice_seconds = 0.0
                self._office_site_ids = set()

            if same_date and self._last_update is not None:
                elapsed = min(max(0.0, (now - self._last_update).total_seconds()), 90.0)
                if self._office_active:
                    self._office_seconds += elapsed
                    self._office_site_ids.update(self._active_office_site_ids)
                if self._homeoffice_active:
                    self._homeoffice_seconds += elapsed

            location, person_valid, homeoffice_active = self._presence()
            self._location = location
            self._active_office_site_ids = {
                site["id"] for site in self._office_sites
                if site["id"] in self._configured_sites
                and self._is_at_office_site(self.hass.states.get(self.person_entity), site["entity_id"])
            } if location == "office" else set()
            self._office_active = bool(
                self.office_zone_entities
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
        day_type = manual_override or automatic_day_type
        manual_sites = saved_record.get("manual_office_site_ids")
        sites = manual_sites if isinstance(manual_sites, list) else sorted(self._office_site_ids)
        return {
            "date": self._date,
            "office_seconds": round(self._office_seconds),
            "homeoffice_seconds": round(self._homeoffice_seconds),
            "office_site_ids": self._office_sites_for_day(day_type, list(sites)),
            "seconds": seconds,
            "hours": round(seconds / 3600, 2),
            "office_active": self._office_active,
            "homeoffice_active": self._homeoffice_active,
            "location": self._location,
            "threshold_hours": self.threshold_hours,
            "threshold_minutes": self.threshold_minutes,
            "homeoffice_enabled": self.homeoffice_enabled,
            "work_calendar_entity": self.work_calendar_entity,
            "day_type": day_type,
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
