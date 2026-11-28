"""Regression checks for the local backup files and shared restore path."""
import asyncio
import ast
import copy
from datetime import datetime, timedelta, timezone
from importlib import import_module
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace

import pytest

BASE = Path(__file__).parents[1] / "custom_components" / "steuertage"
NOW = datetime(2026, 11, 27, 8, tzinfo=timezone.utc)


@pytest.fixture
def modules(monkeypatch):
    def stub(name, **attributes):
        module = ModuleType(name)
        module.__dict__.update(attributes)
        monkeypatch.setitem(sys.modules, name, module)
        return module

    def parse(value):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None

    stub("steuertage_backup_tests", __path__=[str(BASE)])
    stub("homeassistant")
    stub("homeassistant.config_entries", ConfigEntry=object)
    stub("homeassistant.core", HomeAssistant=object)
    stub("homeassistant.helpers", entity_registry=None)
    stub("homeassistant.helpers.storage", Store=object)

    class UpdateCoordinator:
        @classmethod
        def __class_getitem__(cls, _item):
            return cls

    stub("homeassistant.helpers.update_coordinator", DataUpdateCoordinator=UpdateCoordinator)
    clock = SimpleNamespace(now=lambda: NOW, utcnow=lambda: NOW, parse_datetime=parse)
    stub("homeassistant.util", dt=clock)
    backups = import_module("steuertage_backup_tests.backups")
    coordinator = import_module("steuertage_backup_tests.coordinator")
    yield backups, coordinator, clock
    for name in ("backups", "coordinator", "logic", "const"):
        sys.modules.pop(f"steuertage_backup_tests.{name}", None)


class TestStore:
    __test__ = False

    def __init__(self):
        self.data = None
        self.fail = False

    async def async_save(self, data):
        if self.fail:
            self.fail = False
            raise OSError("simulierter Schreibfehler")
        self.data = copy.deepcopy(data)


def make_person(module, suffix):
    person = object.__new__(module.WorklogCoordinator)
    person._history_lock = asyncio.Lock()
    person.entry_id = suffix
    person.person_entity = "person." + suffix
    person.person_name = suffix
    person._date = "2026-11-27"
    person._office_seconds = 0
    person._homeoffice_seconds = 0
    person._location = None
    person._office_site_ids = set()
    person._configured_sites = set()
    person._office_sites = [{"id": "site_2", "number": 2, "name": "Bonn"}]
    person._next_site_number = 4
    person._site_deletions = [{"id": "site_3", "number": 3, "name": "Alt", "days": 0, "timestamp": NOW.isoformat()}]
    person.data = {"day_type": "no_work", "automatic_day_type": "no_work", "manual_override": None,
                   "mixed_day": False, "office_site_ids": []}
    person._snapshot = lambda: person.data
    person._history = {"2025-02-01": person._normalize_record({
        "day_type": "office", "office_seconds": 3600, "office_site_ids": ["site_2"],
        "change_history": [{"changed_by": "test"}], "updated_at": NOW.isoformat(),
    })}
    person.store = TestStore()
    person.async_set_updated_data = lambda snapshot: None
    return person


