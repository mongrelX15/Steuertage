"""Config flow for Steuertage."""
from __future__ import annotations

from typing import Any

import probatio
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.data_entry_flow import section
from homeassistant.helpers import selector
from homeassistant.helpers.selector import NumberSelectorMode

from .const import (
    CONF_DEVICE_TRACKER,
    CONF_HA_USER_ID,
    CONF_HOLIDAY_COUNTRY,
    CONF_HOLIDAY_SUBDIVISION,
    CONF_SHOW_HOLIDAYS,
    CONF_HOME_OFFICE_ENABLED,
    CONF_HOME_ZONE,
    CONF_OFFICE_ZONE,
    CONF_PERSON,
    CONF_THRESHOLD_HOURS,
    CONF_THRESHOLD_MINUTES,
    CONF_WORK_CALENDAR,
    CONF_WORK_CALENDAR_ENABLED,
    CONF_WORK_SIGNAL,
    DEFAULT_THRESHOLD_HOURS,
    DOMAIN,
)
from .holiday_dates import supported_countries
from .logic import find_person_configuration_conflicts


_SETUP_LINKS = {
    "fritz_url": "https://www.home-assistant.io/integrations/fritz/",
    "unifi_url": "https://www.home-assistant.io/integrations/unifi/",
    "regions_url": "https://pypi.org/project/holidays/#user-content-available-countries",
}


_SETUP_SECTIONS = {
    "homeoffice": (CONF_HOME_OFFICE_ENABLED, CONF_HOME_ZONE, CONF_DEVICE_TRACKER),
    "work_calendar": (CONF_WORK_CALENDAR_ENABLED, CONF_WORK_CALENDAR),
    "holidays": (CONF_SHOW_HOLIDAYS, CONF_HOLIDAY_COUNTRY, CONF_HOLIDAY_SUBDIVISION),
}


def _flatten_setup(values: dict[str, Any]) -> dict[str, Any]:
    return {
        **{key: value for key, value in values.items() if key not in _SETUP_SECTIONS},
        **{key: value for name in _SETUP_SECTIONS for key, value in values.get(name, {}).items()},
    }


def _setup_errors(errors: dict[str, str]) -> dict[str, str]:
    sections_by_field = {
        key: name for name, fields in _SETUP_SECTIONS.items() for key in fields
    }
    return {sections_by_field.get(key, key): error for key, error in errors.items()}


def _optional_entity_field(
    fields: dict[Any, Any],
    key: str,
    domain: str,
    defaults: dict[str, Any],
) -> None:
    """Add an entity selector that stays optional when left blank."""
    default = defaults.get(key)
    marker = probatio.Optional(key, default=default) if default else probatio.Optional(key)
    fields[marker] = selector.EntitySelector(
        selector.EntitySelectorConfig(domain=domain)
    )


