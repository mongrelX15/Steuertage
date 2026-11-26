"""Steuertage integration."""
from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from pathlib import Path
from typing import Any

import voluptuous as vol
from homeassistant.components import frontend, panel_custom, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.exceptions import ServiceValidationError
from homeassistant.util import dt as dt_util
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)

from .const import (
    CONF_DEVICE_TRACKER,
    CONF_HOME_ZONE,
    CONF_OFFICE_ZONE,
    CONF_PERSON,
    CONF_WORK_SIGNAL,
    DOMAIN,
)
from .coordinator import DAY_TYPES, WorklogCoordinator
from .holiday_dates import calendar_holidays, supported_countries

PLATFORMS = ["sensor", "calendar", "binary_sensor"]
PANEL_PATH = "steuertage"
PANEL_ASSET = Path(__file__).parent / "www" / "steuertage_panel.js"
PANEL_MODULE = f"/steuertage_static/steuertage_panel.js?v={hashlib.sha256(PANEL_ASSET.read_bytes()).hexdigest()[:16]}"
PANEL_STATIC_URL = "/steuertage_static"
PANEL_BRAND_URL = "/steuertage_brand"
PANEL_VERSION = json.loads((Path(__file__).parent / "manifest.json").read_text())["version"]
PANEL_SERVICE = "set_day_override"
MANUAL_DAY_TYPES = set(DAY_TYPES) | {"automatic"}


