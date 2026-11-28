import json
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).parents[1]
COMPONENT = ROOT / "custom_components" / "steuertage"


def test_homeoffice_descriptions_have_plain_text_in_every_language():
    files = [COMPONENT / "strings.json", *sorted((COMPONENT / "translations").glob("*.json"))]
    assert len(files) >= 3
    for path in files:
        data = json.loads(path.read_text(encoding="utf-8"))
        descriptions = []

        def walk(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if key == "description" and isinstance(item, str) and (
                        "FRITZ!Box Tools" in item or "UniFi Network" in item
                    ):
                        descriptions.append(item)
                    walk(item)
            elif isinstance(value, list):
                for item in value:
                    walk(item)

        walk(data)
        assert descriptions, path
        for description in descriptions:
            assert "FRITZ!Box Tools" in description and "UniFi Network" in description, path
            assert "device_tracker" in description, path
            assert not re.search(r"https?://|\[[^]]+\]\([^)]*\)|\x60|\{(?:fritz|unifi)_url\}", description), path


def test_mobile_and_desktop_multi_select_states():
    panel = COMPONENT / "www" / "steuertage_panel.js"
    script = r"""
const fs = require("fs");
const vm = require("vm");
const assert = require("assert/strict");
const source = fs.readFileSync(process.argv[1], "utf8");
const Panel = vm.runInNewContext(source + "\nSteuertagePanel;", {
  HTMLElement: class {}, customElements: { define() {} }, Set,
}, { filename: process.argv[1] });
const panel = Object.create(Panel.prototype);
const elements = {
  "[data-action='multi-select']": { setAttribute(k, v) { this[k] = v; } },
  "[data-action='mobile-multi-select']": { setAttribute(k, v) { this[k] = v; } },
};
panel.shadowRoot = {
  querySelector(selector) { return elements[selector] || null; },
  querySelectorAll() { return []; },
};
for (const active of [false, true]) {
  panel._multiSelectMode = active;
  for (const count of [0, 1, 2, 3]) {
    panel._updateVisibleDateSelection(new Set(Array.from({ length: count }, (_, i) => String(i))));
    assert.equal(elements["[data-action='multi-select']"].textContent,
      active ? "Mehrfachauswahl beenden" : "Mehrfachauswahl aktivieren");
    assert.equal(elements["[data-action='mobile-multi-select']"].textContent,
      !active ? "Mehrfachauswahl" : count >= 2 ? "Mehrfachauswahl aufheben" : "Mehrfachauswahl aktiv");
    assert.equal(elements["[data-action='multi-select']"]["aria-pressed"], String(active));
    assert.equal(elements["[data-action='mobile-multi-select']"]["aria-pressed"], String(active));
  }
}
panel._multiSelectMode = true;
panel._updateVisibleDateSelection(new Set(["1", "2"]));
panel._updateVisibleDateSelection(new Set(["1"]));
assert.equal(elements["[data-action='mobile-multi-select']"].textContent, "Mehrfachauswahl aktiv");
assert.match(source, /this\._desktopMultiSelectLabel\(\) \+ "<\/button>"/);
assert.match(source, /this\._mobileMultiSelectLabel\(selectedDateCount\) \+ "<\/button>"/);
"""
    subprocess.run(["node", "-e", script, str(panel)], check=True)