def _setup_schema(
    defaults: dict[str, Any] | None = None, *, include_person: bool = True
) -> probatio.Schema:
    """Build the complete one-page setup form."""
    defaults = defaults or {}
    fields: dict[Any, Any] = {}
    sections: dict[str, dict[Any, Any]] = {name: {} for name in _SETUP_SECTIONS}
    root = fields
    if include_person:
        fields[probatio.Required(CONF_PERSON)] = selector.EntitySelector(
            selector.EntitySelectorConfig(domain="person")
        )

    fields[probatio.Required(
        CONF_OFFICE_ZONE,
        default=defaults.get(CONF_OFFICE_ZONE) or "",
    )] = selector.EntitySelector(selector.EntitySelectorConfig(domain="zone"))
    legacy_minutes = defaults.get(CONF_THRESHOLD_MINUTES)
    default_hours = defaults.get(
        CONF_THRESHOLD_HOURS,
        float(legacy_minutes) / 60 if legacy_minutes is not None else DEFAULT_THRESHOLD_HOURS,
    )
    fields[probatio.Required(
        CONF_THRESHOLD_HOURS,
        default=float(default_hours),
    )] = selector.NumberSelector(
        selector.NumberSelectorConfig(
            min=0.5, max=24, step=0.5, mode=NumberSelectorMode.BOX
        )
    )
    fields = sections["homeoffice"]
    fields[probatio.Required(
        CONF_HOME_OFFICE_ENABLED,
        default=bool(defaults.get(CONF_HOME_OFFICE_ENABLED, False)),
    )] = selector.BooleanSelector()
    _optional_entity_field(fields, CONF_HOME_ZONE, "zone", defaults)
    _optional_entity_field(fields, CONF_DEVICE_TRACKER, "device_tracker", defaults)
    fields = sections["work_calendar"]
    fields[probatio.Required(
        CONF_WORK_CALENDAR_ENABLED,
        default=bool(defaults.get(
            CONF_WORK_CALENDAR_ENABLED, bool(defaults.get(CONF_WORK_CALENDAR))
        )),
    )] = selector.BooleanSelector()
    _optional_entity_field(fields, CONF_WORK_CALENDAR, "calendar", defaults)
    fields = sections["holidays"]
    fields[probatio.Optional(
        CONF_SHOW_HOLIDAYS, default=bool(defaults.get(CONF_SHOW_HOLIDAYS))
    )] = selector.BooleanSelector()
    country = defaults.get(CONF_HOLIDAY_COUNTRY)
    country_field = (
        probatio.Optional(CONF_HOLIDAY_COUNTRY, default=country)
        if country
        else probatio.Optional(CONF_HOLIDAY_COUNTRY)
    )
    fields[country_field] = selector.CountrySelector(
        selector.CountrySelectorConfig(countries=sorted(supported_countries()))
    )
    fields[probatio.Optional(
        CONF_HOLIDAY_SUBDIVISION,
        description={"suggested_value": defaults.get(CONF_HOLIDAY_SUBDIVISION) or ""},
    )] = selector.TextSelector()
    for name, fields in sections.items():
        root[probatio.Required(name)] = section(probatio.Schema(fields))
    return probatio.Schema(root)


def _base_schema(
    defaults: dict[str, Any] | None = None, *, include_person: bool = True
) -> vol.Schema:
    """Build the required person, work zone and threshold form."""
    defaults = defaults or {}
    fields: dict[Any, Any] = {}
    if include_person:
        fields[vol.Required(CONF_PERSON)] = selector.EntitySelector(
            selector.EntitySelectorConfig(domain="person")
        )
    fields[vol.Required(
        CONF_OFFICE_ZONE,
        default=defaults.get(CONF_OFFICE_ZONE) or "",
    )] = selector.EntitySelector(selector.EntitySelectorConfig(domain="zone"))
    legacy_minutes = defaults.get(CONF_THRESHOLD_MINUTES)
    default_hours = defaults.get(
        CONF_THRESHOLD_HOURS,
        float(legacy_minutes) / 60 if legacy_minutes is not None else DEFAULT_THRESHOLD_HOURS,
    )
    fields[vol.Required(
        CONF_THRESHOLD_HOURS,
        default=float(default_hours),
    )] = selector.NumberSelector(
        selector.NumberSelectorConfig(
            min=0.5, max=24, step=0.5, mode=NumberSelectorMode.BOX
        )
    )
    return vol.Schema(fields)


def _homeoffice_schema(
    defaults: dict[str, Any] | None = None,
    *,
    include_legacy_signal: bool = False,
) -> vol.Schema:
    """Build the Homeoffice source form shown only when selected."""
    defaults = defaults or {}
    fields: dict[Any, Any] = {
        vol.Required(
            CONF_HOME_ZONE,
            default=defaults.get(CONF_HOME_ZONE) or "zone.home",
        ): selector.EntitySelector(selector.EntitySelectorConfig(domain="zone")),
        (
            vol.Optional(
                CONF_DEVICE_TRACKER,
                default=defaults.get(CONF_DEVICE_TRACKER) or "",
            )
            if include_legacy_signal
            else vol.Required(
                CONF_DEVICE_TRACKER,
                default=defaults.get(CONF_DEVICE_TRACKER) or "",
            )
        ): selector.EntitySelector(selector.EntitySelectorConfig(domain="device_tracker")),
    }
    if include_legacy_signal:
        fields[vol.Optional(
            CONF_WORK_SIGNAL,
            default=defaults.get(CONF_WORK_SIGNAL) or "",
        )] = selector.EntitySelector(selector.EntitySelectorConfig(domain="binary_sensor"))
    return vol.Schema(fields)


