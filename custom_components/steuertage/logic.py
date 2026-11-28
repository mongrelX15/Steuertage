"""Pure classification helpers used by Steuertage."""
from __future__ import annotations

import math

from .const import (
    BETA_THRESHOLD_SECONDS,
    CONF_DEVICE_TRACKER,
    CONF_HOME_OFFICE_ENABLED,
    CONF_WORK_SIGNAL,
    DOMAIN,
)


def within_zone_coordinates(person_attributes: dict, zone_attributes: dict) -> bool:
    """Resolve overlapping office zones from GPS coordinates when available."""
    try:
        lat1 = math.radians(float(person_attributes["latitude"]))
        lon1 = math.radians(float(person_attributes["longitude"]))
        lat2 = math.radians(float(zone_attributes["latitude"]))
        lon2 = math.radians(float(zone_attributes["longitude"]))
        radius = float(zone_attributes["radius"])
        if not all(math.isfinite(value) for value in (lat1, lon1, lat2, lon2, radius)) or radius < 0:
            return False
        a = (math.sin((lat2 - lat1) / 2) ** 2
             + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
        return 6371000 * 2 * math.asin(min(1.0, math.sqrt(a))) <= radius
    except (KeyError, TypeError, ValueError, OverflowError):
        return False


def normalize_office_zones(value: str | list[str] | tuple[str, ...] | None) -> list[str]:
    """Read legacy single-zone and new multi-zone configuration."""
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple)):
        return []
    return list(dict.fromkeys(zone for zone in value if isinstance(zone, str) and zone.startswith("zone.")))


def classify_day(
    office_seconds: float,
    homeoffice_seconds: float,
    office_active: bool,
    homeoffice_active: bool,
    office_source_valid: bool,
    homeoffice_source_valid: bool,
    threshold_seconds: int = BETA_THRESHOLD_SECONDS,
    homeoffice_enabled: bool = True,
) -> str:
    """Classify a day from the configured qualifying signals."""
    office_qualifies = office_seconds >= threshold_seconds
    homeoffice_qualifies = homeoffice_enabled and homeoffice_seconds >= threshold_seconds
    homeoffice_active = homeoffice_enabled and homeoffice_active

    if office_qualifies and homeoffice_qualifies:
        return "office_and_home_office"
    if office_qualifies:
        return "office"
    if homeoffice_qualifies:
        return "home_office"
    if office_active or homeoffice_active:
        return "tracking"
    # A signal that has stopped before reaching the threshold does not make
    # the date a workday. Missing or unavailable sources also mean no signal.
    return "no_work"


def detect_homeoffice(
    person_valid: bool,
    home_zone_valid: bool,
    device_valid: bool,
    person_home: bool,
    device_home: bool,
) -> tuple[bool, str]:
    """Return a fail-closed Homeoffice result and a diagnostic reason."""
    if not person_valid:
        return False, "person_unavailable"
    if not home_zone_valid:
        return False, "home_zone_unavailable"
    if not person_home:
        return False, "person_outside_home_zone"
    if not device_valid:
        return False, "device_unavailable"
    if not device_home:
        return False, "device_outside_home_zone"
    return True, "person_and_device_in_home_zone"


def append_manual_change(
    history: list[dict],
    *,
    person_id: str,
    changed_by: str,
    timestamp: str,
    old_value: str,
    new_value: str,
    reason: str | None,
) -> list[dict]:
    """Append one audit entry without replacing earlier changes."""
    safe_history = [item for item in history if isinstance(item, dict)]
    safe_history.append({
        "person_id": person_id,
        "changed_by": changed_by,
        "timestamp": timestamp,
        "old_value": old_value,
        "new_value": new_value,
        "reason": (reason or "").strip() or None,
    })
    return safe_history


def make_storage_key(entry_id: str) -> str:
    """Return isolated persistent storage for a single config entry/person."""
    return f"{DOMAIN}_{entry_id}"


