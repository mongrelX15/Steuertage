"""Constants for Steuertage."""
from typing import Final

DOMAIN: Final = "steuertage"
CONF_PERSON: Final = "person_entity"
CONF_WORK_SIGNAL: Final = "work_signal"  # Legacy Beta 7 binary sensor.
CONF_HOME_ZONE: Final = "home_zone"
CONF_DEVICE_TRACKER: Final = "homeoffice_device"
CONF_HA_USER_ID: Final = "ha_user_id"
CONF_OFFICE_ZONE: Final = "office_zone"
CONF_HOME_OFFICE_ENABLED: Final = "homeoffice_enabled"
CONF_WORK_CALENDAR: Final = "work_calendar"
CONF_WORK_CALENDAR_ENABLED: Final = "work_calendar_enabled"
CONF_THRESHOLD_HOURS: Final = "threshold_hours"
DEFAULT_THRESHOLD_HOURS: Final = 2.0
# Legacy storage key retained for automatic migration from minute-based settings.
CONF_THRESHOLD_MINUTES: Final = "threshold_minutes"
DEFAULT_THRESHOLD_MINUTES: Final = 120
# Kept so older entries can still be read safely.
CONF_MINIMUM_HOURS: Final = "minimum_hours"
BETA_THRESHOLD_SECONDS: Final = 30 * 60
DEFAULT_MINIMUM_HOURS: Final = 2.0