def _work_calendar_schema(defaults: dict[str, Any] | None = None) -> vol.Schema:
    """Build the optional work-calendar form."""
    defaults = defaults or {}
    return vol.Schema({
        vol.Required(
            CONF_WORK_CALENDAR,
            default=defaults.get(CONF_WORK_CALENDAR) or "",
        ): selector.EntitySelector(selector.EntitySelectorConfig(domain="calendar"))
    })


def _configuration(entry) -> dict[str, Any]:
    """Return one entry's effective configuration."""
    return {**entry.data, **entry.options}


def _normalize_base(values: dict[str, Any]) -> dict[str, Any]:
    """Normalize the required fields and legacy options."""
    legacy_minutes = values.pop(CONF_THRESHOLD_MINUTES, None)
    if CONF_THRESHOLD_HOURS not in values:
        values[CONF_THRESHOLD_HOURS] = (
            float(legacy_minutes) / 60
            if legacy_minutes is not None
            else DEFAULT_THRESHOLD_HOURS
        )
    values[CONF_THRESHOLD_HOURS] = max(
        0.5, min(24.0, round(float(values[CONF_THRESHOLD_HOURS]) * 2) / 2)
    )
    values[CONF_HOME_OFFICE_ENABLED] = bool(values.get(CONF_HOME_OFFICE_ENABLED, False))
    values[CONF_OFFICE_ZONE] = values.get(CONF_OFFICE_ZONE) or None
    values[CONF_WORK_CALENDAR_ENABLED] = bool(
        values.get(CONF_WORK_CALENDAR_ENABLED, bool(values.get(CONF_WORK_CALENDAR)))
    )
    # Legacy installations may still contain the old explicit user mapping.
    values[CONF_HA_USER_ID] = None
    for key in (CONF_DEVICE_TRACKER, CONF_HOME_ZONE, CONF_WORK_SIGNAL, CONF_WORK_CALENDAR):
        values[key] = values.get(key) or None
    if not values[CONF_HOME_OFFICE_ENABLED]:
        values[CONF_HOME_ZONE] = None
        values[CONF_DEVICE_TRACKER] = None
        values[CONF_WORK_SIGNAL] = None
    if not values[CONF_WORK_CALENDAR_ENABLED]:
        values[CONF_WORK_CALENDAR] = None
    values[CONF_SHOW_HOLIDAYS] = bool(values.get(CONF_SHOW_HOLIDAYS))
    values[CONF_HOLIDAY_COUNTRY] = (values.get(CONF_HOLIDAY_COUNTRY) or "").strip().upper()
    country = values[CONF_HOLIDAY_COUNTRY]
    subdivision = (values.get(CONF_HOLIDAY_SUBDIVISION) or "").strip()
    if country and subdivision.upper().startswith(country + "-"):
        subdivision = subdivision[len(country) + 1:]
    if subdivision:
        subdivision = next(
            (
                code for code in supported_countries().get(country, [])
                if code.casefold() == subdivision.casefold()
            ),
            subdivision,
        )
    values[CONF_HOLIDAY_SUBDIVISION] = subdivision
    return values


def _base_errors(values: dict[str, Any]) -> dict[str, str]:
    """Require the work zone before offering optional setup."""
    return {} if values.get(CONF_OFFICE_ZONE) else {CONF_OFFICE_ZONE: "office_zone_required"}


def _homeoffice_errors(values: dict[str, Any]) -> dict[str, str]:
    """Require a usable Homeoffice source."""
    if not values.get(CONF_HOME_ZONE):
        return {CONF_HOME_ZONE: "home_zone_required"}
    if not (values.get(CONF_DEVICE_TRACKER) or values.get(CONF_WORK_SIGNAL)):
        return {CONF_DEVICE_TRACKER: "homeoffice_device_required"}
    return {}