async def _async_setup_panel(hass: HomeAssistant) -> None:
    """Register one shared sidebar panel and one targeted correction service."""
    panel_data = hass.data.setdefault(f"{DOMAIN}_panel", {})
    if not panel_data.get("static_registered"):
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(
                    PANEL_STATIC_URL,
                    str(Path(__file__).parent / "www"),
                    cache_headers=True,
                ),
                StaticPathConfig(
                    PANEL_BRAND_URL,
                    str(Path(__file__).parent / "brand"),
                    cache_headers=True,
                )
            ]
        )
        panel_data["static_registered"] = True

    if not panel_data.get("backup_commands_registered"):
        @websocket_api.require_admin
        @websocket_api.websocket_command(
            {
                vol.Required("type"): "steuertage/export_history",
                vol.Required("person_entity"): str,
            }
        )
        @websocket_api.async_response
        async def export_history(
            _hass: HomeAssistant,
            connection: websocket_api.ActiveConnection,
            msg: dict[str, Any],
        ) -> None:
            """Return a per-person history backup to an administrator."""
            coordinator = next(
                (
                    item
                    for item in hass.data.get(DOMAIN, {}).values()
                    if item.person_entity == msg["person_entity"]
                ),
                None,
            )
            if coordinator is None:
                connection.send_error(
                    msg["id"],
                    websocket_api.ERR_NOT_FOUND,
                    "Für diese Person ist kein Verlauf eingerichtet.",
                )
                return
            connection.send_result(
                msg["id"],
                {
                    "format": "steuertage_backup",
                    "version": 1,
                    "person_entity": coordinator.person_entity,
                    "person_name": coordinator.person_name,
                    "created_at": dt_util.now().isoformat(),
                    "records": coordinator.export_history(),
                },
            )

        @websocket_api.require_admin
        @websocket_api.websocket_command(
            {
                vol.Required("type"): "steuertage/restore_history",
                vol.Required("person_entity"): str,
                vol.Required("records"): dict,
                vol.Optional("strategy", default="merge_newer"): vol.In({"replace", "merge_newer"}),
                vol.Optional("created_at", default=""): str,
            }
        )
        @websocket_api.async_response
        async def restore_history(
            _hass: HomeAssistant,
            connection: websocket_api.ActiveConnection,
            msg: dict[str, Any],
        ) -> None:
            """Restore a backup using the selected merge or replace strategy."""
            coordinator = next(
                (
                    item
                    for item in hass.data.get(DOMAIN, {}).values()
                    if item.person_entity == msg["person_entity"]
                ),
                None,
            )
            if coordinator is None:
                connection.send_error(
                    msg["id"],
                    websocket_api.ERR_NOT_FOUND,
                    "Für diese Person ist kein Verlauf eingerichtet.",
                )
                return
            try:
                result = await coordinator.async_restore_history(
                    msg["records"],
                    strategy=msg["strategy"],
                    backup_created_at=msg["created_at"],
                )
            except ValueError as err:
                connection.send_error(
                    msg["id"], websocket_api.ERR_INVALID_FORMAT, str(err)
                )
                return
            connection.send_result(msg["id"], result)

        websocket_api.async_register_command(hass, export_history)
        websocket_api.async_register_command(hass, restore_history)
        panel_data["backup_commands_registered"] = True

    if not panel_data.get("holiday_command_registered"):
        @websocket_api.websocket_command(
            {
                vol.Required("type"): "steuertage/holidays",
                vol.Required("country"): vol.All(str, vol.Length(min=2, max=2)),
                vol.Optional("subdivision", default=""): vol.All(str, vol.Length(max=20)),
                vol.Required("year"): vol.All(int, vol.Range(min=2, max=9998)),
            }
        )
        @websocket_api.async_response
        async def get_holidays(
            _hass: HomeAssistant,
            connection: websocket_api.ActiveConnection,
            msg: dict[str, Any],
        ) -> None:
            """Read the public holiday dates for a calendar region."""
            country, subdivision = msg["country"], msg["subdivision"]
            subdivisions = await hass.async_add_executor_job(supported_countries)
            if country not in subdivisions or (
                subdivision and subdivision not in subdivisions[country]
            ):
                connection.send_error(
                    msg["id"], websocket_api.ERR_INVALID_FORMAT, "Unbekannte Feiertagsregion."
                )
                return
            try:
                dates = await hass.async_add_executor_job(
                    calendar_holidays, country, subdivision, msg["year"]
                )
            except (ValueError, NotImplementedError):
                connection.send_error(
                    msg["id"], websocket_api.ERR_INVALID_FORMAT,
                    "Feiertage sind für diesen Zeitraum nicht verfügbar.",
                )
                return
            connection.send_result(msg["id"], dates)

        websocket_api.async_register_command(hass, get_holidays)
        panel_data["holiday_command_registered"] = True

    # Refresh the panel registration on reload so Home Assistant uses the
    # current module URL after a HACS update.
    if frontend.async_panel_exists(hass, PANEL_PATH):
        frontend.async_remove_panel(hass, PANEL_PATH, warn_if_unknown=False)
    await panel_custom.async_register_panel(
        hass=hass,
        frontend_url_path=PANEL_PATH,
        webcomponent_name="steuertage-panel",
        sidebar_title="Steuertage",
        sidebar_icon="mdi:calendar-check",
        module_url=PANEL_MODULE,
        config={"version": PANEL_VERSION},
    )

    if not hass.services.has_service(DOMAIN, PANEL_SERVICE):
        async def handle_day_override(call: ServiceCall) -> None:
            """Apply a correction only to the explicitly selected person."""
            person_entity = call.data["person_entity"]
            day = call.data["date"]
            day_type = call.data["day_type"]
            reason = call.data.get("reason", "")
            changed_by = call.context.user_id
            if not changed_by:
                raise ServiceValidationError(
                    "Für manuelle Änderungen wird ein angemeldeter HA-Benutzer benötigt."
                )
            if day_type not in MANUAL_DAY_TYPES:
                raise ServiceValidationError(f"Unbekannter Tagestyp: {day_type}")
            try:
                coordinator = next(
                    coordinator
                    for coordinator in hass.data.get(DOMAIN, {}).values()
                    if coordinator.person_entity == person_entity
                )
            except StopIteration as err:
                raise ServiceValidationError(
                    "Für diese Person ist kein Steuertage eingerichtet."
                ) from err
            try:
                user = await hass.auth.async_get_user(changed_by)
            except (AttributeError, ValueError, HomeAssistantError):
                user = None
            if (
                not coordinator.homeoffice_enabled
                and day_type in {"home_office", "office_and_home_office"}
            ):
                raise ServiceValidationError(
                    "Homeoffice-Tage sind für diese Person nicht aktiviert."
                )
            await coordinator.async_set_day_override(
                day,
                day_type,
                changed_by=str(changed_by),
                changed_by_name=user.name if user else None,
                reason=reason,
            )

        hass.services.async_register(
            DOMAIN,
            PANEL_SERVICE,
            handle_day_override,
            schema=vol.Schema(
                {
                    vol.Required("person_entity"): str,
                    vol.Required("date"): str,
                    vol.Required("day_type"): str,
                    vol.Optional("reason", default=""): vol.All(
                        str, vol.Length(max=500)
                    ),
                }
            ),
        )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up one independently tracked person."""
    coordinator = WorklogCoordinator(hass, entry)
    await coordinator.async_initialize()
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await _async_setup_panel(hass)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    @callback
    def changed(_event) -> None:
        hass.async_create_task(coordinator.async_refresh())

    async def refresh_interval(_now) -> None:
        await coordinator.async_refresh()

    tracked = [coordinator.person_entity]
    if coordinator.homeoffice_enabled and coordinator.home_zone_entity:
        tracked.append(coordinator.home_zone_entity)
    if coordinator.homeoffice_device_entity:
        tracked.append(coordinator.homeoffice_device_entity)
    if coordinator.legacy_signal_entity:
        tracked.append(coordinator.legacy_signal_entity)
    if coordinator.office_zone_entity:
        tracked.append(coordinator.office_zone_entity)
    if coordinator.work_calendar_entity:
        tracked.append(coordinator.work_calendar_entity)
    remove_state_listener = async_track_state_change_event(hass, tracked, changed)
    remove_timer = async_track_time_interval(
        hass, refresh_interval, timedelta(minutes=1)
    )
    entry.async_on_unload(remove_state_listener)
    entry.async_on_unload(remove_timer)
    entry.async_on_unload(entry.add_update_listener(async_reload_entry))
    await coordinator.async_refresh()
    return True


async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload the integration after options changes."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload one person's entities and remove shared UI only for the last entry."""
    if await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        hass.data[DOMAIN].pop(entry.entry_id)
        if not hass.data[DOMAIN]:
            frontend.async_remove_panel(hass, PANEL_PATH, warn_if_unknown=False)
            hass.services.async_remove(DOMAIN, PANEL_SERVICE)
        return True
    return False
