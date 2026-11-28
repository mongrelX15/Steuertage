"""Weekly local backups and shared restore transactions."""
from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack
from datetime import datetime, timedelta, timezone
import json
import logging
import os
from pathlib import Path
import re
from tempfile import NamedTemporaryFile

from homeassistant.util import dt as dt_util

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)
INTERVAL = timedelta(days=7)
RETENTION = timedelta(weeks=4)
_TIMESTAMP = "%Y%m%dT%H%M%SZ"
_FILENAME = re.compile(r"steuertage-auto-(\d{8}T\d{6}Z)\.json")


def _file_time(name: str) -> datetime:
    match = _FILENAME.fullmatch(name)
    if match is None:
        raise ValueError("Ungültiger Name für eine automatische Sicherung.")
    return datetime.strptime(match[1], _TIMESTAMP).replace(tzinfo=timezone.utc)


def _list_files(directory: Path) -> list[tuple[datetime, Path]]:
    backups = []
    try:
        for path in directory.iterdir():
            try:
                created_at = _file_time(path.name)
            except ValueError:
                continue
            if not path.is_symlink() and path.is_file():
                backups.append((created_at, path))
    except FileNotFoundError:
        return []
    return sorted(backups, reverse=True)


def _write_backup(directory: Path, now: datetime, backup: dict) -> None:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = directory / f"steuertage-auto-{now.strftime(_TIMESTAMP)}.json"
    temp = None
    try:
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, delete=False) as stream:
            temp = Path(stream.name)
            json.dump(backup, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, target)
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)
    for created_at, path in _list_files(directory):
        if path != target and now - created_at >= RETENTION:
            try:
                path.unlink()
            except OSError:
                _LOGGER.exception("Alte automatische Steuertage-Sicherung konnte nicht gelöscht werden: %s", path.name)


def _read_backup(directory: Path, filename: str) -> dict:
    _file_time(filename)
    path = directory / filename
    if path.is_symlink() or not path.is_file():
        raise FileNotFoundError(filename)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), encoding="utf-8") as stream:
        return json.load(stream)


async def async_full_backup(coordinators, now: datetime) -> dict:
    """Build the version 2 backup from the existing per-person export."""
    people = []
    async with AsyncExitStack() as stack:
        for coordinator in sorted(coordinators, key=lambda item: item.entry_id):
            await stack.enter_async_context(coordinator._history_lock)
            person = coordinator.history_backup()
            people.append({key: value for key, value in person.items() if key not in {"format", "version"}})
    dates = [day for person in people for day in person["records"]]
    return {
        "format": "steuertage_backup", "version": 2, "created_at": now.isoformat(),
        "coverage": {"from": min(dates, default=None), "to": max(dates, default=None)},
        "people": people,
    }


def backup_people(backup: dict) -> list[dict]:
    """Validate uploaded and automatic backup envelopes, including legacy files."""
    if not isinstance(backup, dict) or backup.get("format") != "steuertage_backup":
        raise ValueError("Das ist keine gültige Steuertage-Sicherung.")
    if backup.get("version") == 1:
        people = [backup]
    elif backup.get("version") == 2 and isinstance(backup.get("people"), list):
        people = backup["people"]
    else:
        raise ValueError("Das Sicherungsformat wird nicht unterstützt.")
    seen = set()
    count = 0
    for person in people:
        if (not isinstance(person, dict) or not isinstance(person.get("person_entity"), str)
                or not person["person_entity"] or person["person_entity"] in seen
                or not isinstance(person.get("records"), dict)):
            raise ValueError("Die Sicherung enthält ungültige Personendaten.")
        seen.add(person["person_entity"])
        count += len(person["records"])
    if not people or len(people) > 100 or count > 100000:
        raise ValueError("Die Sicherung liegt außerhalb der unterstützten Größe.")
    return people


async def async_restore_histories(operations, strategy: str) -> dict[str, int]:
    """Stage all changes, persist them, and publish only after every write succeeds."""
    operations = sorted(operations, key=lambda item: item[0].entry_id)
    totals = dict.fromkeys(("imported", "replaced", "preserved_newer", "invalid"), 0)
    staged = []
    attempted = []
    async with AsyncExitStack() as stack:
        for coordinator, _ in operations:
            await stack.enter_async_context(coordinator._history_lock)
        for coordinator, person in operations:
            original = coordinator._restore_state()
            original_data = coordinator._storage_data()
            try:
                result = coordinator._stage_history_restore(
                    person["records"], strategy=strategy,
                    backup_created_at=person.get("created_at"),
                    office_sites=person.get("office_sites"),
                    next_site_number=person.get("next_site_number", 1),
                    site_deletions=person.get("site_deletions"),
                )
                staged.append((coordinator, coordinator._restore_state(), coordinator._storage_data(), original_data))
                for key in totals:
                    totals[key] += result[key]
            finally:
                coordinator._set_restore_state(original)
        try:
            for coordinator, _, data, original_data in staged:
                attempted.append((coordinator, original_data))
                await coordinator.store.async_save(data)
        except (Exception, asyncio.CancelledError):
            for coordinator, original_data in reversed(attempted):
                try:
                    await coordinator.store.async_save(original_data)
                except Exception:
                    _LOGGER.exception("Steuertage konnte gespeicherte Daten nach einem fehlgeschlagenen Import nicht zurückschreiben.")
            raise
        for coordinator, restored, _, _ in staged:
            coordinator._set_restore_state(restored)
        for coordinator, _, _, _ in staged:
            coordinator.async_set_updated_data(coordinator.data)
    return totals


class AutomaticBackups:
    """Resume the weekly schedule based on the newest completed local file."""

    def __init__(self, hass) -> None:
        self.hass = hass
        self.directory = Path(hass.config.path(".storage", "steuertage_backups"))
        self._lock = asyncio.Lock()
        self._last_backup: datetime | None = None

    async def async_run(self, _now=None) -> None:
        async with self._lock:
            coordinators = tuple(self.hass.data.get(DOMAIN, {}).values())
            if not coordinators:
                return
            now = dt_util.utcnow().replace(microsecond=0)
            try:
                if self._last_backup is None:
                    backups = await self.hass.async_add_executor_job(_list_files, self.directory)
                    if backups:
                        self._last_backup = backups[0][0]
                if self._last_backup is not None and now - self._last_backup < INTERVAL:
                    return
                backup = await async_full_backup(coordinators, now)
                await self.hass.async_add_executor_job(_write_backup, self.directory, now, backup)
                self._last_backup = now
            except (OSError, TypeError, ValueError, RecursionError):
                _LOGGER.exception("Automatische Steuertage-Sicherung konnte nicht erstellt werden.")

    async def async_list(self) -> list[dict]:
        items = await self.hass.async_add_executor_job(_list_files, self.directory)
        return [{"filename": path.name, "created_at": created.isoformat()} for created, path in items]

    async def async_read(self, filename: str) -> dict:
        backup = await self.hass.async_add_executor_job(_read_backup, self.directory, filename)
        backup_people(backup)
        return backup