def normalize_day_record(
    record: dict,
    *,
    day_types: tuple[str, ...],
    override_types: tuple[str, ...],
) -> dict:
    """Normalize old daily records while keeping valid manual audit history."""
    office_seconds = float(record.get("office_seconds", 0))
    homeoffice_seconds = float(record.get("homeoffice_seconds", 0))
    legacy_seconds = float(record.get("seconds", 0))
    legacy_type = record.get("day_type")
    if not office_seconds and not homeoffice_seconds and legacy_seconds:
        if legacy_type == "office" or record.get("location") == "office":
            office_seconds = legacy_seconds
        elif legacy_type == "home_office" or record.get("location") == "home":
            homeoffice_seconds = legacy_seconds
    day_type = record.get("day_type", "needs_review")
    if day_type not in day_types:
        day_type = "needs_review"
    manual_override = record.get("manual_override")
    if manual_override not in override_types:
        manual_override = None
    automatic_day_type = record.get("automatic_day_type", day_type)
    if automatic_day_type not in day_types:
        automatic_day_type = "needs_review"
    # Older records may lack a separate automatic type for manual-only statuses.
    manual_only = {"vacation", "sick_leave", "business_trip"}
    if automatic_day_type in manual_only:
        automatic_day_type = "needs_review"
    if day_type in manual_only and manual_override is None:
        manual_override = day_type
    change_history = record.get("change_history", [])
    if not isinstance(change_history, list):
        change_history = []
    mixed_day = bool(record.get("mixed_day")) or (
        day_type == "office_and_home_office"
        or automatic_day_type == "office_and_home_office"
        or (
            office_seconds > 0
            and homeoffice_seconds > 0
            and (
                day_type in {"office", "home_office", "office_and_home_office"}
                or automatic_day_type in {"office", "home_office", "office_and_home_office"}
            )
        )
    )
    return {
        "day_type": manual_override or day_type,
        "automatic_day_type": automatic_day_type,
        "manual_override": manual_override,
        "mixed_day": mixed_day,
        "office_seconds": round(office_seconds),
        "homeoffice_seconds": round(homeoffice_seconds),
        "office_site_ids": list(dict.fromkeys(
            item for item in record.get("office_site_ids", [])
            if isinstance(item, str)
        )) if isinstance(record.get("office_site_ids"), list) else [],
        "automatic_office_site_ids": list(dict.fromkeys(
            item for item in record.get("automatic_office_site_ids", record.get("office_site_ids", []))
            if isinstance(item, str)
        )) if isinstance(record.get("automatic_office_site_ids", record.get("office_site_ids", [])), list) else [],
        "manual_office_site_ids": (
            list(dict.fromkeys(item for item in record["manual_office_site_ids"] if isinstance(item, str)))
            if isinstance(record.get("manual_office_site_ids"), list) else None
        ),
        "change_history": [item for item in change_history if isinstance(item, dict)],
        "updated_at": record.get("updated_at") if isinstance(record.get("updated_at"), str) else None,
    }


def find_person_configuration_conflicts(
    values: dict,
    configurations: list[dict],
    *,
    exclude_entry_id: str | None = None,
) -> set[str]:
    """Find duplicate person and Homeoffice tracker assignments."""
    errors: set[str] = set()
    person = values.get("person_entity")
    tracker = values.get("homeoffice_device")
    legacy_user_id = values.get("ha_user_id") or None
    for config in configurations:
        if config.get("entry_id") == exclude_entry_id:
            continue
        current = config.get("values", {})
        if person and current.get("person_entity") == person:
            errors.add("already_configured")
        homeoffice_enabled = values.get(
            CONF_HOME_OFFICE_ENABLED,
            bool(current.get(CONF_DEVICE_TRACKER) or current.get(CONF_WORK_SIGNAL)),
        )
        if (
            homeoffice_enabled
            and tracker
            and current.get(CONF_HOME_OFFICE_ENABLED, True)
            and current.get("homeoffice_device") == tracker
        ):
            errors.add("device_already_configured")
        if legacy_user_id and current.get("ha_user_id") == legacy_user_id:
            errors.add("user_already_configured")
    return errors