def test_weekly_schedule_restart_rotation_and_failed_write(tmp_path, modules, monkeypatch, caplog):
    backups, coordinator, clock = modules

    async def run():
        current = NOW
        clock.utcnow = lambda: current

        async def executor(job, *args):
            return job(*args)

        persons = [make_person(coordinator, key) for key in ("a", "b")]
        hass = SimpleNamespace(
            config=SimpleNamespace(path=lambda *parts: str(tmp_path.joinpath(*parts))),
            data={backups.DOMAIN: {person.entry_id: person for person in persons}},
            async_add_executor_job=executor,
        )
        service = backups.AutomaticBackups(hass)
        await service.async_run()
        first = (await service.async_list())[0]
        assert first["created_at"] == NOW.isoformat()
        saved = await service.async_read(first["filename"])
        assert saved == await backups.async_full_backup(persons, NOW)
        assert [person["person_entity"] for person in saved["people"]] == ["person.a", "person.b"]
        person_data = saved["people"][0]
        assert person_data["records"]["2025-02-01"]["office_site_ids"] == ["site_2"]
        assert person_data["office_sites"][0]["number"] == 2
        assert person_data["next_site_number"] == 4
        assert person_data["site_deletions"][0]["id"] == "site_3"
        custom = service.directory / "eigene-sicherung.json"
        custom.write_text("{}")
        service = backups.AutomaticBackups(hass)
        current = NOW + timedelta(days=3)
        await service.async_run()
        assert await service.async_list() == [first]
        for week in range(1, 4):
            current = NOW + timedelta(weeks=week)
            await service.async_run()
        original = await service.async_list()
        assert len(original) == 4 and original[-1] == first

        def fail(*_args):
            raise OSError("simulierter Schreibfehler")

        with monkeypatch.context() as patch:
            patch.setattr(backups.os, "replace", fail)
            current = NOW + timedelta(weeks=5)
            await service.async_run()
            assert await service.async_list() == original
            assert len(list(service.directory.iterdir())) == 5
        assert "konnte nicht erstellt werden" in caplog.text

        service = backups.AutomaticBackups(hass)
        await service.async_run()
        final = await service.async_list()
        assert final[0]["created_at"] == current.isoformat()
        assert first not in final
        assert custom.exists()

        target = service.directory / final[0]["filename"]
        with pytest.raises(ValueError):
            await service.async_read("../" + target.name)
        target.write_text("{")
        with pytest.raises(ValueError):
            await service.async_read(target.name)
        target.unlink()
        target.symlink_to(custom)
        with pytest.raises(FileNotFoundError):
            await service.async_read(target.name)

    asyncio.run(run())


def test_round_trip_legacy_and_rollback(modules):
    backups, coordinator, _ = modules

    async def run():
        a, b = (make_person(coordinator, key) for key in ("a", "b"))
        document = await backups.async_full_backup([a, b], NOW)
        versions = backups.backup_people(document)
        b._history = {}
        b._office_sites = []
        b._site_deletions = []
        await backups.async_restore_histories([(b, versions[1])], "replace")
        assert b._history["2025-02-01"]["change_history"] == [{"changed_by": "test"}]
        assert b._office_sites[0]["id"] == "site_2"
        assert b._site_deletions == versions[1]["site_deletions"]
        legacy = {"format": "steuertage_backup", "version": 1, "person_entity": a.person_entity,
                  "records": {"2024-01-01": {"day_type": "office", "seconds": 3600}}}
        await backups.async_restore_histories([(a, backups.backup_people(legacy)[0])], "replace")
        assert a._history["2024-01-01"]["office_seconds"] == 3600
        with pytest.raises(ValueError):
            backups.backup_people({**legacy, "version": 99})
        originals = [copy.deepcopy(person._storage_data()) for person in (a, b)]
        corrupted = {**versions[1], "records": {"2026-01-01": {"office_site_ids": False}}}
        with pytest.raises(ValueError):
            await backups.async_restore_histories([(a, versions[0]), (b, corrupted)], "replace")
        assert [person._storage_data() for person in (a, b)] == originals
        changed = {"records": {"2024-01-01": {"day_type": "vacation"}}}
        b.store.fail = True
        with pytest.raises(OSError):
            await backups.async_restore_histories([(a, changed), (b, changed)], "replace")
        assert [person._storage_data() for person in (a, b)] == originals
        assert [person.store.data for person in (a, b)] == originals

    asyncio.run(run())


def test_backup_commands_require_admin():
    syntax = ast.parse((BASE / "__init__.py").read_text())
    protected = {"export_history", "restore_history", "automatic_backups", "restore_backup"}
    for node in ast.walk(syntax):
        if isinstance(node, ast.AsyncFunctionDef) and node.name in protected:
            assert any(ast.unparse(decorator) == "websocket_api.require_admin" for decorator in node.decorator_list)
            protected.remove(node.name)
    assert not protected