def _feature_errors(values: dict[str, Any]) -> dict[str, str]:
    """Validate optional features only when enabled."""
    if values.get(CONF_HOME_OFFICE_ENABLED):
        errors = _homeoffice_errors(values)
        if errors:
            return errors
    if values.get(CONF_WORK_CALENDAR_ENABLED) and not values.get(CONF_WORK_CALENDAR):
        return {CONF_WORK_CALENDAR: "work_calendar_required"}
    if values[CONF_SHOW_HOLIDAYS]:
        subdivisions = supported_countries().get(values[CONF_HOLIDAY_COUNTRY])
        if subdivisions is None:
            return {CONF_HOLIDAY_COUNTRY: "holiday_country_required"}
        subdivision = values[CONF_HOLIDAY_SUBDIVISION]
        if subdivision and subdivision not in subdivisions:
            return {CONF_HOLIDAY_SUBDIVISION: "holiday_subdivision_invalid"}
    return {}


def _find_conflicts(hass, values: dict[str, Any], *, exclude_entry_id: str | None = None) -> set[str]:
    """Prevent ambiguous person and tracker assignments."""
    configurations = [
        {"entry_id": entry.entry_id, "values": _configuration(entry)}
        for entry in hass.config_entries.async_entries(DOMAIN)
    ]
    return find_person_configuration_conflicts(
        values, configurations, exclude_entry_id=exclude_entry_id
    )


class WorklogConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Set up one independently tracked person."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        """Collect all setup settings on one page."""
        await self.hass.async_add_executor_job(supported_countries)
        errors: dict[str, str] = {}
        if user_input is not None:
            user_input = _flatten_setup(user_input)
            values = _normalize_base(dict(user_input))
            errors = _base_errors(values) or _feature_errors(values)
            if not errors:
                self._person_entity = values[CONF_PERSON]
                await self.async_set_unique_id(self._person_entity)
                self._abort_if_unique_id_configured()
                errors = {key: key for key in _find_conflicts(self.hass, values)}
            if not errors:
                self._draft_config = values
                return await self.async_step_finish()
        return self.async_show_form(
            step_id="user",
            description_placeholders=_SETUP_LINKS,
            data_schema=_setup_schema(user_input),
            errors=_setup_errors(errors),
        )

    async def async_step_features(self, user_input: dict[str, Any] | None = None):
        """Offer optional features explicitly instead of implying inline fields."""
        options = ["basics", "homeoffice", "work_calendar"]
        if self._draft_config.get(CONF_HOME_OFFICE_ENABLED):
            options.append("disable_homeoffice")
        if self._draft_config.get(CONF_WORK_CALENDAR_ENABLED):
            options.append("disable_work_calendar")
        options.append("finish")
        return self.async_show_menu(step_id="features", menu_options=options)

    async def async_step_basics(self, user_input: dict[str, Any] | None = None):
        """Return to and update the required setup details."""
        errors: dict[str, str] = {}
        if user_input is not None:
            values = _normalize_base({**self._draft_config, **user_input})
            errors = _base_errors(values)
            if not errors:
                person_entity = values[CONF_PERSON]
                errors = {key: key for key in _find_conflicts(self.hass, values)}
                if not errors:
                    await self.async_set_unique_id(person_entity)
                    self._person_entity = person_entity
                    self._draft_config.update(values)
                    return await self.async_step_features()
        return self.async_show_form(
            step_id="basics",
            data_schema=_base_schema({**self._draft_config, **(user_input or {})}),
            errors=errors,
        )

    async def async_step_homeoffice(self, user_input: dict[str, Any] | None = None):
        """Configure Homeoffice only after the user selects that feature."""
        errors: dict[str, str] = {}
        if user_input is not None:
            values = {**self._draft_config, **{k: v or None for k, v in user_input.items()}}
            errors = _homeoffice_errors(values)
            if not errors:
                self._draft_config.update({
                    CONF_HOME_OFFICE_ENABLED: True,
                    CONF_HOME_ZONE: values.get(CONF_HOME_ZONE),
                    CONF_DEVICE_TRACKER: values.get(CONF_DEVICE_TRACKER),
                    CONF_WORK_SIGNAL: values.get(CONF_WORK_SIGNAL),
                })
                errors = {key: key for key in _find_conflicts(self.hass, self._draft_config)}
            if not errors:
                return await self.async_step_features()
        return self.async_show_form(
            step_id="homeoffice",
            data_schema=_homeoffice_schema(user_input),
            errors=errors,
        )

    async def async_step_work_calendar(self, user_input: dict[str, Any] | None = None):
        """Configure a work calendar only after the user selects that feature."""
        errors: dict[str, str] = {}
        if user_input is not None:
            calendar_entity = user_input.get(CONF_WORK_CALENDAR) or None
            if not calendar_entity:
                errors[CONF_WORK_CALENDAR] = "work_calendar_required"
            else:
                self._draft_config[CONF_WORK_CALENDAR_ENABLED] = True
                self._draft_config[CONF_WORK_CALENDAR] = calendar_entity
                return await self.async_step_features()
        return self.async_show_form(
            step_id="work_calendar",
            data_schema=_work_calendar_schema(user_input),
            errors=errors,
        )

    async def async_step_disable_homeoffice(self, user_input: dict[str, Any] | None = None):
        """Remove Homeoffice sources from the initial setup."""
        self._draft_config.update({
            CONF_HOME_OFFICE_ENABLED: False,
            CONF_HOME_ZONE: None,
            CONF_DEVICE_TRACKER: None,
            CONF_WORK_SIGNAL: None,
        })
        return await self.async_step_features()

    async def async_step_disable_work_calendar(self, user_input: dict[str, Any] | None = None):
        """Remove the work calendar from the initial setup."""
        self._draft_config[CONF_WORK_CALENDAR_ENABLED] = False
        self._draft_config[CONF_WORK_CALENDAR] = None
        return await self.async_step_features()

    async def async_step_finish(self, user_input: dict[str, Any] | None = None):
        """Finish setup with the selected optional features."""
        self._draft_config.setdefault(CONF_HOME_OFFICE_ENABLED, False)
        self._draft_config.setdefault(CONF_WORK_CALENDAR_ENABLED, False)
        self._draft_config.setdefault(CONF_HOME_ZONE, None)
        self._draft_config.setdefault(CONF_DEVICE_TRACKER, None)
        self._draft_config.setdefault(CONF_WORK_SIGNAL, None)
        self._draft_config.setdefault(CONF_WORK_CALENDAR, None)
        state = self.hass.states.get(self._person_entity)
        title = (
            state.attributes.get("friendly_name", self._person_entity)
            if state else self._person_entity
        )
        return self.async_create_entry(
            title=f"Steuertage – {title}", data=self._draft_config
        )

    @staticmethod
    def async_get_options_flow(config_entry):
        """Return the options flow."""
        return WorklogOptionsFlow()


class WorklogOptionsFlow(config_entries.OptionsFlow):
    """Update required settings and manage optional feature steps."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None):
        """Update all settings on one page."""
        await self.hass.async_add_executor_job(supported_countries)
        current = _configuration(self.config_entry)
        if user_input is not None:
            user_input = _flatten_setup(user_input)
            values_for_form = {
                **current,
                **user_input,
                CONF_HOLIDAY_SUBDIVISION: user_input.get(CONF_HOLIDAY_SUBDIVISION, ""),
            }
            values = _normalize_base(dict(values_for_form))
            errors = _base_errors(values) or _feature_errors(values)
            if not errors:
                errors = {key: key for key in _find_conflicts(
                    self.hass, values,
                    exclude_entry_id=self.config_entry.entry_id
                )}
            if not errors:
                values.pop(CONF_PERSON, None)
                return self.async_create_entry(title="", data=values)
            return self.async_show_form(
                step_id="init",
                description_placeholders=_SETUP_LINKS,
                data_schema=_setup_schema(values_for_form, include_person=False),
                errors=_setup_errors(errors),
            )
        return self.async_show_form(
            step_id="init",
            description_placeholders=_SETUP_LINKS,
            data_schema=_setup_schema(current, include_person=False),
        )

    async def async_step_manage(self, user_input: dict[str, Any] | None = None):
        """Show optional features and explicit disable actions."""
        options = ["homeoffice", "work_calendar"]
        if self._draft_config.get(CONF_HOME_OFFICE_ENABLED):
            options.append("disable_homeoffice")
        if self._draft_config.get(CONF_WORK_CALENDAR_ENABLED):
            options.append("disable_work_calendar")
        options.append("finish")
        return self.async_show_menu(step_id="manage", menu_options=options)

    async def async_step_homeoffice(self, user_input: dict[str, Any] | None = None):
        """Configure or enable Homeoffice detection."""
        current = _configuration(self.config_entry)
        include_legacy = bool(current.get(CONF_WORK_SIGNAL))
        errors: dict[str, str] = {}
        if user_input is not None:
            values = {**self._draft_config, **{k: v or None for k, v in user_input.items()}}
            errors = _homeoffice_errors(values)
            if not errors:
                self._draft_config.update({
                    CONF_HOME_OFFICE_ENABLED: True,
                    CONF_HOME_ZONE: values.get(CONF_HOME_ZONE),
                    CONF_DEVICE_TRACKER: values.get(CONF_DEVICE_TRACKER),
                    CONF_WORK_SIGNAL: values.get(CONF_WORK_SIGNAL),
                })
                errors = {key: key for key in _find_conflicts(
                    self.hass, self._draft_config,
                    exclude_entry_id=self.config_entry.entry_id
                )}
            if not errors:
                return await self.async_step_manage()
        return self.async_show_form(
            step_id="homeoffice",
            data_schema=_homeoffice_schema(
                {**self._draft_config, **(user_input or {})},
                include_legacy_signal=include_legacy,
            ),
            errors=errors,
        )

    async def async_step_work_calendar(self, user_input: dict[str, Any] | None = None):
        """Configure or enable the work calendar."""
        errors: dict[str, str] = {}
        if user_input is not None:
            calendar_entity = user_input.get(CONF_WORK_CALENDAR) or None
            if not calendar_entity:
                errors[CONF_WORK_CALENDAR] = "work_calendar_required"
            else:
                self._draft_config[CONF_WORK_CALENDAR_ENABLED] = True
                self._draft_config[CONF_WORK_CALENDAR] = calendar_entity
                return await self.async_step_manage()
        return self.async_show_form(
            step_id="work_calendar",
            data_schema=_work_calendar_schema(
                {**self._draft_config, **(user_input or {})}
            ),
            errors=errors,
        )

    async def async_step_disable_homeoffice(self, user_input: dict[str, Any] | None = None):
        """Disable Homeoffice and clear its sources."""
        self._draft_config.update({
            CONF_HOME_OFFICE_ENABLED: False,
            CONF_HOME_ZONE: None,
            CONF_DEVICE_TRACKER: None,
            CONF_WORK_SIGNAL: None,
        })
        return await self.async_step_manage()

    async def async_step_disable_work_calendar(self, user_input: dict[str, Any] | None = None):
        """Disable the work calendar and clear its selection."""
        self._draft_config[CONF_WORK_CALENDAR_ENABLED] = False
        self._draft_config[CONF_WORK_CALENDAR] = None
        return await self.async_step_manage()

    async def async_step_finish(self, user_input: dict[str, Any] | None = None):
        """Save all option changes."""
        errors = {key: key for key in _find_conflicts(
            self.hass, self._draft_config,
            exclude_entry_id=self.config_entry.entry_id
        )}
        if errors:
            return self.async_show_form(
                step_id="init",
                description_placeholders=_SETUP_LINKS,
                data_schema=_base_schema(self._draft_config, include_person=False),
                errors=errors,
            )
        values = dict(self._draft_config)
        values.pop(CONF_PERSON, None)
        return self.async_create_entry(title="", data=values)
