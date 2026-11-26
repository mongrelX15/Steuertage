"""Resolve public holidays without a network service."""
from functools import lru_cache

import holidays


@lru_cache(maxsize=1)
def supported_countries() -> dict[str, list[str]]:
    """Return supported country and subdivision codes."""
    return holidays.list_supported_countries(include_aliases=False)


@lru_cache(maxsize=128)
def _holidays_for_year(country: str, subdivision: str, year: int) -> dict[str, str]:
    dates = holidays.country_holidays(
        country, subdiv=subdivision or None, years=year, language="de", categories=holidays.PUBLIC
    )
    return {day.isoformat(): name for day, name in dates.items()}


def calendar_holidays(country: str, subdivision: str, year: int) -> dict[str, str]:
    """Include adjacent years for days shown outside the selected month."""
    return {
        day: name
        for current_year in (year - 1, year, year + 1)
        for day, name in _holidays_for_year(country, subdivision, current_year).items()
    }
