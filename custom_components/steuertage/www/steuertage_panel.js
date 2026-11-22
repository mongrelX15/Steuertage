class SteuertagePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "calendar";
    this._month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    this._selected = null;
      this._rangeAnchorDate = null;
    this._calendarEntityId = null;
    this._activeUserId = null;
    this._calendarInitialized = false;
    this._calendarSignature = "";
    this._hasReceivedHass = false;
    this._haThemeVariables = new Set();
    this._events = [];
    this._loadedMonth = "";
    this._busy = false;
    this._message = "";
    this._messageTimer = undefined;
    this._backupNotice = null;
    this._preparedBackup = null;
    this._pendingRestore = null;
    this._backupRestoring = false;
    this._dataManagementOpen = false;
    this._unsubscribe = undefined;
    this._exportEvents = null;
    this._exportKey = "";
    this._exportUnsubscribe = undefined;
    this._exportYear = new Date().getFullYear();
    this._exportFrom = this._exportYear + "-01-01";
    this._exportTo = this._exportYear + "-12-31";
    this._correctionFrom = "";
    this._correctionTo = "";
    this._selectedDates = new Set();
    this._rangeAnchorDate = null;
    this._multiSelectMode = false;
    this._selectionMode = "single";
    this._rangeWeekdaySettings = new Map();
    this._rangeSelectionBounds = null;
    this._editHistoryByPerson = new Map();
    this._openDisclosures = new Set();
  }

  set hass(hass) {
    this._hass = hass;
    this._applyHomeAssistantTheme();
    const activeUserId = hass?.user?.id || null;
    const userChanged = activeUserId !== this._activeUserId;
    this._activeUserId = activeUserId;
    const calendars = this._calendarEntities();
    const signature = calendars.map((item) => [
      item.entity_id,
      item.attributes.worklog_person_entity,
      item.attributes.worklog_person_name,
      item.attributes.worklog_user_id,
      item.attributes.worklog_homeoffice_enabled,
      item.attributes.worklog_home_zone_entity,
      item.attributes.worklog_device_tracker,
      item.attributes.worklog_legacy_signal,
      item.attributes.worklog_office_zone_entity,
      item.attributes.worklog_threshold_hours,
      item.attributes.worklog_work_calendar_entity,
    ].join(":")).join("|");
    const initial = !this._hasReceivedHass;
    const listChanged = signature !== this._calendarSignature;
    let selectionChanged = false;

    if (userChanged && this._hasReceivedHass) {
      const calendar = this._preferredCalendarEntity(calendars);
      this._calendarEntityId = calendar?.entity_id || null;
      this._calendarInitialized = true;
      this._loadedMonth = "";
      this._events = [];
      this._exportEvents = null;
      this._exportKey = "";
      this._selected = null;
      this._rangeAnchorDate = null;
      selectionChanged = true;
    } else if (!this._calendarInitialized && calendars.length) {
      const calendar = this._calendarEntity();
      this._calendarEntityId = calendar?.entity_id || null;
      this._calendarInitialized = true;
      this._loadedMonth = "";
      this._events = [];
      selectionChanged = true;
    } else if (
      this._calendarEntityId &&
      !calendars.some((item) => item.entity_id === this._calendarEntityId)
    ) {
      this._calendarEntityId = null;
      this._loadedMonth = "";
      this._events = [];
      selectionChanged = true;
    }

    this._calendarSignature = signature;
    this._hasReceivedHass = true;
    if (initial || listChanged || selectionChanged) {
      this._render();
    }
    if (this._tab === "calendar" && (initial || listChanged || selectionChanged)) {
      this._loadEvents();
    }
  }

  _applyHomeAssistantTheme() {
    const tokens = [
      "--primary-color", "--accent-color", "--lovelace-background", "--primary-background-color",
      "--secondary-background-color", "--card-background-color", "--ha-card-background",
      "--primary-text-color", "--secondary-text-color", "--text-primary-color",
      "--divider-color", "--state-icon-color", "--info-color", "--success-color",
      "--warning-color", "--error-color", "--ha-card-box-shadow", "--ha-card-border-radius",
      "--ha-card-border-width", "--paper-font-body1_-_font-family",
    ];
    const applied = new Map();
    // Read resolved values by name instead of relying on CSSStyleDeclaration
    // enumeration, which can omit inherited variables across HA shadow roots.
    for (
      let element = this.parentElement;
      element;
      element = element.parentElement || element.getRootNode?.().host || null
    ) {
      const computed = getComputedStyle(element);
      for (const name of tokens) {
        if (applied.has(name)) continue;
        const value = computed.getPropertyValue(name).trim();
        if (value) applied.set(name, value);
      }
    }
    const themes = this._hass?.themes || {};
    const selected = this._hass?.selectedTheme || {};
    const themeName = themes.theme || selected.theme;
    const isDark = typeof themes.darkMode === "boolean"
      ? themes.darkMode
      : (selected.dark ?? window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
    const themeDefinition = themes.themes?.[themeName] || {};
    const { modes, ...common } = themeDefinition;
    for (const [name, value] of Object.entries(common)) {
      if (typeof value === "string") applied.set("--" + name, value);
    }
    for (const [name, value] of Object.entries(modes?.[isDark ? "dark" : "light"] || {})) {
      if (typeof value === "string") applied.set("--" + name, value);
    }
    if (selected.primaryColor) applied.set("--primary-color", selected.primaryColor);
    if (selected.accentColor) applied.set("--accent-color", selected.accentColor);

    const fallback = isDark
      ? { page: "#111318", card: "#1d2027", text: "#f1f3f8", muted: "#aeb4c0", divider: "#373b45" }
      : { page: "#f5f6f8", card: "#ffffff", text: "#202124", muted: "#5f6368", divider: "#dadce0" };
    const value = (name, fallbackValue) => applied.get(name) || fallbackValue;
    applied.set("--steuertage-page-background", value("--lovelace-background", value("--primary-background-color", fallback.page)));
    applied.set("--steuertage-card-background", value("--ha-card-background", value("--card-background-color", fallback.card)));
    applied.set("--steuertage-text", value("--primary-text-color", fallback.text));
    applied.set("--steuertage-muted", value("--secondary-text-color", fallback.muted));
    applied.set("--steuertage-divider", value("--divider-color", fallback.divider));

    for (const name of this._haThemeVariables) {
      if (!applied.has(name)) this.style.removeProperty(name);
    }
    for (const [name, val] of applied) this.style.setProperty(name, val);
    this._haThemeVariables = new Set(applied.keys());
    this.style.colorScheme = isDark ? "dark" : "light";
  }
  set narrow(value) {
    this._narrow = value;
    this._render();
  }

  set panel(value) {
    this._panel = value;
    this._render();
  }

  _isoDate(date) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  }

  _calendarEntities() {
    return Object.values(this._hass?.states || {})
      .filter((item) => item.entity_id.startsWith("calendar.") &&
        item.attributes.worklog_person_entity)
      .sort((a, b) =>
        (a.attributes.worklog_person_name || a.entity_id).localeCompare(
          b.attributes.worklog_person_name || b.entity_id,
          this._hass?.locale?.language || "de-DE"
        )
      );
  }

  _preferredCalendarEntity(calendars = this._calendarEntities()) {
    return calendars.find((item) => item.attributes.worklog_user_id &&
      item.attributes.worklog_user_id === this._activeUserId) ||
      (calendars.length === 1 ? calendars[0] : undefined);
  }

  _calendarEntity() {
    const calendars = this._calendarEntities();
    return calendars.find((item) => item.entity_id === this._calendarEntityId) ||
      this._preferredCalendarEntity(calendars);
  }

  _homeOfficeEnabled(calendar = this._calendarEntity()) {
    const value = calendar?.attributes?.worklog_homeoffice_enabled;
    return value !== false && value !== "false";
  }

  _calendarLabel(calendar) {
    return calendar.attributes.worklog_person_name ||
      calendar.attributes.friendly_name ||
      calendar.entity_id;
  }

  async _loadEvents() {
    const calendar = this._calendarEntity();
    const entityId = calendar?.entity_id;
    const monthKey = entityId + ":" + this._isoDate(this._month);
    if (!entityId) {
      if (this._unsubscribe) {
        const unsubscribe = this._unsubscribe;
        this._unsubscribe = undefined;
        await unsubscribe();
      }
      this._loadedMonth = "";
      this._events = [];
      this._render();
      return;
    }
    if (this._loadedMonth === monthKey || !this._hass?.connection) return;
    this._loadedMonth = monthKey;
    if (this._unsubscribe) {
      const unsubscribe = this._unsubscribe;
      this._unsubscribe = undefined;
      await unsubscribe();
    }
    this._events = [];
    this._render();
    const start = new Date(this._month.getFullYear(), this._month.getMonth(), 1);
    const mondayOffset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - mondayOffset);
    const end = new Date(start);
    end.setDate(end.getDate() + 42);
    try {
      this._unsubscribe = await this._hass.connection.subscribeMessage(
        (message) => {
          if (this._calendarEntityId !== entityId) return;
          this._events = Array.isArray(message?.events)
            ? message.events
            : Array.isArray(message?.event?.events)
              ? message.event.events
              : [];
          this._render();
        },
        {
          type: "calendar/event/subscribe",
          entity_id: entityId,
          start: start.toISOString(),
          end: end.toISOString(),
        }
      );
    } catch (error) {
      this._loadedMonth = "";
      this._message = "Der Kalender konnte nicht geladen werden.";
      this._render();
    }
  }

  _type(event) {
    const summary = (event?.summary || "").toLowerCase();
    if (summary.includes("büro- und") || summary.includes("arbeitsstätte + homeoffice") || summary.includes("arbeit vor ort + homeoffice")) {
      const primary = (event?.description || "").match(/STEUERTAGE_PRIMARY:(office|home_office)/);
      return primary?.[1] || "office";
    }
    if (summary.includes("homeoffice")) return "home_office";
    if (summary.includes("bürotag") || summary.includes("arbeitsstätte") || summary.includes("arbeit vor ort")) return "office";
    if (summary.includes("urlaub")) return "vacation";
    if (summary.includes("krankheit")) return "sick_leave";
    if (summary.includes("prüfen")) return "needs_review";
    if (summary.includes("erkennung läuft")) return "tracking";
    if (summary.includes("arbeitstag")) return "no_work";
    return "";
  }

  _isMixedEvent(event) {
    return Boolean(event) && (
      (event.description || "").includes("STEUERTAGE_MIXED:true") ||
      /büro- und|arbeit vor ort \+ homeoffice/i.test(event.summary || "")
    );
  }

  _formatDate(value, options = { dateStyle: "medium" }) {
    if (!value) return "";
    const date = new Date(value.slice(0, 10) + "T12:00:00");
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(this._hass?.locale?.language || "de-DE", options).format(date);
  }

  _label(type) {
    return ({
      no_work: "Kein Arbeitstag",
      tracking: "Erkennung läuft",
      home_office: "Homeoffice-Tag",
      office: "Arbeitsstätte",
      office_and_home_office: "Arbeitsstätte + Homeoffice",
      needs_review: "Bitte prüfen",
      vacation: "Urlaub",
      sick_leave: "Krankheit",
    })[type] || "Noch kein Eintrag";
  }

  _eventForDay(day) {
    if (!day) return undefined;
    return this._events.find((event) => (event.start || "").slice(0, 10) === day);
  }

  _changeHistory(event) {
    const marker = "STEUERTAGE_HISTORY:";
    const description = event?.description || "";
    const index = description.indexOf(marker);
    if (index < 0) return [];
    try {
      const history = JSON.parse(description.slice(index + marker.length));
      return Array.isArray(history) ? history : [];
    } catch (error) {
      return [];
    }
  }

  _editHistoryForCurrentPerson() {
    const person = this._calendarEntity()?.attributes?.worklog_person_entity || "unbekannt";
    if (!this._editHistoryByPerson.has(person)) {
      this._editHistoryByPerson.set(person, { undo: [], redo: [] });
    }
    return this._editHistoryByPerson.get(person);
  }

  _manualOverrideForDate(date) {
    const event = this._eventForDay(date);
    const description = event?.description || "";
    if (!description.includes("Manuell geändert")) return "automatic";
    const latest = this._changeHistory(event).at(-1);
    const knownTypes = new Set([
      "no_work", "tracking", "home_office", "office", "office_and_home_office",
      "needs_review", "vacation", "sick_leave",
    ]);
    if (knownTypes.has(latest?.new_value)) return latest.new_value;
    if (/Manuell geändert zu: Arbeitsstätte \+ Homeoffice/i.test(description)) {
      return "office_and_home_office";
    }
    return this._type(event) || "automatic";
  }

  async _applyEditHistory(direction) {
    if (this._busy) return;
    const calendar = this._calendarEntity();
    const personEntity = calendar?.attributes?.worklog_person_entity;
    const history = this._editHistoryForCurrentPerson();
    const source = direction === "undo" ? history.undo : history.redo;
    const target = direction === "undo" ? history.redo : history.undo;
    const operation = source.at(-1);
    if (!personEntity || !operation) return;

    this._busy = true;
    this._message = direction === "undo" ? "Mache Änderung rückgängig …" : "Wiederhole Änderung …";
    this._render();
    try {
      for (const day of operation.days) {
        await this._hass.callService("steuertage", "set_day_override", {
          person_entity: personEntity,
          date: day.date,
          day_type: direction === "undo" ? day.before : day.after,
        });
      }
      source.pop();
      target.push(operation);
      this._loadedMonth = "";
      await this._loadEvents();
      this._showMessage(direction === "undo" ? "Änderung rückgängig gemacht." : "Änderung wiederhergestellt.");
    } catch (error) {
      this._loadedMonth = "";
      await this._loadEvents();
      this._showMessage("Die Aktion konnte nicht vollständig ausgeführt werden. Du kannst es erneut versuchen.");
    } finally {
      this._busy = false;
      this._render();
    }
  }

  _monthStats() {
    const prefix = this._isoDate(this._month).slice(0, 7);
    const days = new Map();
    this._events.forEach((event) => {
      const date = (event.start || "").slice(0, 10);
      if (!date.startsWith(prefix)) return;
      const type = this._type(event);
      if (!type) return;
      if (!days.has(date)) days.set(date, new Set());
      days.get(date).add(type);
      if (this._isMixedEvent(event)) days.get(date).add("mixed_day");
    });
    const entries = [...days.values()];
    const workTypes = new Set(["office", "home_office"]);
    return {
      workdays: entries.filter((types) => [...types].some((type) => workTypes.has(type))).length,
      office: entries.filter((types) => types.has("office")).length,
      homeOffice: entries.filter((types) => types.has("home_office")).length,
      mixed: entries.filter((types) => types.has("mixed_day")).length,
      vacation: entries.filter((types) => types.has("vacation")).length,
      sick: entries.filter((types) => types.has("sick_leave")).length,
    };
  }

  _rangeWeekdays() {
    const key = this._calendarEntityId || "default";
    if (this._rangeWeekdaySettings.has(key)) return this._rangeWeekdaySettings.get(key);
    let days = new Set([0, 1, 2, 3, 4, 5, 6]);
    try {
      const stored = JSON.parse(localStorage.getItem("steuertage-range-weekdays:" + key) || "null");
      if (Array.isArray(stored)) {
        const valid = stored.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
        days = new Set(valid);
      }
    } catch (error) { /* Browser storage may be unavailable; keep the session default. */ }
    this._rangeWeekdaySettings.set(key, days);
    return days;
  }

  _setRangeWeekdays(days) {
    const key = this._calendarEntityId || "default";
    const selected = new Set(days);
    this._rangeWeekdaySettings.set(key, selected);
    try {
      localStorage.setItem("steuertage-range-weekdays:" + key, JSON.stringify([...selected]));
    } catch (error) { /* Keep the setting for this panel session. */ }
    if (this._rangeSelectionBounds && this._selectionMode === "range") {
      this._applyFilteredRange(
        this._rangeSelectionBounds.from,
        this._rangeSelectionBounds.to,
        this._rangeSelectionBounds.target
      );
    }
    this._render();
  }

  _applyFilteredRange(from, to, target) {
    const start = new Date((from < to ? from : to) + "T12:00:00");
    const end = new Date((from > to ? from : to) + "T12:00:00");
    const weekdays = this._rangeWeekdays();
    const dates = new Set();
    for (let cursor = new Date(start), limit = 0; cursor <= end && limit < 366; cursor.setDate(cursor.getDate() + 1), limit++) {
      if (weekdays.has(cursor.getDay())) dates.add(this._isoDate(cursor));
    }
    this._rangeSelectionBounds = { from, to, target };
    this._selectedDates = dates;
    this._selectionMode = "range";
    const ordered = [...dates].sort();
    this._selected = dates.has(target) ? target : ordered.at(-1) || null;
    this._correctionFrom = from < to ? from : to;
    this._correctionTo = from > to ? from : to;
  }

  _applyMultiDragDate(date) {
    const dates = new Set(this._dragBaseDates || this._selectedDates);
    const from = this._dragStartDate < date ? this._dragStartDate : date;
    const to = this._dragStartDate > date ? this._dragStartDate : date;
    const start = new Date(from + "T12:00:00");
    const end = new Date(to + "T12:00:00");
    for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
      const rangeDate = this._isoDate(cursor);
      if (!this._rangeWeekdays().has(cursor.getDay())) continue;
      if (this._dragMultiAction === "add") dates.add(rangeDate);
      else dates.delete(rangeDate);
    }
    this._selectedDates = dates;
    this._selectionMode = "multiple";
    this._selected = dates.has(date) ? date : [...dates].sort().at(-1) || null;
    const ordered = [...dates].sort();
    this._correctionFrom = ordered[0] || "";
    this._correctionTo = ordered.at(-1) || "";
    this._updateVisibleDateSelection(dates);
    const hint = this.shadowRoot.querySelector(".selection-hint");
    if (hint) hint.textContent = dates.size === 0
      ? "Keine Tage ausgewählt"
      : dates.size === 1 ? "1 Tag ausgewählt" : dates.size + " Tage ausgewählt";
  }

  _updateVisibleDateSelection(dates) {
    this.shadowRoot.querySelectorAll("[data-date]").forEach((cell) => {
      const selected = dates.has(cell.dataset.date);
      cell.classList.toggle("range-selected", selected);
      cell.classList.toggle("selected", cell.dataset.date === this._selected);
    });
    const multiButton = this.shadowRoot.querySelector("[data-action='multi-select']");
    if (multiButton) {
      multiButton.setAttribute("aria-pressed", this._multiSelectMode ? "true" : "false");
      multiButton.textContent = this._multiSelectMode ? "Mehrfachauswahl beenden" : "Mehrfachauswahl";
    }
    const clearButton = this.shadowRoot.querySelector("[data-action='clear-selection']");
    if (clearButton) clearButton.hidden = dates.size <= (this._multiSelectMode ? 2 : 1);
  }


  _showMessage(message) {
    if (this._messageTimer) clearTimeout(this._messageTimer);
    this._message = message;
    this._render();
    this._messageTimer = setTimeout(() => {
      this._message = "";
      this._messageTimer = undefined;
      this._render();
    }, 3000);
  }

  _escape(value) {
    return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
  }


  _configIssues(calendar, calendars) {
    const a = calendar.attributes || {};
    const issues = [];
    const check = (entityId, label, options = {}) => {
      if (!entityId) { issues.push(label + " ist nicht eingerichtet."); return; }
      const state = this._hass.states[entityId];
      if (!state) issues.push(label + " (" + entityId + ") wurde nicht gefunden.");
      else if (!options.ignoreTemporaryState && ["unknown", "unavailable"].includes(state.state)) {
        const stateLabel = state.state === "unavailable" ? "zurzeit nicht verfügbar" : "Status unbekannt";
        issues.push(label + " (" + entityId + ") ist " + stateLabel + ".");
      }
    };
    check(a.worklog_person_entity, "Person");
    const homeofficeEnabled = a.worklog_homeoffice_enabled !== false && a.worklog_homeoffice_enabled !== "false";
    if (homeofficeEnabled) {
      check(a.worklog_home_zone_entity, "Home-Zone");
      check(a.worklog_device_tracker || a.worklog_legacy_signal, "Homeoffice-Gerät", { ignoreTemporaryState: true });
    }
    if (a.worklog_office_zone_entity) check(a.worklog_office_zone_entity, "Arbeitsstätte (Zone)");
    if (a.worklog_work_calendar_entity) {
      check(a.worklog_work_calendar_entity, "Arbeitskalender");
      const selected = this._hass.states[a.worklog_work_calendar_entity];
      if (selected?.attributes?.worklog_person_entity) {
        issues.push("Der Arbeitskalender darf kein Steuertage-Kalender sein.");
      }
    }
    calendars.forEach((other) => {
      if (other.entity_id === calendar.entity_id) return;
      const signal = a.worklog_device_tracker || a.worklog_legacy_signal;
      const otherEnabled = other.attributes.worklog_homeoffice_enabled !== false && other.attributes.worklog_homeoffice_enabled !== "false";
      const otherSignal = other.attributes.worklog_device_tracker || other.attributes.worklog_legacy_signal;
      if (homeofficeEnabled && otherEnabled && signal && signal === otherSignal) issues.push(
        "Homeoffice-Signal ist auch " + this._calendarLabel(other) + " zugeordnet."
      );
    });
    return issues;
  }

  _configInfoMarkup() {
    const attributes = this._calendarEntity()?.attributes || {};
    const threshold = Number(attributes.worklog_threshold_hours ??
      (attributes.worklog_threshold_minutes != null ? attributes.worklog_threshold_minutes / 60 : 2))
      .toLocaleString(this._hass?.locale?.language || "de-DE", { maximumFractionDigits: 1 });
    const homeofficeEnabled = this._homeOfficeEnabled();
    const workCalendar = attributes.worklog_work_calendar_entity;
    return "<dialog class='config-info-dialog' data-config-info-dialog aria-label='So funktioniert die automatische Erkennung'><div class='config-info-dialog-content'><header class='config-info-header'><div><span class='eyebrow'>ERKENNUNG</span><h3>So funktioniert die automatische Erkennung</h3></div><button type='button' class='dialog-close-button' data-action='config-info-close' aria-label='Information schließen'>×</button></header><section class='info-card explanation-card'><p>Steuertage erfasst die Dauer passender Anwesenheitssignale, um daraus Arbeitstage abzuleiten. Im Kalender und Export werden keine Arbeitsstunden ausgewiesen. Die Standardansicht richtet sich nach der Home-Assistant-Person, die deinem angemeldeten Benutzer zugeordnet ist.</p><ul>" +
      "<li><b>Arbeitsstätte:</b> Die ausgewählte Zone steht für den Ort, zu dem du für die Arbeit fährst." +
      (workCalendar ? " Mit Arbeitskalender zählt die Anwesenheit dort nur während eines laufenden passenden Eintrags; zeitgebundene und ganztägige Einträge werden berücksichtigt." : " Ohne Arbeitskalender zählt die Anwesenheit in der Arbeitszone.") + "</li>" +
      (homeofficeEnabled ? "<li><b>Homeoffice:</b> Es zählt nur, wenn die zugeordnete Person und der ausgewählte Tracker gleichzeitig in der Home-Zone sind.</li>" : "<li><b>Homeoffice:</b> Die Erkennung ist für diese Person ausgeschaltet.</li>") +
      "<li>Ein passendes Signal zählt, sobald die eingestellte Mindestdauer von <b>" + threshold + " Stunden</b> erreicht ist. Der Standardwert beträgt 2 Stunden und kann pro Person geändert werden.</li>" +
      "<li>Vor Erreichen der Mindestdauer zeigt der Tag „Erkennung läuft“. „Bitte prüfen“ weist auf eine fehlende oder ungültige erforderliche Quelle hin.</li>" +
      "<li>Arbeitstage, Urlaub und Krankheit kannst du im Kalender manuell setzen oder ändern. Der Änderungsverlauf hält manuelle Änderungen fest.</li></ul></section><nav class='config-info-links' aria-label='Weitere Informationen'><a href='https://github.com/mongrelX15/Steuertage' target='_blank' rel='noopener noreferrer'>Repository öffnen ↗</a><a href='https://github.com/mongrelX15/Steuertage/issues/new' target='_blank' rel='noopener noreferrer'>Frage oder Änderungswunsch stellen ↗</a></nav></div></dialog>";
  }

  _configMarkup(calendars) {
    const preferredCalendar = this._preferredCalendarEntity(calendars);
    const locale = this._hass?.locale?.language || "de-DE";
    const orderedCalendars = [...calendars].sort((a, b) => {
      if (a.entity_id === preferredCalendar?.entity_id) return -1;
      if (b.entity_id === preferredCalendar?.entity_id) return 1;
      return this._calendarLabel(a).localeCompare(this._calendarLabel(b), locale);
    });
    const cards = orderedCalendars.map((calendar) => {
      const a = calendar.attributes || {};
      const homeofficeEnabled = a.worklog_homeoffice_enabled !== false && a.worklog_homeoffice_enabled !== "false";
      const issues = this._configIssues(calendar, calendars);
      const workCalendar = a.worklog_work_calendar_entity
        ? (this._hass.states[a.worklog_work_calendar_entity]?.attributes?.friendly_name || a.worklog_work_calendar_entity)
        : "Nicht ausgewählt – reine Zonenerkennung";
      const thresholdHours = Number(a.worklog_threshold_hours ?? (a.worklog_threshold_minutes != null ? a.worklog_threshold_minutes / 60 : 2));
      const thresholdLabel = thresholdHours.toLocaleString(this._hass?.locale?.language || "de-DE", { maximumFractionDigits: 1 });
      const rows = [["Person", a.worklog_person_entity],
        ["Homeoffice-Erfassung", homeofficeEnabled ? "Aktiv" : "Deaktiviert"],
        ...(homeofficeEnabled ? [["Home-Zone", a.worklog_home_zone_entity],
          ["Homeoffice-Gerät", (() => {
            const entityId = a.worklog_device_tracker || a.worklog_legacy_signal;
            const state = entityId ? this._hass.states[entityId] : null;
            const name = state?.attributes?.friendly_name || entityId || "Nicht eingerichtet";
            return state && ["unknown", "unavailable"].includes(state.state)
              ? name + " (derzeit nicht erreichbar; bei ausgeschaltetem Gerät normal)"
              : name;
          })()]] : []),
        ["Arbeitsstätte (Zone)", a.worklog_office_zone_entity || "Nicht eingerichtet"],
        ["Arbeitskalender", workCalendar],
        ["Schwellwert", thresholdLabel + " Stunden"]];
      return "<section class='config-card'><div class='config-title'><h3>" + this._escape(this._calendarLabel(calendar)) +
        "</h3><a class='settings-link' href='/config/integrations/integration/steuertage#config_entry=" + encodeURIComponent(a.worklog_entry_id || "") +
        "'>Einstellungen öffnen</a></div><dl>" + rows.map(([k,v]) => "<div><dt>" + k + "</dt><dd>" +
        this._escape(v || "Nicht eingerichtet") + "</dd></div>").join("") + "</dl>" +
        (issues.length ? "<div class='validation warning'><b>Bitte prüfen</b><ul>" + issues.map((issue) => "<li>" + this._escape(issue) + "</li>").join("") + "</ul></div>" :
        "<p class='validation ok'>Konfiguration und benötigte Entitäten sind verfügbar.</p>") +
        (!a.worklog_office_zone_entity ? "<p class='muted'>Keine Zone für die Arbeitsstätte hinterlegt: Arbeitstage werden nicht automatisch erkannt.</p>" : "") +
        "</section>";
    }).join("");
    return "<ha-card><header class='view-header'><div><span class='eyebrow'>EINSTELLUNGEN</span><h2>Konfiguration</h2><p>Personen, Erkennung und Schwellwerte im Blick behalten.</p></div><span class='header-badge'>"+calendars.length+" "+(calendars.length === 1 ? "Person" : "Personen")+"</span></header>" +
      (cards || "<p>Richte zuerst eine Person über Einstellungen → Geräte &amp; Dienste → Integration hinzufügen → Steuertage ein.</p>") + "</ha-card>";

  }

  _dataManagementMarkup(calendars) {
    const backupContent = this._pendingRestore
      ? "<section class='restore-review-card'><span class='eyebrow'>SICHERUNG WIEDERHERSTELLEN</span><h3>Import prüfen</h3>" +
        "<p class='restore-summary'><strong>" + this._escape(this._pendingRestore.filename) + "</strong><br>" +
        this._pendingRestore.recordCount + " gespeicherte Tage für " + this._pendingRestore.matched.length + " eingerichtete Personen." +
        (this._pendingRestore.backup.coverage?.from && this._pendingRestore.backup.coverage?.to
          ? " Zeitraum: " + this._formatDate(this._pendingRestore.backup.coverage.from) + " bis " + this._formatDate(this._pendingRestore.backup.coverage.to) + "."
          : "") +
        (this._pendingRestore.backup.created_at ? " Erstellt am " + this._escape(new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(new Date(this._pendingRestore.backup.created_at))) + "." : "") +
        (this._pendingRestore.skipped ? " " + this._pendingRestore.skipped + " weitere Personen werden übersprungen." : "") + "</p>" +
        "<fieldset class='restore-options' " + (this._backupRestoring ? "disabled" : "") + "><legend>Wie sollen die gesicherten Tage eingetragen werden?</legend>" +
        "<label class='restore-option'><input type='radio' name='restore-strategy' value='merge_newer' checked><span><strong>Ergänzen</strong><small>Fehlende Tage hinzufügen und neuere lokale Änderungen behalten.</small></span></label>" +
        "<label class='restore-option'><input type='radio' name='restore-strategy' value='replace'><span><strong>Ersetzen</strong><small>Tage aus der Sicherung überschreiben. Tage, die nicht in der Sicherung stehen, bleiben unverändert.</small></span></label></fieldset>" +
        (this._backupRestoring ? "<p class='restore-progress' role='status'>Wiederherstellung läuft …</p>" : "") +
        "<div class='restore-dialog-actions'><button class='export-button' data-restore-cancel " + (this._backupRestoring ? "disabled" : "") + ">Abbrechen</button>" +
        "<button class='export-button primary' data-restore-confirm " + (this._backupRestoring ? "disabled" : "") + ">Jetzt wiederherstellen</button></div></section>"
      : "<section class='backup-card'><p>Die Sicherung enthält die Verläufe aller in Steuertage eingerichteten Personen – unabhängig von der aktuell ausgewählten Person. Beim Wiederherstellen werden nur aktuell eingerichtete Personen berücksichtigt. Dafür ist ein Home-Assistant-Administrator erforderlich.</p>" +
        "<p>„Ergänzen“ fügt fehlende Tage hinzu und behält neuere lokale Änderungen. „Ersetzen“ überschreibt die gesicherten Tage; Tage, die nicht in der Sicherung stehen, bleiben unverändert.</p>" +
        "<div class='backup-actions'><button class='export-button' data-backup " + (!calendars.length ? "disabled" : "") + ">Sicherung erstellen</button>" +
        "<button class='export-button' data-restore " + (!calendars.length ? "disabled" : "") + ">Sicherung auswählen</button></div>" +
        (this._backupNotice ? "<div class='backup-feedback " + this._backupNotice.kind + "' role='status'><span class='backup-feedback-icon' aria-hidden='true'>" +
          (this._backupNotice.kind === "success" ? "✓" : this._backupNotice.kind === "error" ? "!" : "↓") +
          "</span><div><strong>" + this._escape(this._backupNotice.title) + "</strong><p>" + this._escape(this._backupNotice.text) + "</p>" +
          (this._preparedBackup ? "<button class='export-button primary' data-save-backup>Datei speichern…</button>" : "") +
          "</div></div>" : "") +
        "<input data-restore-file type='file' accept='application/json,.json' hidden></section>";
    return "<dialog class='data-management-dialog' data-data-management-dialog aria-labelledby='data-management-title'><div class='data-management-content'>" +
      "<header class='data-management-header'><div><span class='eyebrow'>DATENVERWALTUNG</span><h2 id='data-management-title'>Sicherung &amp; Wiederherstellung</h2><p>Verläufe aller eingerichteten Personen sichern oder aus einer Datei wiederherstellen.</p></div>" +
      "<button type='button' class='dialog-close-button' data-action='data-management-close' aria-label='Datenverwaltung schließen'>×</button></header>" +
      backupContent + "</div></dialog>";
  }

  _exportRows() {
    const byDate = new Map();
    (this._exportEvents || []).forEach((event) => {
      const date = (event.start || "").slice(0, 10);
      if (date >= this._exportFrom && date <= this._exportTo && !byDate.has(date)) byDate.set(date, event);
    });
    return [...byDate.entries()]
      .filter(([, event]) => this._type(event) !== "no_work")
      .sort((a,b) => a[0].localeCompare(b[0])).map(([date,event]) => ({
        date, type: this._type(event), label: this._label(this._type(event)),
        mixed: this._isMixedEvent(event),
        manual: (event.description || "").includes("Manuell geändert"),
      }));
  }

  _countsForRows(rows) {
    const homeofficeEnabled = this._homeOfficeEnabled();
    const counts = { office: 0, home_office: 0, mixed: 0, sick_leave: 0, vacation: 0, needs_review: 0, tracking: 0 };
    rows.forEach((row) => {
      if (row.type === "home_office" && !homeofficeEnabled) return;
      if (row.type in counts && row.type !== "mixed") counts[row.type]++;
      if (homeofficeEnabled && row.mixed) counts.mixed++;
    });
    counts.workdays = counts.office + counts.home_office;
    counts.manual = rows.filter((row) => row.manual).length;
    return counts;
  }

  _monthlySummary(rows) {
    const months = new Map();
    rows.forEach((row) => {
      const month = row.date.slice(0, 7);
      if (!months.has(month)) months.set(month, []);
      months.get(month).push(row);
    });
    return [...months.entries()].map(([month, monthRows]) => ({ month, ...this._countsForRows(monthRows) }));
  }

  _exportMarkup(calendars) {
    const rows = this._exportEvents === null ? null : this._exportRows();
    const homeofficeEnabled = this._homeOfficeEnabled();
    const counts = this._countsForRows(rows || []);
    const stat = (label,value) => "<div class='stat'><span>" + label + "</span><strong>" + value + "</strong></div>";
    const person = calendars.length > 1 ? "<label class='person-picker'><span>Auswertung für</span><select data-export-calendar>" + calendars.map((item) =>
      "<option value='" + item.entity_id + "' " + (item.entity_id === this._calendarEntityId ? "selected" : "") + ">" +
      this._escape(this._calendarLabel(item)) + "</option>").join("") + "</select></label>" : "";
    const openItems = (rows || []).filter((row) => row.type === "needs_review" || row.type === "tracking");
    const checklist = rows === null ? "<p>Prüfliste wird geladen …</p>" : openItems.length
      ? "<ul class='checklist'>" + openItems.map((row) => "<li><button class='text-button' data-review-date='" + row.date + "'>" +
        this._formatDate(row.date) + " · " + this._escape(row.type === "needs_review" ? "Bitte prüfen" : "Erkennung läuft") + "</button></li>").join("") + "</ul>"
      : "<p class='validation ok'>Keine offenen Hinweise zur Prüfung in diesem Zeitraum.</p>";
    const monthly = rows === null ? [] : this._monthlySummary(rows);
    const monthlyHead = "<th>Monat</th><th>Arbeitsstätte</th>" +
      (homeofficeEnabled ? "<th>Homeoffice</th><th>Mischtage (Info)</th>" : "") +
      "<th>Krank</th><th>Urlaub</th><th>Arbeitstage gesamt</th>";
    const monthlyRows = monthly.map((m) => "<tr><td>" + m.month + "</td><td>" + m.office + "</td>" +
      (homeofficeEnabled ? "<td>" + m.home_office + "</td><td>" + m.mixed + "</td>" : "") +
      "<td>" + m.sick_leave + "</td><td>" + m.vacation + "</td><td>" + m.workdays + "</td></tr>").join("");
    const monthlyTable = monthly.length ? "<div class='table-wrap'><table><thead><tr>" + monthlyHead +
      "</tr></thead><tbody>" + monthlyRows + "</tbody></table></div>" :
      "<p>Für den gewählten Zeitraum gibt es keine gespeicherten Tage.</p>";
    let table = "<p>Lade gespeicherte Tage …</p>";
    if (rows !== null) table = rows.length ? "<div class='table-wrap'><table><thead><tr><th>Datum</th><th>Erkannter Typ</th><th>Hinweis</th></tr></thead><tbody>" +
      rows.map((r) => "<tr class='" + (r.type === "needs_review" ? "needs-review" : r.type === "tracking" ? "tracking-row" : "") +
      "'><td>" + this._formatDate(r.date) + "</td><td>" + this._escape(r.label) + (r.mixed ? " <span class='mixed-tag'>Mischtag</span>" : "") + (r.manual ? " <span class='manual-tag'>Manuell geändert</span>" : "") +
      "</td><td>" + (r.type === "needs_review" ? "<button class='text-button' data-review-date='" + r.date + "'>Bitte im Kalender prüfen</button>" :
      r.type === "tracking" ? "Erkennung noch nicht abgeschlossen" : "—") + "</td></tr>").join("") + "</tbody></table></div>" :
      "<p>Für den gewählten Zeitraum gibt es keine gespeicherten Tage.</p>";
    const disabled = rows === null ? "disabled" : "";
    const logEntries = rows === null ? [] : (this._exportEvents || []).flatMap((event) => {
      const date = (event.start || "").slice(0, 10);
      if (date < this._exportFrom || date > this._exportTo) return [];
      return this._changeHistory(event).map((entry) => ({ ...entry, date }));
    }).sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
    const changeLabel = (value) => value === "automatic" ? "Automatik" : this._label(value);
    const currentYear = new Date().getFullYear();
    return "<ha-card><header class='view-header'><div><span class='eyebrow'>AUSWERTUNG &amp; DATENSICHERUNG</span><h2>Daten &amp; Export</h2><p>Steuerlich relevante Tage auswerten, exportieren und Verläufe sichern oder wiederherstellen.</p></div><span class='header-badge'>CSV · TXT · HTML</span></header>" +
      "<section class='info-card export-check " + (openItems.length ? "has-issues" : "all-clear") + "'><h3>Vor dem Export prüfen</h3>" + checklist + (rows === null ? "" : "<p class='muted'>" + counts.manual + " manuell geänderte Tage im Zeitraum.</p>") + "</section>" +
      "<section class='export-period'><div class='section-heading'><div><span class='eyebrow'>ZEITRAUM</span><h3>Auswertung eingrenzen</h3></div>" + person + "</div><div class='export-controls'>" +
      "<div class='preset-row'>" +
      [currentYear, currentYear - 1, currentYear - 2].map((year) => "<button class='export-button' data-period='year' data-year='" + year + "'>Steuerjahr " + year + "</button>").join("") +
      "<button class='export-button' data-period='month'>Dieser Monat</button><button class='export-button' data-period='week'>Diese Woche</button></div>" +
      "<label>Von <input data-export-from type='date' value='" + this._exportFrom + "'></label>" +
      "<label>Bis <input data-export-to type='date' value='" + this._exportTo + "'></label>" +
      "<button class='export-button' data-download='csv' " + disabled + ">CSV herunterladen</button>" +
      "<button class='export-button' data-download='txt' " + disabled + ">TXT herunterladen</button>" +
      "<button class='export-button' data-download='html' " + disabled + ">HTML herunterladen</button></div></section>" +
      "<p class='muted'>" + (homeofficeEnabled ? "Mischtage sind in ihrer Hauptkategorie enthalten und werden als Zusatzinformation ausgewiesen. " : "") + "Nur durch diese App erfasste Tage können in der Auswertung berücksichtigt werden.</p>" +
      (rows === null ? table : "<div class='stats export-stats'>" + stat("Tage mit Arbeitsstätte",counts.office) +
      (homeofficeEnabled ? stat("Homeoffice-Tage",counts.home_office) + stat("Davon Mischtage (Info)",counts.mixed) : "") +
      stat("Krankheitstage",counts.sick_leave) + stat("Urlaubstage",counts.vacation) +
      stat("Arbeitstage gesamt",counts.workdays) + stat("Bitte prüfen",counts.needs_review) + stat("Erkennung läuft",counts.tracking) + "</div>" +
      "<details class='data-disclosure' data-disclosure-id='monthly' " + (this._openDisclosures.has("monthly") ? "open" : "") + "><summary><span>Monatsübersicht</span><small>" + monthly.length + (monthly.length === 1 ? " Monat" : " Monate") + "</small></summary><div class='disclosure-content'>" + monthlyTable + "</div></details>" +
      "<details class='data-disclosure' data-disclosure-id='daily' " + (this._openDisclosures.has("daily") ? "open" : "") + "><summary><span>Tagesliste</span><small>" + rows.length + (rows.length === 1 ? " Tag" : " Tage") + "</small></summary><div class='disclosure-content'>" + table + "</div></details>" +
      "<details class='data-disclosure change-log' data-disclosure-id='history' " + (this._openDisclosures.has("history") ? "open" : "") + "><summary><span>Änderungslogbuch</span><small>" + logEntries.length + (logEntries.length === 1 ? " Änderung" : " Änderungen") + "</small></summary><div class='disclosure-content'>" +
      "<p class='muted'>Manuelle Änderungen der ausgewählten Person im gewählten Zeitraum.</p>" +
      (logEntries.length ? "<ol class='change-log-list'>" + logEntries.map((entry) => {
        const stamp = entry.timestamp ? new Date(entry.timestamp) : null;
        const timeLabel = stamp && !Number.isNaN(stamp.getTime())
          ? new Intl.DateTimeFormat(this._hass?.locale?.language || "de-DE", { dateStyle: "medium", timeStyle: "short" }).format(stamp)
          : this._formatDate(entry.date);
        const changedBy = entry.changed_by_name || entry.changed_by || "Home-Assistant-Benutzer";
        return "<li><span><strong>" + this._escape(changeLabel(entry.old_value || "")) + " → " + this._escape(changeLabel(entry.new_value || "")) + "</strong><small>" + this._escape(timeLabel) + " · " + this._escape(changedBy) + "</small></span></li>";
      }).join("") + "</ol>" : "<p>Für diesen Zeitraum sind keine manuellen Änderungen gespeichert.</p>") + "</div></details>") +
      "<div class='backup-launch'><button type='button' class='export-button' data-open-data-management>Sicherung &amp; Wiederherstellung verwalten</button></div></ha-card>";
  }

  async _loadExportEvents() {
    const entity = this._calendarEntity(), entityId = entity?.entity_id;
    const key = entityId + ":" + this._exportFrom + ":" + this._exportTo;
    if (!entityId || !this._hass?.connection) { this._exportEvents = []; this._render(); return; }
    if (key === this._exportKey && this._exportEvents !== null) return;
    const from = new Date(this._exportFrom + "T00:00:00");
    const lastDay = new Date(this._exportTo + "T00:00:00");
    const queryStart = new Date(from);
    queryStart.setDate(queryStart.getDate() - 1);
    if (Number.isNaN(from.getTime()) || Number.isNaN(lastDay.getTime()) || lastDay < from) {
      this._exportEvents = [];
      this._render();
      return;
    }
    const end = new Date(lastDay);
    end.setDate(end.getDate() + 2);
    this._exportKey = key; this._exportEvents = null;
    if (this._exportUnsubscribe) { const stop = this._exportUnsubscribe; this._exportUnsubscribe = undefined; await stop(); }
    try {
      this._exportUnsubscribe = await this._hass.connection.subscribeMessage((message) => {
        if (this._calendarEntityId !== entityId || this._exportKey !== key) return;
        this._exportEvents = Array.isArray(message?.events) ? message.events :
          Array.isArray(message?.event?.events) ? message.event.events : [];
        this._render();
      }, { type: "calendar/event/subscribe", entity_id: entityId, start: queryStart.toISOString(), end: end.toISOString() });
    } catch (error) { this._exportEvents = []; this._render(); }
  }

  _setBackupNotice(kind, title, text) {
    this._backupNotice = { kind, title, text };
    this._render();
  }

  async _downloadBackup() {
    this._preparedBackup = null;
    this._backupNotice = null;
    try {
      const calendars = this._calendarEntities();
      const people = [];
      for (const calendar of calendars) {
        const personEntity = calendar.attributes.worklog_person_entity;
        const personBackup = await this._hass.connection.sendMessagePromise({
          type: "steuertage/export_history", person_entity: personEntity,
        });
        people.push({
          person_entity: personBackup.person_entity,
          person_name: personBackup.person_name,
          created_at: personBackup.created_at,
          records: personBackup.records,
        });
      }
      const createdAt = new Date().toISOString();
      const coverageDates = people.flatMap((person) => Object.keys(person.records || {}))
        .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
      const coverage = { from: coverageDates[0] || null, to: coverageDates[coverageDates.length - 1] || null };
      const backup = {
        format: "steuertage_backup",
        version: 2,
        created_at: createdAt,
        coverage,
        people,
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const recordCount = people.reduce((total, person) => total + Object.keys(person.records || {}).length, 0);
      const createdLabel = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(createdAt));
      const coverageLabel = coverage.from && coverage.to
        ? this._formatDate(coverage.from) + " bis " + this._formatDate(coverage.to)
        : "noch keine Tage gespeichert";
      this._preparedBackup = {
        blob,
        filename: "steuertage-sicherung-alle-personen.json",
        peopleCount: people.length,
        recordCount,
      };
      this._setBackupNotice(
        "ready",
        "Sicherung erstellt",
        recordCount + " Tage für " + people.length + " Personen. Zeitraum: " + coverageLabel +
        ". Erstellt am " + createdLabel + ". Wähle „Datei speichern“, um den Speicherort festzulegen."
      );
    } catch (error) {
      this._setBackupNotice("error", "Sicherung fehlgeschlagen", "Die Sicherung konnte nicht erstellt werden. Bitte melde dich mit einem Home-Assistant-Administrator an.");
    }
  }

  async _savePreparedBackup() {
    const prepared = this._preparedBackup;
    if (!prepared) return;
    try {
      if (typeof window.showSaveFilePicker === "function") {
        const handle = await window.showSaveFilePicker({
          suggestedName: prepared.filename,
          types: [{ description: "Steuertage-Sicherung", accept: { "application/json": [".json"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(prepared.blob);
        await writable.close();
        this._preparedBackup = null;
        this._setBackupNotice("success", "Sicherung gespeichert", prepared.filename + " wurde am ausgewählten Speicherort gespeichert.");
        return;
      }
      const url = URL.createObjectURL(prepared.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = prepared.filename;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      this._preparedBackup = null;
      this._setBackupNotice("success", "Download gestartet", prepared.filename + " wurde an den Browser übergeben. Der Browser verwaltet den Speicherort.");
    } catch (error) {
      if (error?.name === "AbortError") return;
      this._setBackupNotice("error", "Datei konnte nicht gespeichert werden", error?.message || "Bitte versuche es erneut.");
    }
  }

  async _prepareRestore(file) {
    if (!file) return;
    this._backupNotice = null;
    try {
      const backup = JSON.parse(await file.text());
      if (backup?.format !== "steuertage_backup") throw new Error("Das ist keine gültige Steuertage-Sicherung.");
      let people;
      if (backup.version === 1 && backup.person_entity && backup.records && typeof backup.records === "object") {
        people = [{ person_entity: backup.person_entity, person_name: backup.person_name, records: backup.records, created_at: backup.created_at }];
      } else if (backup.version === 2 && Array.isArray(backup.people)) {
        people = backup.people;
      } else {
        throw new Error("Das Sicherungsformat wird nicht unterstützt.");
      }
      if (people.length > 100) throw new Error("Die Sicherung enthält zu viele Personen.");
      const available = new Map(this._calendarEntities().map((item) =>
        [item.attributes.worklog_person_entity, item]));
      const matched = people.filter((person) => available.has(person.person_entity));
      const skipped = people.length - matched.length;
      if (!matched.length) throw new Error("Keine Person aus dieser Sicherung ist aktuell in Steuertage eingerichtet.");
      let recordCount = 0;
      for (const person of matched) {
        if (!person.records || typeof person.records !== "object" || Array.isArray(person.records)) {
          throw new Error("Die Sicherung für " + (person.person_name || person.person_entity) + " ist ungültig.");
        }
        recordCount += Object.keys(person.records).length;
      }
      if (recordCount > 100000) throw new Error("Die Sicherung enthält zu viele Datensätze.");
      this._pendingRestore = {
        backup,
        matched,
        skipped,
        recordCount,
        filename: file.name || "Steuertage-Sicherung",
      };
      this._render();
    } catch (error) {
      this._pendingRestore = null;
      this._setBackupNotice("error", "Sicherung konnte nicht gelesen werden", error?.message || "Die Datei ist ungültig.");
    }
  }

  async _restoreBackup() {
    const pending = this._pendingRestore;
    if (!pending || this._backupRestoring) return;
    const strategy = this.shadowRoot.querySelector("input[name='restore-strategy']:checked")?.value || "merge_newer";
    this._backupRestoring = true;
    this._render();
    try {
      const totals = { imported: 0, replaced: 0, preserved_newer: 0, invalid: 0 };
      for (const person of pending.matched) {
        const result = await this._hass.connection.sendMessagePromise({
          type: "steuertage/restore_history",
          person_entity: person.person_entity,
          records: person.records,
          strategy,
          created_at: person.created_at || pending.backup.created_at || "",
        });
        for (const key of Object.keys(totals)) totals[key] += Number(result[key] || 0);
      }
      this._exportKey = "";
      this._exportEvents = null;
      this._pendingRestore = null;
      this._backupRestoring = false;
      await this._loadExportEvents();
      const skippedText = pending.skipped
        ? " " + pending.skipped + " nicht eingerichtete Personen wurden übersprungen."
        : "";
      this._setBackupNotice(
        "success",
        "Wiederherstellung abgeschlossen",
        totals.imported + " ergänzt, " + totals.replaced + " ersetzt, " + totals.preserved_newer +
        " neuere lokale Einträge behalten, " + totals.invalid + " ungültige verworfen. Datei: " +
        pending.filename + "." + skippedText
      );
    } catch (error) {
      this._pendingRestore = null;
      this._backupRestoring = false;
      this._setBackupNotice("error", "Wiederherstellung fehlgeschlagen", error?.message || "Die Sicherung konnte nicht eingelesen werden.");
    }
  }

  _cancelRestore() {
    if (this._backupRestoring) return;
    this._pendingRestore = null;
    this._render();
  }

  _downloadExport(format) {
    const person = this._calendarLabel(this._calendarEntity() || {attributes:{},entity_id:""});
    const homeofficeEnabled = this._homeOfficeEnabled();
    const rows = this._exportRows();
    const c = this._countsForRows(rows);
    const headers = ["Datum","Tagestyp","Manuell geändert","Hinweis"];
    const values = rows.map((r) => [this._formatDate(r.date),r.label,r.manual?"Ja":"Nein",r.mixed?"Mischtag (im Haupttyp enthalten)":r.type==="needs_review"?"Bitte im Kalender prüfen":r.type==="tracking"?"Erkennung noch nicht abgeschlossen":""]);
    const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (x) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[x]));
    const period = this._formatDate(this._exportFrom) + " bis " + this._formatDate(this._exportTo);
    const generatedAt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date());
    const summary = [["Tage mit Arbeitsstätte",c.office]];
    if (homeofficeEnabled) summary.push(["Homeoffice-Tage",c.home_office],["Davon Mischtage (Info; in Haupttyp enthalten)",c.mixed]);
    summary.push(["Krankheitstage",c.sick_leave],["Urlaubstage",c.vacation],["Arbeitstage gesamt",c.workdays],["Bitte prüfen",c.needs_review],["Erkennung läuft",c.tracking]);
    const monthHead = ["Monat","Arbeitsstätte",...(homeofficeEnabled ? ["Homeoffice","Mischtage (Info)"] : []),"Krank","Urlaub","Arbeitstage gesamt"];
    const monthValues = (m) => [this._formatDate(m.month + "-01", { month: "long", year: "numeric" }),m.office,...(homeofficeEnabled ? [m.home_office,m.mixed] : []),m.sick_leave,m.vacation,m.workdays];
    const disclaimer = "Steuertage unterstützt lediglich die automatische Erfassung relevanter Daten auf Grundlage der in Home Assistant vorhandenen Erkennung. Für Richtigkeit und Vollständigkeit Ihrer Steuererklärung tragen Sie die volle Verantwortung. Alle Angaben ohne Gewähr.";
    const notice = "Nur durch diese App erfasste Tage können in der Auswertung berücksichtigt werden.";
    let content, mime = "text/plain;charset=utf-8";
    if (format === "csv") {
      content = "\ufeff" + [["Steuertage",period,person,"Erstellt am "+generatedAt],["Hinweis",notice],["Verantwortung",disclaimer],[],...summary,[],headers,...values].map((line) => line.map((v) => '"' + String(v ?? "").replace(/"/g,'""') + '"').join(";")).join("\r\n");
      mime = "text/csv;charset=utf-8";
    } else if (format === "html") {
      const monthly = this._monthlySummary(rows);
      content = "<!doctype html><html lang='de'><head><meta charset='utf-8'><title>Steuertage " + period + "</title><style>body{font:16px system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#222}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #ddd;padding:.55rem}.notice{background:#fff4d5}.report-meta{color:#555;font-size:14px;margin:-.5rem 0 1.5rem}@media print{body{max-width:none;margin:0;padding:0;color:#000;font-size:11pt}h1{font-size:20pt}h2{break-after:avoid}table{font-size:9pt}thead{display:table-header-group}tr{break-inside:avoid}.notice{background:#f2f2f2!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}.report-footer{border-top:1px solid #999;margin-top:2rem;padding-top:1rem;font-size:9pt}}</style></head><body><h1>Steuertage · " + esc(person) + "</h1><p class='report-meta'>Auswertungszeitraum: " + period + " · Erstellt am " + esc(generatedAt) + "</p><h2>Übersicht</h2><ul>" +
        summary.map((x) => "<li>" + esc(x[0]) + ": " + x[1] + "</li>").join("") + "</ul><h2>Monatsübersicht</h2><table><thead><tr>" +
        monthHead.map((x) => "<th>" + esc(x) + "</th>").join("") + "</tr></thead><tbody>" +
        monthly.map((m) => "<tr>" + monthValues(m).map((v) => "<td>"+esc(v)+"</td>").join("") + "</tr>").join("") +
        "</tbody></table><h2>Prüfliste</h2>" + rows.filter((r) => r.type === "needs_review" || r.type === "tracking").map((r) => "<p>"+esc(this._formatDate(r.date))+" · "+esc(r.label)+"</p>").join("") +
        "<h2>Tagesliste</h2><table><thead><tr>" + headers.map((x) => "<th>" + esc(x) + "</th>").join("") + "</tr></thead><tbody>" + rows.map((r) => "<tr class='" +
        (r.type === "needs_review" || r.type === "tracking" ? "notice" : "") + "'><td>" + esc(this._formatDate(r.date)) + "</td><td>" + esc(r.label) +
        "</td><td>" + (r.manual?"Ja":"Nein") + "</td><td>" + esc(r.mixed?"Mischtag (im Haupttyp enthalten)":r.type === "needs_review"?"Bitte im Kalender prüfen":r.type === "tracking"?"Erkennung noch nicht abgeschlossen":"") +
        "</td></tr>").join("") + "</tbody></table><footer class='report-footer'><p>"+notice+"</p><p>"+disclaimer+"</p></footer></body></html>";
      mime = "text/html;charset=utf-8";
    } else {
      content = "Steuertage " + period + " – " + person + "\nErstellt am: " + generatedAt + "\n\n" + summary.map((x) => x[0] + ": " + x[1]).join("\n") +
        "\n\nMonatsübersicht\n" + monthHead.join(" | ") + "\n" + this._monthlySummary(rows).map((m) => monthValues(m).join(" | ")).join("\n") +
        "\n\nPrüfliste\n" + rows.filter((r) => r.type === "needs_review" || r.type === "tracking").map((r) => this._formatDate(r.date) + " · " + r.label).join("\n") +
        "\n\n" + headers.join(" | ") + "\n" + values.map((r) => r.join(" | ")).join("\n") +
        "\n\n" + notice + "\n\n" + disclaimer;
    }
    const url = URL.createObjectURL(new Blob([content], {type:mime}));
    const link = document.createElement("a"); link.href=url; link.download="steuertage-"+this._exportFrom+"-"+this._exportTo+"."+format; link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  }

  _render() {
    if (!this._hass) return;
    const locale = this._hass.locale?.language || "de-DE";
    const title = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(this._month);
    const selectedEvent = this._eventForDay(this._selected);
    const monthStats = this._monthStats();
    const homeOfficeEnabled = this._homeOfficeEnabled();
    const monthStatItems = [
      { label: "Arbeitstage", value: monthStats.workdays },
      { label: "Arbeitsstätte", value: monthStats.office },
      ...(homeOfficeEnabled ? [{ label: "Homeoffice", value: monthStats.homeOffice }] : []),
      ...(homeOfficeEnabled && monthStats.mixed ? [{ label: "Davon Mischtage", value: monthStats.mixed }] : []),
      { label: "Urlaub", value: monthStats.vacation },
      { label: "Krankheit", value: monthStats.sick },
    ];
    const openReviewItems = this._events
      .filter((event) => {
        const date = (event.start || "").slice(0, 10);
        const type = this._type(event);
        return date.startsWith(this._isoDate(this._month).slice(0, 7)) &&
          (type === "needs_review" || type === "tracking");
      })
      .sort((a, b) => (a.start || "").localeCompare(b.start || ""));
    const openReviewMarkup = openReviewItems.length
      ? "<section class='open-review-card'><div class='open-review-heading'><div><span class='eyebrow'>DIESER MONAT</span><strong>Offene Prüftage</strong></div><span class='open-review-count'>" + openReviewItems.length + "</span></div><div class='open-review-days'>" +
        openReviewItems.slice(0, 8).map((event) => {
          const date = (event.start || "").slice(0, 10);
          const type = this._type(event);
          return "<button class='review-day-chip " + (type === "needs_review" ? "needs-review" : "tracking") + "' data-review-date='" + date + "'><span>" +
            this._formatDate(date) + "</span><small>" + (type === "needs_review" ? "Bitte prüfen" : "Erkennung läuft") + "</small></button>";
        }).join("") +
        (openReviewItems.length > 8 ? "<span class='review-more'>+" + (openReviewItems.length - 8) + " weitere</span>" : "") +
        "</div></section>"
      : "";
    const detectedType = this._type(selectedEvent);
    const automaticSelection = !selectedEvent ||
      !(selectedEvent.description || "").includes("Manuell geändert zu:");
    const selectedType = automaticSelection ? "automatic" : detectedType;
    const selectedLabel = (automaticSelection
      ? "Automatik · " + (detectedType ? this._label(detectedType) : "Noch kein Eintrag")
      : this._label(detectedType)) + (this._isMixedEvent(selectedEvent) ? " · Mischtag" : "");
    const selectedDates = this._selectedDates || new Set(this._selected ? [this._selected] : []);
    const selectedDateCount = selectedDates.size;
    const rangeWeekdays = this._rangeWeekdays();
    const selectionFilterVisible = this._multiSelectMode || selectedDateCount > 1;
    const editHistory = this._editHistoryForCurrentPerson();
    const historyButtonsMarkup = "<div class='calendar-history-controls' aria-label='Kalenderänderungen'>" +
      "<button type='button' class='history-button' data-action='undo' aria-label='Rückgängig' title='Rückgängig' " +
      (!editHistory.undo.length || this._busy ? "disabled" : "") + "><span aria-hidden='true'>↶</span>Rückgängig</button>" +
      "<button type='button' class='history-button' data-action='redo' aria-label='Wiederholen' title='Wiederholen' " +
      (!editHistory.redo.length || this._busy ? "disabled" : "") + "><span aria-hidden='true'>↷</span>Wiederholen</button></div>";
    const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];
    const weekdayLabels = weekdayOrder.map((day) => new Intl.DateTimeFormat(locale, { weekday: "short" })
      .format(new Date(2024, 0, day === 0 ? 7 : day)));
    const rangeFilterMarkup = selectionFilterVisible
      ? "<section class='range-filter' aria-label='Wochentage für Bereichsauswahl'><div class='range-filter-heading'><div><strong>Wochentage für Bereichsauswahl</strong><small>Gilt nur beim Ziehen und bei Umschalt-Klick.</small></div><div class='range-filter-presets'><button type='button' data-range-preset='weekdays'>Wochenende auslassen</button><button type='button' data-range-preset='all'>Alle Tage</button></div></div><div class='range-weekday-options'>" +
        weekdayOrder.map((day, index) => "<button type='button' class='range-weekday " + (rangeWeekdays.has(day) ? "active" : "") + "' data-range-weekday='" + day + "' aria-pressed='" + (rangeWeekdays.has(day) ? "true" : "false") + "'>" + weekdayLabels[index] + "</button>").join("") +
        "</div><small>Einzelne Klicks bleiben möglich. Feiertage werden nicht herausgefiltert.</small></section>"
      : "";
    const monthStart = new Date(this._month.getFullYear(), this._month.getMonth(), 1);
    const offset = (monthStart.getDay() + 6) % 7;
    const gridStart = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1 - offset);
    const todayIso = this._isoDate(new Date());
    const dayNames = new Intl.DateTimeFormat(locale, { weekday: "short" });
    let headers = "";
    for (let i = 0; i < 7; i++) {
      const weekday = new Date(2024, 0, 1 + i);
      const weekendLabel = i >= 5 ? " weekend-label" : "";
      headers += "<div class='weekday" + weekendLabel + "'>" + dayNames.format(weekday) + "</div>";
    }
    let cells = "";
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const iso = this._isoDate(d);
      const event = this._eventForDay(iso);
      const type = this._type(event);
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
      const manuallyChanged = (event?.description || "").includes("Manuell geändert");
      const mixedDay = this._isMixedEvent(event);
      const cls = ["day", isWeekend ? "weekend" : "", type ? "type-" + type : "", manuallyChanged ? "manual" : "", mixedDay ? "mixed" : "", d.getMonth() !== this._month.getMonth() ? "outside" : "", iso === todayIso ? "today" : "", iso === this._selected ? "selected" : "", selectedDates.has(iso) ? "range-selected" : ""].filter(Boolean).join(" ");
      cells += "<button class='" + cls + "' data-date='" + iso + "' aria-label='" + this._formatDate(iso) + (event ? ": " + this._label(type) : "") + (mixedDay ? ", Mischtag" : "") + (manuallyChanged ? ", manuell geändert" : "") + "'>" + d.getDate() + (mixedDay ? "<span class='mixed-mark' aria-hidden='true'>M</span>" : "") + (manuallyChanged ? "<span class='manual-mark' title='Manuell geändert' aria-hidden='true'>✦</span>" : "") + "</button>";
    }
    const states = Object.values(this._hass.states || {});
    const sensorLines = states.filter((item) => item.entity_id.startsWith("sensor.") &&
      /tagestyp|erkennungszeit/i.test((item.attributes.friendly_name || "") + " " + item.entity_id))
      .map((item) => "<li>" + this._escape(item.attributes.friendly_name || item.entity_id) + ": " + this._escape(item.state) + "</li>").join("");
    const calendars = this._calendarEntities();
    const preferredCalendar = this._preferredCalendarEntity(calendars);
    const calendarTabOrder = [...calendars].sort((a, b) => {
      if (a.entity_id === preferredCalendar?.entity_id) return -1;
      if (b.entity_id === preferredCalendar?.entity_id) return 1;
      return this._calendarLabel(a).localeCompare(this._calendarLabel(b), locale);
    });
    const calendarTabs = calendarTabOrder.length > 1
      ? "<div class='person-tabs' role='group' aria-label='Kalender auswählen'>" + calendarTabOrder.map((item) =>
          "<button type='button' class='person-tab' data-calendar='" + item.entity_id + "' aria-pressed='" +
          (item.entity_id === this._calendarEntityId ? "true" : "false") + "'>" +
          this._escape(this._calendarLabel(item)) + "</button>"
        ).join("") + "</div>"
      : "";
    const selectedHistory = this._changeHistory(selectedEvent);
    const selectedHistoryMarkup = selectedHistory.length
      ? "<details class='change-history'><summary>Änderungsverlauf (" + selectedHistory.length + ")</summary><ul>" + selectedHistory.map((change) => {
          const displayTime = change.timestamp ? new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(change.timestamp)) : "";
          const who = this._escape(change.changed_by_name || change.changed_by || "Home Assistant");
          const from = this._escape(this._label(change.old_value));
          const to = this._escape(this._label(change.new_value));
          return "<li><time>" + this._escape(displayTime) + "</time> · " + who + ": " + from + " → " + to + "</li>";
        }).join("") + "</ul></details>"
      : "";
    const orderedSelectedDates = [...selectedDates].sort();
    const numericDate = (date) => this._formatDate(date, {
      day: "2-digit", month: "2-digit", year: "numeric",
    });
    const selectionTitle = selectedDateCount > 1
      ? numericDate(orderedSelectedDates[0]) + " bis " + numericDate(orderedSelectedDates.at(-1))
      : this._formatDate(this._selected);
    const selectionSubhead = this._selectionMode === "multiple"
      ? "Der gewählte Tagestyp wird auf alle markierten Tage angewendet."
      : selectedLabel;
    const typeButton = (type, label, icon) =>
      "<button type='button' class='type-option " + (selectedType === type ? "selected-type" : "") +
      "' data-type='" + type + "' aria-pressed='" + (selectedType === type ? "true" : "false") + "'>" +
      "<span class='type-symbol' aria-hidden='true'>" + icon + "</span><span class='type-label'>" + label +
      "</span>" + (selectedType === type ? "<span class='type-check' aria-hidden='true'>✓</span>" : "") + "</button>";
    const typeButtons = [
      typeButton("office", "Arbeitsstätte", "<svg viewBox='0 0 24 24' focusable='false' aria-hidden='true'><path d='M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z'/></svg>"),
      ...(homeOfficeEnabled ? [typeButton("home_office", "Homeoffice", "⌂")] : []),
      typeButton("vacation", "Urlaub", "☀"),
      typeButton("sick_leave", "Krankheit", "+"),
      typeButton("no_work", "Kein Arbeitstag", "—"),
    ].join("");
    const rangeMarkup = this._selectionMode === "range" && selectedDateCount > 1
      ? "<div class='date-range'><label>Von<input data-correction-from type='date' value='" + (this._correctionFrom || this._selected) + "'></label><label>Bis<input data-correction-to type='date' value='" + (this._correctionTo || this._selected) + "'></label></div>"
      : this._selectionMode === "multiple"
        ? "<p class='selection-hint'>" + (selectedDateCount === 0 ? "Keine Tage ausgewählt" : selectedDateCount === 1 ? "1 Tag ausgewählt" : selectedDateCount + " einzelne Tage ausgewählt") + "</p>"
        : "";
    const selectedPanelMarkup = this._selected
      ? "<section class='selection-card' aria-label='Ausgewählten Tag bearbeiten'><header class='selection-card-header'><div><span class='eyebrow'>AUSWAHL</span><h3>" + selectionTitle + "</h3><p class='selection-status'>" + selectionSubhead + "</p></div><span class='selection-count'>" + (selectedDateCount === 1 ? "1 Tag" : selectedDateCount + " Tage") + "</span></header>" + rangeMarkup +
        "<section class='automatic-choice'><button type='button' class='automatic-button " + (selectedType === "automatic" ? "selected-type" : "") + "' data-type='automatic' aria-pressed='" + (selectedType === "automatic" ? "true" : "false") + "'><span class='automatic-icon' aria-hidden='true'>↻</span><span class='automatic-copy'><strong>Zurück zur Automatik</strong><small>Manuelle Änderung zurücksetzen und automatische Erkennung verwenden</small></span><span class='default-badge'>STANDARD</span>" + (selectedType === "automatic" ? "<span class='type-check' aria-hidden='true'>✓</span>" : "") + "</button></section>" +
        "<div class='type-picker'><div class='type-picker-heading'><span class='eyebrow'>MANUELL FESTLEGEN</span></div><div class='type-options'>" + typeButtons + "</div></div>" +
        (selectedHistoryMarkup ? "<div class='selection-history'>" + selectedHistoryMarkup + "</div>" : "") +
        (this._message ? "<p class='message' role='status'>" + this._message + "</p>" : "") + "</section>"
      : "";
    const tab = this._tab;
    const content = tab === "calendar"
      ? (this._calendarEntity() ? "<ha-card>" + calendarTabs + "<div class='calendar-head'><div class='selection-mode-controls'>" + (selectedDateCount > 1 && !this._multiSelectMode ? "<button class='clear-selection' data-action='clear-selection'>Auswahl aufheben</button>" : "<button class='multi-select-toggle' data-action='multi-select' aria-pressed='" + (this._multiSelectMode ? "true" : "false") + "'>" + (this._multiSelectMode ? "Mehrfachauswahl beenden" : "Mehrfachauswahl") + "</button><button class='clear-selection' data-action='clear-selection' " + (selectedDateCount > 2 ? "" : "hidden") + ">Auswahl aufheben</button>") + "</div><h2>" + title + "</h2><div class='calendar-navigation'><button class='today-nav' data-action='today' aria-label='Zum heutigen Datum springen'>Heute</button><div class='month-nav-group' role='group' aria-label='Monat wechseln'><button class='month-nav' data-action='prev' aria-label='Vorheriger Monat'>‹</button><button class='month-nav' data-action='next' aria-label='Nächster Monat'>›</button></div></div></div>" + (selectionFilterVisible ? rangeFilterMarkup : "<div class='stats'>" + monthStatItems.map((item) => "<div class='stat'><span>" + item.label + "</span><strong>" + item.value + "</strong></div>").join("") + "</div>") + historyButtonsMarkup + openReviewMarkup + "<div class='grid'>" + headers + cells + "</div><div class='calendar-legend'><div class='legend-status'><strong>Legende</strong><span><i class='legend-dot office-dot'></i>Arbeitsstätte</span><span><i class='legend-dot home-dot'></i>Homeoffice</span><span><i class='legend-dot vacation-dot'></i>Urlaub</span><span><i class='legend-dot sick-dot'></i>Krankheit</span><span><i class='legend-dot no-work-dot'></i>Kein Arbeitstag</span><span class='legend-divider' aria-hidden='true'></span><span class='legend-pulse'><i class='legend-dot tracking-dot'></i>Erkennung läuft</span><span><i class='mixed-legend-mark'>M</i>Mischtag</span><span><i class='manual-legend-mark' aria-hidden='true'>✦</i>Manuell geändert</span></div></div>" + selectedPanelMarkup + "<p class='muted calendar-help'>Ziehe über mehrere Tage. Umschalt-Klick wählt den Bereich vom Ankertag bis zum Zieltag einschließlich. Mit ⌘ (Mac) oder Strg kannst du einzelne Tage hinzufügen oder abwählen. Mit „Auswahl aufheben“ löschst du die Markierung; „Mehrfachauswahl beenden“ beendet den Modus und hebt die Markierung ebenfalls auf.</p></ha-card>" : calendars.length > 1 ? "<ha-card>" + calendarTabs + "<p>Bitte wähle eine Person aus, um den Kalender zu öffnen.</p></ha-card>" : "<ha-card><p>Es ist noch keine Person für Steuertage eingerichtet.</p></ha-card>")
      : tab === "config" ? this._configMarkup(calendars) : this._exportMarkup(calendars);
    this.shadowRoot.innerHTML = "<style>:host{display:block;height:100vh;height:100dvh;overflow-y:auto;overscroll-behavior:contain;color:var(--steuertage-text,var(--primary-text-color,#202124));background:var(--steuertage-page-background,var(--lovelace-background,var(--primary-background-color,#f5f6f8)));background-attachment:fixed;min-height:100vh;font-family:var(--paper-font-body1_-_font-family,Roboto,Noto,sans-serif)}.page{max-width:1050px;margin:auto;padding:24px}.top{display:flex;align-items:center;gap:14px;margin-bottom:18px;padding:12px 16px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:16px;background:var(--steuertage-card-background,var(--card-background-color));box-shadow:var(--ha-card-box-shadow,0 1px 3px rgba(0,0,0,.06))}.top .top-info-button{margin-left:auto;flex:0 0 36px}.app-mark{width:46px;height:46px;flex:0 0 46px;overflow:hidden;border-radius:12px}.app-mark img{width:100%;height:100%;object-fit:contain}.brand-meta{display:flex;gap:12px;margin-top:5px;color:var(--steuertage-muted,var(--secondary-text-color));font-size:11px}.brand{display:grid;gap:2px}.top h1{font-size:24px;font-weight:500;margin:0}.brand p{margin:0;color:var(--secondary-text-color);font-size:14px}.tabs{display:flex;gap:8px;flex-wrap:wrap;padding:5px;margin:0 0 20px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:14px;background:var(--secondary-background-color,var(--steuertage-card-background));box-shadow:var(--ha-card-box-shadow,0 1px 2px rgba(0,0,0,.05))}.tabs button,.actions button,.month-nav,.today-nav,.multi-select-toggle,.clear-selection{font:inherit;color:var(--primary-text-color);background:var(--ha-card-background,var(--card-background-color,Canvas));border:1px solid var(--divider-color);border-radius:8px;padding:9px 14px;cursor:pointer}.tabs button{border:0;background:transparent}.tabs button.active{color:var(--primary-color);border-color:var(--primary-color);background:var(--steuertage-card-background,var(--card-background-color));box-shadow:0 1px 4px rgba(0,0,0,.12);font-weight:650}.multi-select-toggle[aria-pressed='true']{background:var(--primary-color);color:var(--text-primary-color,#fff);border-color:var(--primary-color);font-weight:600}.selection-mode-controls{display:flex;align-items:center;gap:8px;flex:none}.calendar-history-controls{display:flex;justify-content:flex-end;gap:8px;margin:-5px 0 12px}.history-button{font:inherit;color:var(--secondary-text-color);background:var(--secondary-background-color,var(--card-background-color));border:1px solid var(--divider-color);border-radius:8px;padding:6px 10px;cursor:pointer}.history-button:disabled{opacity:.45;cursor:not-allowed}.history-button span{margin-right:4px;font-size:18px;line-height:1;vertical-align:-1px}.clear-selection{color:var(--secondary-text-color);background:transparent}.clear-selection[hidden]{display:none}.actions button.selected-type{background:var(--primary-color);color:var(--text-primary-color,#fff);border-color:var(--primary-color);font-weight:600;box-shadow:0 0 0 2px var(--primary-color)}.day.range-selected{outline:2px solid var(--primary-color);outline-offset:-3px}.export-check{padding:8px 12px;margin:0 0 14px}.export-check h3{font-size:15px;margin:0 0 4px}.export-check .validation.ok{color:var(--success-color,#2e7d32);font-size:13px;margin:0}.export-check.has-issues{border:1px solid var(--error-color);background:var(--ha-card-background,var(--card-background-color))}.export-check.has-issues h3{color:var(--error-color)}.preset-row{display:flex;flex-wrap:wrap;gap:8px;grid-column:1/-1}.actions button.selected-type{background:var(--primary-color);color:var(--text-primary-color,#fff);border-color:var(--primary-color);font-weight:600;box-shadow:0 0 0 2px var(--primary-color)}.day.range-selected{outline:2px solid var(--primary-color);outline-offset:-3px}.export-check{padding:8px 12px;margin:0 0 14px}.export-check h3{font-size:15px;margin:0 0 4px}.export-check .validation.ok{color:var(--success-color,#2e7d32);font-size:13px;margin:0}.preset-row{display:flex;flex-wrap:wrap;gap:8px;grid-column:1/-1}.view-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin:0 0 20px}.view-header h2{font-size:26px;line-height:1.2;font-weight:650;margin:2px 0 7px;letter-spacing:-.02em}.view-header p{margin:0;color:var(--steuertage-muted,var(--secondary-text-color));font-size:14px;line-height:1.5}.eyebrow{display:block;color:var(--primary-color);font-size:11px;font-weight:700;letter-spacing:.09em;margin-bottom:4px}.header-badge{border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:999px;padding:7px 11px;color:var(--steuertage-muted,var(--secondary-text-color));font-size:12px;white-space:nowrap}.header-actions{display:flex;align-items:center;gap:8px}.info-icon-button,.dialog-close-button{display:grid;place-items:center;width:36px;height:36px;padding:0;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:50%;background:var(--steuertage-card-background,var(--card-background-color));color:var(--steuertage-text,var(--primary-text-color));font:inherit;font-size:20px;line-height:1;cursor:pointer}.info-icon-button:hover,.info-icon-button:focus-visible,.dialog-close-button:hover,.dialog-close-button:focus-visible{border-color:var(--primary-color);outline:2px solid var(--primary-color);outline-offset:2px}.config-info-dialog{width:min(620px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:86vh;margin:auto;padding:0;overflow:auto;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:18px;background:var(--steuertage-card-background,var(--card-background-color,#fff));color:var(--steuertage-text,var(--primary-text-color));box-shadow:0 18px 60px rgba(0,0,0,.3)}.config-info-dialog::backdrop{background:rgba(0,0,0,.46);backdrop-filter:blur(2px)}.config-info-dialog-content{padding:22px}.config-info-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}.config-info-header h3{margin:2px 0;font-size:20px}.config-info-dialog .explanation-card{margin:0;padding:0;border:0;background:transparent;box-shadow:none}.config-info-links{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px;padding-top:16px;border-top:1px solid var(--steuertage-divider,var(--divider-color))}.config-info-links a{display:inline-flex;align-items:center;padding:9px 12px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:10px;color:var(--primary-color);text-decoration:none;font-weight:600}.config-info-links a:hover{border-color:var(--primary-color);background:var(--secondary-background-color,var(--steuertage-card-background))}@media(max-width:600px){.config-info-dialog-content{padding:18px}.config-info-links a{width:100%;justify-content:center}}.config-card{padding:26px;border-radius:18px;background:var(--steuertage-card-background,var(--card-background-color,#fff));box-shadow:var(--ha-card-box-shadow,0 1px 3px rgba(0,0,0,.08))}.config-title{align-items:flex-start}.config-title h3{font-size:18px;font-weight:650}.settings-link{display:inline-flex;align-items:center;gap:6px;border-radius:9px;padding:8px 12px;background:var(--secondary-background-color,var(--primary-background-color));text-decoration:none;font-weight:600}.config-card dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:26px}.config-card dt,.config-card dd,.config-card h3{-webkit-user-select:text;user-select:text}.config-card dl>div{display:flex;flex-direction:column;justify-content:center;gap:11px;min-height:88px;padding:18px 20px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:11px;background:var(--secondary-background-color,var(--steuertage-card-background))}.config-card dt{font-size:12px;line-height:1.4;margin:0;color:var(--steuertage-muted,var(--secondary-text-color))}.config-card dd{font-size:14px;line-height:1.5;font-weight:550;margin:0;overflow-wrap:anywhere}.validation.ok{border-inline-start:3px solid var(--success-color,#43a047)}.validation.warning{border-inline-start:3px solid var(--error-color,#db4437)}.explanation-card{margin-top:20px;padding:20px;border-radius:16px}.export-period{padding:18px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:16px;background:var(--steuertage-card-background,var(--card-background-color,#fff))}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.section-heading h3{margin:0;font-size:17px}.person-picker{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--primary-color);border-radius:12px;background:var(--secondary-background-color,var(--steuertage-card-background));font-weight:650}.person-picker span{font-size:13px;color:var(--steuertage-muted,var(--secondary-text-color))}.person-picker select{min-width:150px;padding:8px 10px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:8px;background:var(--steuertage-card-background,var(--card-background-color));color:var(--steuertage-text,var(--primary-text-color));font:inherit;font-weight:650}.backup-card{margin-top:18px}.backup-card [data-backup]{font-weight:700}.export-controls{margin:12px 0 0}.preset-row{width:100%;padding:4px 0 6px}.preset-row .export-button{border-radius:999px;background:var(--secondary-background-color,var(--steuertage-card-background));font-weight:600}.export-button{transition:transform .14s ease,box-shadow .14s ease,border-color .14s ease}.export-button:hover:not(:disabled){transform:translateY(-1px);border-color:var(--primary-color);box-shadow:0 2px 8px rgba(0,0,0,.12)}.export-stats .stat{border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:14px;padding:16px;background:var(--steuertage-card-background,var(--card-background-color,#fff))}.export-stats .stat strong{font-size:24px}.export-check{border-radius:12px}.disclaimer{border-radius:0 10px 10px 0}.app-disclaimer{margin:24px 2px 8px;padding:12px 2px 0;border-top:1px solid var(--steuertage-divider,var(--divider-color));color:var(--steuertage-muted,var(--secondary-text-color));font-size:11px;line-height:1.55;opacity:.78;text-align:center}@media(max-width:700px){.page{padding:14px}.view-header{gap:8px}.view-header h2{font-size:22px}.header-badge{font-size:11px}.config-card dl{grid-template-columns:1fr}.config-title{flex-direction:column}.export-period{padding:14px}ha-card{padding:16px}}ha-card{display:block;background:var(--steuertage-card-background,var(--ha-card-background,var(--card-background-color,#fff)));color:var(--steuertage-text,var(--primary-text-color,#202124));border:1px solid var(--steuertage-divider,var(--divider-color,#dadce0));border-radius:var(--ha-card-border-radius,16px);padding:24px;box-shadow:var(--ha-card-box-shadow,0 2px 8px rgba(0,0,0,.12))}.calendar-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:16px}.calendar-head h2{flex:1;text-align:center;font-size:20px;font-weight:500;margin:0;text-transform:capitalize}.month-nav-group{display:flex;gap:6px;flex:0 0 auto}.grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}.weekday{text-align:center;color:var(--secondary-text-color);font-size:13px;padding:8px 0}.legend{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:14px;color:var(--secondary-text-color);font-size:13px}.legend span{display:inline-flex;align-items:center;gap:6px}.legend-dot{width:11px;height:11px;border-radius:50%;display:inline-block}.office-dot{background:var(--info-color,#039be5)}.home-dot{background:var(--success-color,#43a047)}.vacation-dot{background:var(--warning-color,#fbc02d)}.sick-dot{background:var(--error-color,#db4437)}.tracking-dot,.automatic-dot{background:#8b5cf6}.no-work-dot{background:var(--divider-color,#9e9e9e)}.weekday.weekend-label{color:var(--secondary-text-color);font-weight:600}.day{position:relative;min-height:44px;border:1px solid var(--divider-color);border-radius:8px;background:var(--card-background-color);color:var(--primary-text-color);font:inherit;cursor:pointer;-webkit-user-select:none;user-select:none}.day.weekend{background:color-mix(in srgb,var(--card-background-color,Canvas) 95%,var(--primary-text-color,#202124) 5%);border-bottom:2px solid var(--divider-color)}.day.outside{opacity:.45}.day.today{box-shadow:inset 0 0 0 2px var(--secondary-text-color,#6b7280)}.day.selected{outline:2px solid var(--primary-color)}.day.mixed .mixed-mark{position:absolute;right:4px;bottom:3px;font-size:8px;line-height:1;font-weight:700;color:var(--secondary-text-color);opacity:.8}.mixed-legend-mark{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:4px;border:1px solid var(--divider-color);font-size:9px;font-style:normal;font-weight:700;color:var(--secondary-text-color)}.mixed-tag{display:inline-block;margin-left:5px;padding:2px 6px;border:1px solid var(--divider-color);border-radius:999px;font-size:10px;font-weight:600;color:var(--secondary-text-color);white-space:nowrap}.day.manual .manual-mark{position:absolute;top:3px;right:4px;font-size:9px;line-height:1;color:var(--secondary-text-color);opacity:.78;pointer-events:none}.manual-legend-mark{display:inline-flex;align-items:center;justify-content:center;font-size:11px;line-height:1;color:var(--secondary-text-color);opacity:.8;font-style:normal}.person-tabs{display:flex;gap:8px;margin:0 0 16px;border-bottom:1px solid var(--divider-color)}.person-tab{font:inherit;color:var(--secondary-text-color);background:transparent;border:0;border-bottom:2px solid transparent;padding:10px 14px;cursor:pointer}.person-tab[aria-pressed='true']{color:var(--primary-color);border-bottom-color:var(--primary-color);font-weight:600}.config-card,.info-card{border:1px solid var(--divider-color);border-radius:10px;padding:16px;margin:14px 0}.config-title{display:flex;justify-content:space-between;align-items:center;gap:12px}.config-title h3,.info-card h3{margin:0 0 8px;font-size:17px;font-weight:500}.config-title a{color:var(--primary-color)}dl{margin:10px 0 0}.config-card dl>div{display:grid;grid-template-columns:minmax(130px,1fr) 2fr;gap:10px;padding:7px 0;border-top:1px solid var(--divider-color)}dt{color:var(--secondary-text-color)}dd{margin:0;overflow-wrap:anywhere}.info-card li{margin:8px 0}.export-controls{display:flex;align-items:end;flex-wrap:wrap;gap:10px;margin:16px 0}.export-controls label{display:grid;gap:5px;color:var(--secondary-text-color)}.export-controls input,.export-controls select,.export-button{font:inherit;color:var(--primary-text-color);background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:7px;padding:9px 12px}.export-controls input[type='date']:hover,.export-controls input[type='date']:focus,.export-controls input[type='date']:focus-visible{outline:2px solid var(--primary-color);outline-offset:2px;border-color:var(--primary-color)}.export-button{cursor:pointer}.export-button:disabled{opacity:.5;cursor:wait}.export-stats{grid-template-columns:repeat(4,minmax(0,1fr));margin-top:16px}.muted{color:var(--secondary-text-color);font-size:13px}.disclaimer{margin-top:16px;padding:12px 14px;border-inline-start:3px solid var(--warning-color,var(--primary-color));background:var(--secondary-background-color,var(--card-background-color,Canvas));color:var(--secondary-text-color);font-size:13px;line-height:1.5}.date-range{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}.date-range label{display:grid;gap:5px;color:var(--secondary-text-color)}.date-range input{font:inherit;color:var(--primary-text-color);background:var(--ha-card-background,var(--card-background-color,Canvas));border:1px solid var(--divider-color);border-radius:7px;padding:8px 10px}.date-range input:focus,.date-range input:focus-visible{outline:2px solid var(--primary-color);outline-offset:2px;border-color:var(--primary-color)}.calendar-help{margin:8px 0 16px;text-align:center;font-size:12px}.selection-instructions{margin:8px 0 12px}.selection-hint{margin:12px 0;padding:10px 12px;border-radius:9px;background:var(--secondary-background-color,var(--card-background-color));font-weight:600}.validation{padding:10px 12px;border-radius:8px;margin-top:12px}.validation.ok{color:var(--success-color,var(--primary-text-color));background:var(--secondary-background-color,var(--card-background-color,Canvas))}.validation.warning{color:var(--error-color,var(--primary-text-color));background:var(--secondary-background-color,var(--card-background-color,Canvas))}.validation ul{margin-bottom:0}.checklist{padding-left:20px}.checklist li{margin:6px 0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--divider-color)}th{color:var(--secondary-text-color);font-weight:500}.needs-review{background:var(--secondary-background-color)}.tracking-row{background:var(--secondary-background-color)}.manual-tag{display:inline-block;border-radius:10px;background:var(--secondary-background-color);padding:2px 7px;font-size:12px;color:var(--secondary-text-color)}.text-button{border:0;background:transparent;color:var(--primary-color);font:inherit;cursor:pointer;padding:0}.change-history{margin-top:12px;color:var(--secondary-text-color)}.change-history ul{padding-left:20px}.change-history time{font-variant-numeric:tabular-nums}.day.type-office,.day.type-office_and_home_office{background:var(--info-color,#039be5);color:var(--text-primary-color,#fff)}.day.type-home_office{background:var(--success-color,#43a047);color:var(--text-primary-color,#fff)}.day.type-vacation{background:var(--warning-color,#fbc02d);color:var(--primary-text-color)}.day.type-sick_leave,.day.type-needs_review{background:var(--error-color,#db4437);color:var(--text-primary-color,#fff)}.day.type-tracking{background:#8b5cf6;color:#fff;animation:steuertage-tracking-pulse 1.8s ease-out infinite}.stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:0 0 16px}.stat{display:flex;flex-direction:column;gap:4px;background:var(--secondary-background-color,var(--card-background-color));border-radius:8px;padding:10px 12px}.stat span{color:var(--secondary-text-color);font-size:12px}.stat strong{font-size:20px;font-weight:500}.selection{border-top:1px solid var(--divider-color);margin-top:20px;padding-top:12px}.selection h3{font-size:17px;margin:0 0 6px}.selection p{color:var(--secondary-text-color)}.actions{display:flex;flex-wrap:wrap;gap:8px}.actions button{padding:8px 10px}.message:empty{display:none}.message{min-height:1em}ha-card>h2{font-weight:500}.page li{margin:8px 0}@media(max-width:600px){.calendar-head{gap:8px}.calendar-head h2{flex-basis:100%;order:-1}.selection-mode-controls{width:100%}.selection-mode-controls .multi-select-toggle{flex:1}.today-nav{flex:0 0 auto}.page{padding:12px}.day{min-height:38px}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.export-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.config-title{align-items:flex-start;flex-direction:column}.grid{gap:3px}.tabs{overflow-x:auto}.tabs button{white-space:nowrap;padding:8px 10px}}.selection-card{margin-top:20px;padding:20px;border:1px solid var(--divider-color);border-radius:14px;background:var(--secondary-background-color,var(--card-background-color,Canvas));box-shadow:var(--ha-card-box-shadow,none)}.selection-card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:16px;border-bottom:1px solid var(--divider-color)}.selection-card-header h3{margin:4px 0;font-size:22px;font-weight:600}.selection-card-header .eyebrow,.type-picker-heading .eyebrow{font-size:10px;letter-spacing:.08em;color:var(--secondary-text-color)}.selection-status{margin:0;color:var(--secondary-text-color);font-size:14px}.selection-count{flex:none;border-radius:999px;padding:6px 10px;background:var(--card-background-color);color:var(--secondary-text-color);font-size:12px;font-weight:600}.automatic-choice{padding:14px 0;border-bottom:1px solid var(--divider-color)}.automatic-button{position:relative;display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:12px 14px;border:1px solid var(--divider-color);border-radius:11px;background:var(--card-background-color);color:var(--primary-text-color);font:inherit;cursor:pointer}.automatic-button.selected-type{border-color:var(--primary-color);box-shadow:0 0 0 2px color-mix(in srgb,var(--primary-color) 18%,transparent);background:var(--primary-color);color:var(--text-primary-color,#fff)}.automatic-icon{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:var(--secondary-background-color,var(--card-background-color));font-size:21px}.automatic-copy{flex:1}.automatic-button strong,.automatic-button small{display:block}.automatic-button small{margin-top:3px;color:var(--secondary-text-color);font-size:12px}.automatic-button.selected-type small{color:inherit;opacity:.82}.default-badge{margin-left:auto;padding:4px 7px;border-radius:999px;background:var(--secondary-background-color,var(--card-background-color));color:var(--secondary-text-color);font-size:9px;font-weight:700;letter-spacing:.05em}.type-check{font-weight:700}.type-picker{padding-top:16px}.type-picker-heading{display:flex;justify-content:space-between;gap:8px;margin-bottom:10px}.shortcut-note{color:var(--secondary-text-color);font-size:11px}.type-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:9px}.type-option{position:relative;display:flex;align-items:center;gap:9px;min-height:50px;padding:10px 12px;border:1px solid var(--divider-color);border-radius:10px;background:var(--card-background-color);color:var(--primary-text-color);font:inherit;text-align:left;cursor:pointer;transition:border-color .15s,background-color .15s,box-shadow .15s}.type-option:hover{border-color:var(--primary-color);box-shadow:0 1px 4px color-mix(in srgb,var(--primary-color) 20%,transparent)}.type-option.selected-type{border:2px solid var(--primary-color);padding:9px 11px;background:var(--primary-color);color:var(--text-primary-color,#fff);font-weight:600}.type-symbol{display:grid;place-items:center;width:27px;height:27px;border-radius:8px;background:var(--secondary-background-color,var(--card-background-color));color:var(--primary-color);font-size:16px}.type-option kbd{margin-left:auto;padding:2px 6px;border:1px solid var(--divider-color);border-radius:5px;background:var(--secondary-background-color,var(--card-background-color));color:var(--secondary-text-color);font-family:inherit;font-size:11px;font-weight:600}.type-option.selected-type kbd{border-color:transparent;background:rgba(255,255,255,.22);color:inherit}.type-option .type-check{margin-left:auto}.selection-history{margin-top:14px}.selection-history .change-history{margin-top:0}.selection-card .message{margin:12px 0 0;padding:9px 11px;border-radius:8px;background:var(--card-background-color);color:var(--secondary-text-color)}.day.type-tracking{background:#8b5cf6;color:#fff;animation:steuertage-tracking-pulse 1.8s ease-out infinite}@keyframes steuertage-tracking-pulse{0%{box-shadow:0 0 0 0 rgba(139,92,246,.55)}70%{box-shadow:0 0 0 7px rgba(139,92,246,0)}100%{box-shadow:0 0 0 0 rgba(139,92,246,0)}}@media(max-width:650px){.page{padding:14px}.top{min-width:0}.brand{min-width:0}.brand-meta{flex-wrap:wrap}.config-card{padding:18px}.config-card dl{grid-template-columns:1fr;gap:10px}.config-card dl>div{min-height:0;padding:14px 16px}.legend-shortcuts small{width:100%;margin-left:0}}.calendar-legend{display:grid;gap:14px;margin:18px 8px 20px;padding:16px 18px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:14px;background:var(--secondary-background-color,var(--steuertage-card-background))}.legend-status{display:flex;align-items:center;flex-wrap:wrap;gap:10px 14px}.legend-status>span{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--steuertage-muted,var(--secondary-text-color))}.legend-status>strong{font-size:12px;color:var(--steuertage-text,var(--primary-text-color))}.legend-status small{margin-left:auto;color:var(--steuertage-muted,var(--secondary-text-color));font-size:11px}.legend-status kbd{min-width:19px;padding:2px 6px;text-align:center;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:5px;background:var(--steuertage-card-background,var(--card-background-color));font:inherit;font-size:11px;font-weight:600}.legend-pulse{font-weight:600}.legend-pulse .tracking-dot{animation:steuertage-tracking-pulse 1.8s ease-out infinite}.legend-status>.legend-divider{display:block;flex:0 0 1px;width:1px;height:16px;background:var(--steuertage-divider,var(--divider-color));opacity:.8}/* Compact, consistent configuration rows */.config-card dl{align-items:start;grid-auto-rows:minmax(0,auto);gap:12px;margin-top:20px}.config-card dl>div{display:grid;grid-template-columns:minmax(125px,.9fr) minmax(0,1.5fr);align-items:start;justify-content:initial;gap:8px 14px;min-height:0;padding:14px 16px}.config-card dt{line-height:1.35}.config-card dd{line-height:1.4}@media(max-width:700px){.config-card dl{grid-template-columns:1fr;gap:9px}.config-card dl>div{grid-template-columns:minmax(115px,.8fr) minmax(0,1.2fr);padding:12px 14px}}@media(prefers-reduced-motion:reduce){.day.type-tracking,.legend-pulse .tracking-dot{animation:none}}@media(max-width:650px){.export-period .section-heading{flex-direction:column;align-items:stretch}.person-picker{width:100%;max-width:100%;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr);gap:6px}.person-picker select{width:100%;min-width:0;max-width:100%;box-sizing:border-box}}.backup-feedback{display:flex;align-items:flex-start;gap:12px;margin-top:16px;padding:16px;border:1px solid var(--divider-color);border-radius:14px;background:var(--secondary-background-color,var(--card-background-color))}.backup-feedback-icon{display:grid;place-items:center;width:28px;height:28px;flex:0 0 28px;border-radius:50%;font-weight:700;background:var(--info-color,#1976d2);color:var(--text-primary-color,#fff)}.backup-feedback.success{border-color:var(--success-color,#2e7d32)}.backup-feedback.success .backup-feedback-icon{background:var(--success-color,#2e7d32)}.backup-feedback.error{border-color:var(--error-color,#c62828)}.backup-feedback.error .backup-feedback-icon{background:var(--error-color,#c62828)}.backup-feedback strong{display:block;margin:2px 0 4px}.backup-feedback p{margin:0 0 10px;color:var(--secondary-text-color);line-height:1.5}.backup-actions{display:flex;flex-wrap:wrap;gap:10px}.restore-dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}.export-button.primary{background:var(--primary-color);color:var(--text-primary-color,#fff);border-color:var(--primary-color);font-weight:600}.dialog-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.48)}.restore-dialog{width:min(560px,100%);max-height:min(90vh,760px);overflow:auto;padding:24px;border:1px solid var(--divider-color);border-radius:18px;background:var(--card-background-color,var(--primary-background-color,Canvas));color:var(--primary-text-color);box-shadow:0 18px 60px rgba(0,0,0,.28)}.restore-dialog h3{font-size:22px;margin:4px 0 12px}.restore-summary{padding:12px 14px;border-radius:12px;background:var(--secondary-background-color,var(--primary-background-color));line-height:1.55}.restore-options{display:grid;gap:10px;margin:18px 0 0;padding:14px;border:1px solid var(--divider-color);border-radius:14px}.restore-options legend{padding:0 6px;font-weight:600}.restore-option{display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--divider-color);border-radius:12px;cursor:pointer}.restore-option:has(input:checked){border-color:var(--primary-color);box-shadow:0 0 0 1px var(--primary-color)}.restore-option input{margin:3px 0 0;accent-color:var(--primary-color)}.restore-option span{display:grid;gap:4px}.restore-option small{color:var(--secondary-text-color);line-height:1.45}.restore-progress{color:var(--primary-color);font-weight:600}.open-review-card{display:grid;gap:10px;margin:16px 0;padding:14px 16px;border:1px solid var(--divider-color);border-radius:14px;background:var(--secondary-background-color,var(--card-background-color))}.open-review-heading{display:flex;align-items:center;justify-content:space-between}.open-review-heading>div{display:grid;gap:3px}.open-review-heading strong{font-size:15px}.open-review-count{display:grid;place-items:center;min-width:30px;height:30px;padding:0 8px;border-radius:16px;background:var(--warning-color,#ed9b00);color:var(--text-primary-color,#fff);font-weight:700}.open-review-days{display:flex;flex-wrap:wrap;gap:8px}.review-day-chip{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--divider-color);border-radius:10px;color:var(--primary-text-color);background:var(--card-background-color);font:inherit;text-align:left;cursor:pointer}.review-day-chip small{color:var(--secondary-text-color)}.review-day-chip.needs-review{border-color:var(--error-color,#c62828)}.review-day-chip.tracking{border-color:var(--primary-color)}.review-more{align-self:center;color:var(--secondary-text-color);font-size:13px}.open-review-card.all-clear{display:flex;align-items:center;gap:10px;color:var(--success-color,#2e7d32)}.open-review-card.all-clear strong,.open-review-card.all-clear small{display:block}.open-review-card.all-clear small{margin-top:3px;color:var(--secondary-text-color)}.open-review-check{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--success-color,#2e7d32);color:var(--text-primary-color,#fff);font-weight:700}@media(max-width:600px){.restore-dialog{padding:18px}.restore-dialog-actions{flex-direction:column-reverse}.restore-dialog-actions button{width:100%}}.app-disclaimer{display:grid;justify-items:center;gap:5px;max-width:820px;margin:30px auto 12px;padding:16px 14px 4px;border-top:1px solid var(--steuertage-divider,var(--divider-color));color:var(--steuertage-muted,var(--secondary-text-color));font-size:11px;line-height:1.55;opacity:.82;text-align:center}.app-disclaimer p{margin:0}.disclaimer-label{font-size:10px;font-weight:700;letter-spacing:.1em}.disclaimer-caveat{font-weight:600}.calendar-head{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;justify-content:initial;flex-wrap:initial}.selection-mode-controls{grid-column:1;justify-self:start;min-width:0}.calendar-head h2{grid-column:2;min-width:max-content;flex:none}.calendar-navigation{grid-column:3;justify-self:end;display:flex;align-items:center;gap:6px}.data-disclosure{margin:12px 0;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:14px;background:var(--secondary-background-color,var(--steuertage-card-background,var(--card-background-color)))}.data-disclosure>summary{display:grid;grid-template-columns:minmax(0,1fr) clamp(100px,30vw,140px) 16px;align-items:center;gap:12px;padding:15px 18px;cursor:pointer;font-weight:600;list-style:none}.data-disclosure>summary::-webkit-details-marker{display:none}.data-disclosure>summary:after{content:'⌄';justify-self:end;color:var(--secondary-text-color);font-size:18px;transition:transform .16s ease}.data-disclosure[open]>summary:after{transform:rotate(180deg)}.data-disclosure>summary small{margin:0;color:var(--secondary-text-color);font-size:12px;font-weight:500;text-align:center}.data-disclosure[open]>summary{border-bottom:1px solid var(--steuertage-divider,var(--divider-color))}.disclosure-content{padding:4px 16px 16px}.disclosure-content>p:first-child{margin-top:12px}.change-log-list{display:grid;gap:8px;margin:12px 0 0;padding:0;list-style:none}.change-log-list li{display:flex;align-items:center;padding:11px 12px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:10px}.change-log-list li span{display:grid;gap:4px}.change-log-list small{color:var(--secondary-text-color)}@media(max-width:600px){.calendar-head{grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:6px}.selection-mode-controls{width:auto}.calendar-head h2{grid-column:2;flex-basis:auto;font-size:16px}.calendar-navigation{gap:4px}.app-disclaimer{margin-top:24px;padding-inline:6px}.data-disclosure>summary{padding:13px 14px;grid-template-columns:minmax(0,1fr) clamp(94px,30vw,120px) 16px}.disclosure-content{padding:4px 10px 12px}}.range-filter{display:grid;gap:10px;margin:14px 0;padding:14px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:14px;background:var(--secondary-background-color,var(--steuertage-card-background,var(--card-background-color)))}.range-filter-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.range-filter-heading>div:first-child{display:grid;gap:3px}.range-filter-heading small,.range-filter>small{color:var(--secondary-text-color);font-size:12px}.range-filter-presets,.range-weekday-options{display:flex;flex-wrap:wrap;gap:6px}.range-filter button{font:inherit;color:var(--primary-text-color);border:1px solid var(--divider-color);border-radius:999px;background:var(--card-background-color);padding:6px 10px;cursor:pointer}.range-weekday.active{border-color:var(--primary-color);background:var(--primary-color);color:var(--text-primary-color,#fff)}@media(max-width:600px){.range-filter-heading{align-items:flex-start;flex-direction:column}.range-filter-presets{width:100%}.range-filter-presets button{flex:1}.range-weekday-options{justify-content:space-between}}.top .data-management-button{margin-left:auto;flex:0 0 36px}.top .top-info-button{margin-left:0;flex:0 0 36px}.data-management-dialog{width:min(680px,calc(100vw - 32px));max-width:none;max-height:min(90dvh,900px);margin:auto;padding:0;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:20px;background:var(--steuertage-card-background,var(--card-background-color));color:var(--steuertage-text,var(--primary-text-color));box-shadow:var(--ha-card-box-shadow,0 16px 48px rgba(0,0,0,.28));overflow:auto}.data-management-dialog::backdrop{background:rgba(0,0,0,.48);backdrop-filter:blur(2px)}.data-management-content{padding:24px}.data-management-header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}.data-management-header h2{margin:4px 0;font-size:22px}.data-management-header p{margin:4px 0;color:var(--secondary-text-color);line-height:1.45}.data-management-header .dialog-close-button{flex:0 0 auto}.data-management-dialog .backup-card,.restore-review-card{display:grid;gap:12px;padding:18px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:14px;background:var(--secondary-background-color,var(--card-background-color))}.data-management-dialog .backup-card p,.restore-review-card p{margin:0;line-height:1.55}.data-management-dialog .backup-actions{margin-top:4px}.backup-launch{display:flex;justify-content:flex-end;margin:20px 0}.data-management-dialog .restore-options{margin:8px 0}.data-management-dialog .restore-dialog-actions{margin-top:16px}@media(max-width:600px){.data-management-content{padding:18px}.data-management-header h2{font-size:19px}.data-management-dialog .backup-actions{display:grid}.data-management-dialog .backup-actions button{width:100%}.data-management-dialog .restore-dialog-actions{flex-direction:column-reverse}.data-management-dialog .restore-dialog-actions button{width:100%}}.type-symbol svg{display:block;width:17px;height:17px;fill:currentColor}@media(max-width:650px){.top{display:grid;grid-template-columns:36px 40px minmax(0,1fr);grid-template-rows:auto auto;align-items:center;gap:8px 10px;padding:12px}.top ha-menu-button{grid-column:1;grid-row:1}.top .app-mark{grid-column:2;grid-row:1;width:40px;height:40px;flex:0 0 40px}.top .brand{grid-column:3;grid-row:1;min-width:0;gap:3px}.top .brand h1{font-size:20px;line-height:1.15}.top .brand p{font-size:12px;line-height:1.35}.top .brand-meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:10px}.top .data-management-button{grid-column:2;grid-row:2;justify-self:end;margin:0;flex:0 0 36px}.top .top-info-button{grid-column:3;grid-row:2;justify-self:end;margin:0;flex:0 0 36px}}</style><div class='page'><div class='top'><ha-menu-button></ha-menu-button><div class='app-mark'><img src='/steuertage_brand/icon.png?v=" + encodeURIComponent(this._panel?.config?.version || "") + "' alt='' loading='lazy'></div><div class='brand'><h1>Steuertage</h1><p>Arbeitsstätte- und Homeoffice-Tage für die Steuererklärung erfassen.</p><div class='brand-meta'><span>Version " + this._escape(this._panel?.config?.version || "Beta") + "</span><span>Entwickelt von mongrelX15</span></div></div><button type='button' class='info-icon-button data-management-button' data-action='data-management-open' aria-label='Sicherung und Wiederherstellung öffnen' title='Datenverwaltung'>⚙</button><button type='button' class='info-icon-button top-info-button' data-action='config-info' aria-label='Funktionsweise anzeigen' title='Funktionsweise anzeigen'>ⓘ</button></div><div class='tabs'><button data-tab='calendar' class='" + (tab === "calendar" ? "active" : "") + "'>Kalender</button><button data-tab='config' class='" + (tab === "config" ? "active" : "") + "'>Konfiguration</button><button data-tab='export' class='" + (tab === "export" ? "active" : "") + "'>Daten &amp; Export</button></div>" + content + this._configInfoMarkup() + this._dataManagementMarkup(calendars) + "<footer class='app-disclaimer'>" + "<span class='disclaimer-label'>HINWEIS</span><p>" + this._escape("Steuertage unterstützt die automatische Erfassung relevanter Daten auf Grundlage der in Home Assistant vorhandenen Erkennung.") + "</p><p>" + this._escape("Für Richtigkeit und Vollständigkeit Ihrer Steuererklärung tragen Sie die volle Verantwortung.") + "</p><span class='disclaimer-caveat'>Alle Angaben ohne Gewähr.</span></footer></div>";
    const menu = this.shadowRoot.querySelector("ha-menu-button");
    if (menu) menu.hass = this._hass;
    this.shadowRoot.querySelectorAll("details[data-disclosure-id]").forEach((details) => details.addEventListener("toggle", () => {
      if (details.open) this._openDisclosures.add(details.dataset.disclosureId);
      else this._openDisclosures.delete(details.dataset.disclosureId);
    }));
    this.shadowRoot.querySelectorAll("[data-range-preset]").forEach((button) => button.addEventListener("click", () => {
      this._setRangeWeekdays(button.dataset.rangePreset === "weekdays" ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6]);
    }));
    this.shadowRoot.querySelectorAll("[data-range-weekday]").forEach((button) => button.addEventListener("click", () => {
      const days = new Set(this._rangeWeekdays());
      const day = Number(button.dataset.rangeWeekday);
      if (days.has(day) && days.size === 1) return;
      if (days.has(day)) days.delete(day); else days.add(day);
      this._setRangeWeekdays(days);
    }));
    this.shadowRoot.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
      this._tab = button.dataset.tab;
      this._render();
      if (this._tab === "calendar") this._loadEvents();
      if (this._tab === "export") this._loadExportEvents();
    }));
    this.shadowRoot.querySelectorAll("[data-action='data-management-open'], [data-open-data-management]").forEach((button) => button.addEventListener("click", () => {
      this._dataManagementOpen = true;
      this._render();
    }));
    const dataManagementDialog = this.shadowRoot.querySelector("[data-data-management-dialog]");
    if (this._dataManagementOpen && dataManagementDialog && !dataManagementDialog.open) dataManagementDialog.showModal();
    this.shadowRoot.querySelector("[data-action='data-management-close']")?.addEventListener("click", () => {
      this._dataManagementOpen = false;
      dataManagementDialog?.close();
    });
    dataManagementDialog?.addEventListener("click", (event) => {
      if (event.target === dataManagementDialog) {
        this._dataManagementOpen = false;
        dataManagementDialog.close();
      }
    });
    dataManagementDialog?.addEventListener("close", () => {
      if (dataManagementDialog.isConnected) this._dataManagementOpen = false;
    });
    const configInfoDialog = this.shadowRoot.querySelector("[data-config-info-dialog]");
    this.shadowRoot.querySelector("[data-action='config-info']")?.addEventListener("click", () => {
      configInfoDialog?.showModal();
    });
    this.shadowRoot.querySelector("[data-action='config-info-close']")?.addEventListener("click", () => {
      configInfoDialog?.close();
    });
    configInfoDialog?.addEventListener("click", (event) => {
      if (event.target === configInfoDialog) configInfoDialog.close();
    });
    this._dragSelecting = false;
    this._dragStartDate = "";
    this._dragMoved = false;
    this.shadowRoot.querySelectorAll("[data-date]").forEach((button) => {
      button.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        this._dragMoved = false;
        const multiGesture = this._multiSelectMode && !event.metaKey && !event.ctrlKey && !event.shiftKey;
        if (!multiGesture && (event.metaKey || event.ctrlKey || event.shiftKey)) {
          this._dragSelecting = false;
          return;
        }
        this._dragSelecting = true;
        this._dragStartDate = button.dataset.date;
        this._dragMultiGesture = multiGesture;
        if (multiGesture) this._rangeSelectionBounds = null;
        this._dragMultiAction = multiGesture
          ? (this._selectedDates.has(button.dataset.date) ? "remove" : "add")
          : null;
        this._dragBaseDates = new Set(this._selectedDates || []);
        this._dragStartApplied = false;
        this._dragPointerId = event.pointerId;
        if (multiGesture) {
          this._selectionMode = "multiple";
          this._selected = button.dataset.date;
        } else {
          this._rangeAnchorDate = button.dataset.date;
          this._rangeSelectionBounds = { from: button.dataset.date, to: button.dataset.date, target: button.dataset.date };
          this._selected = button.dataset.date;
          this._selectionMode = "single";
          this._selectedDates = new Set([button.dataset.date]);
          this._correctionFrom = button.dataset.date;
          this._correctionTo = button.dataset.date;
        }
        const updateDragDate = (date) => {
          if (!this._dragSelecting || !date) return;
          if (date !== this._dragStartDate) this._dragMoved = true;
          if (this._dragMultiGesture) {
            if (!this._dragStartApplied) {
              this._applyMultiDragDate(this._dragStartDate);
              this._dragStartApplied = true;
            }
            this._applyMultiDragDate(date);
            return;
          }
          this._applyFilteredRange(this._dragStartDate, date, date);
          this._updateVisibleDateSelection(this._selectedDates);
        };
        const moveDrag = (moveEvent) => {
          if (!this._dragSelecting || moveEvent.pointerId !== this._dragPointerId) return;
          const dateCell = [...this.shadowRoot.querySelectorAll("[data-date]")].find((cell) => {
            const rect = cell.getBoundingClientRect();
            return moveEvent.clientX >= rect.left && moveEvent.clientX <= rect.right &&
              moveEvent.clientY >= rect.top && moveEvent.clientY <= rect.bottom;
          });
          updateDragDate(dateCell?.dataset.date);
        };
        const finishDrag = (finishEvent) => {
          window.removeEventListener("pointermove", moveDrag);
          window.removeEventListener("pointerup", finishDrag);
          window.removeEventListener("pointercancel", finishDrag);
          if (finishEvent.pointerId !== this._dragPointerId) return;
          this._dragPointerId = null;
          if (!this._dragSelecting) return;
          this._dragSelecting = false;
          if (finishEvent.type === "pointercancel") this._dragMoved = false;
          else if (this._dragMoved) setTimeout(() => this._render(), 0);
        };
        window.addEventListener("pointermove", moveDrag, { passive: true });
        window.addEventListener("pointerup", finishDrag);
        window.addEventListener("pointercancel", finishDrag);
      });
      button.addEventListener("pointerenter", () => {
        if (!this._dragSelecting) return;
        const date = button.dataset.date;
        if (date !== this._dragStartDate) this._dragMoved = true;
        if (this._dragMultiGesture) {
          if (!this._dragStartApplied) {
            this._applyMultiDragDate(this._dragStartDate);
            this._dragStartApplied = true;
          }
          this._applyMultiDragDate(date);
          return;
        }
        this._applyFilteredRange(this._dragStartDate, date, date);
        this._updateVisibleDateSelection(this._selectedDates);
      });
      button.addEventListener("click", (event) => {
        const date = button.dataset.date;
        if (this._dragMoved) { setTimeout(() => { this._dragMoved = false; }, 0); return; }
        if (event.shiftKey) {
          const anchor = this._rangeAnchorDate || this._selected || date;
          this._applyFilteredRange(anchor, date, date);
          this._render();
          return;
        }
        if (this._multiSelectMode && !event.shiftKey) {
          const dates = new Set(this._selectedDates);
          if (dates.has(date)) dates.delete(date);
          else dates.add(date);
          const ordered = [...dates].sort();
          this._selectedDates = dates;
          this._selectionMode = "multiple";
          this._selected = dates.has(date) ? date : ordered.at(-1) || null;
          this._correctionFrom = ordered[0] || "";
          this._correctionTo = ordered.at(-1) || "";
          this._render();
          return;
        }
        if (event.metaKey || event.ctrlKey) {
          const dates = new Set(this._selectedDates);
          if (dates.has(date)) dates.delete(date);
          else dates.add(date);
          this._selectedDates = dates;
          this._selectionMode = dates.size > 1 ? "multiple" : "single";
          this._selected = dates.has(date) ? date : [...dates].sort().at(-1) || null;
          this._correctionFrom = dates.size ? [...dates].sort()[0] : "";
          this._correctionTo = dates.size ? [...dates].sort().at(-1) : "";
          this._render();
          return;
        }
        if (this._dragMoved) { setTimeout(() => { this._dragMoved = false; }, 0); return; }
        this._selected = date;
        this._rangeAnchorDate = date;
        this._rangeSelectionBounds = null;
        this._selectionMode = "single";
        this._selectedDates = new Set([date]);
        this._multiSelectMode = false;
        this._correctionFrom = date;
        this._correctionTo = date;
        this._render();
      });
    });
    this.shadowRoot.querySelector("[data-action='prev']")?.addEventListener("click", () => {
      this._month = new Date(this._month.getFullYear(), this._month.getMonth() - 1, 1);
      this._selected = null;
      this._rangeAnchorDate = null;
      this._selectedDates = new Set();
      this._selectionMode = "single";
      this._loadedMonth = "";
      this._render();
      this._loadEvents();
    });
    this.shadowRoot.querySelector("[data-action='multi-select']")?.addEventListener("click", () => {
      if (this._multiSelectMode) {
        this._multiSelectMode = false;
        this._selectionMode = "single";
        this._selected = null;
        this._selectedDates = new Set();
        this._rangeAnchorDate = null;
        this._correctionFrom = "";
        this._correctionTo = "";
      } else {
        this._multiSelectMode = true;
        this._selectionMode = "multiple";
      }
      this._render();
    });
    this.shadowRoot.querySelector("[data-action='clear-selection']")?.addEventListener("click", () => {
      this._selected = null;
      this._selectedDates = new Set();
      this._rangeAnchorDate = null;
      this._selectionMode = "single";
      this._multiSelectMode = false;
      this._correctionFrom = "";
      this._correctionTo = "";
      this._render();
    });
    this.shadowRoot.querySelector("[data-action='undo']")?.addEventListener("click", () => this._applyEditHistory("undo"));
    this.shadowRoot.querySelector("[data-action='redo']")?.addEventListener("click", () => this._applyEditHistory("redo"));
    this.shadowRoot.querySelector("[data-action='today']")?.addEventListener("click", () => {
      const today = new Date();
      const currentMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      if (this._isoDate(currentMonth) !== this._isoDate(this._month)) this._loadedMonth = "";
      this._month = currentMonth;
      this._selected = this._isoDate(today);
      this._rangeAnchorDate = this._selected;
      this._selectedDates = new Set([this._selected]);
      this._selectionMode = "single";
      this._correctionFrom = this._selected;
      this._correctionTo = this._selected;
      this._render();
      this._loadEvents();
    });
    this.shadowRoot.querySelector("[data-action='next']")?.addEventListener("click", () => {
      this._month = new Date(this._month.getFullYear(), this._month.getMonth() + 1, 1);
      this._selected = null;
      this._rangeAnchorDate = null;
      this._selectedDates = new Set();
      this._selectionMode = "single";
      this._loadedMonth = "";
      this._render();
      this._loadEvents();
    });
    this.shadowRoot.querySelectorAll("[data-calendar]").forEach((button) => button.addEventListener("click", async () => {
      const nextCalendar = button.dataset.calendar;
      if (nextCalendar === this._calendarEntityId) return;
      this._calendarEntityId = nextCalendar;
      this._calendarInitialized = true;
      this._loadedMonth = "";
      this._events = [];
      this._selected = null;
      this._rangeAnchorDate = null;
      this._selectedDates = new Set();
      this._selectionMode = "single";
      this._render();
      await this._loadEvents();
    }));
    this.shadowRoot.querySelectorAll("[data-period]").forEach((button) => button.addEventListener("click", () => {
      const today = new Date();
      let start, end;
      if (button.dataset.period === "year") {
        const year = Number(button.dataset.year);
        this._exportYear = year; start = new Date(year, 0, 1); end = new Date(year, 11, 31);
      } else if (button.dataset.period === "month") {
        start = new Date(today.getFullYear(), today.getMonth(), 1);
        end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      } else {
        const offset = (today.getDay() + 6) % 7;
        start = new Date(today); start.setDate(today.getDate() - offset);
        end = new Date(start); end.setDate(start.getDate() + 6);
      }
      this._exportFrom = this._isoDate(start); this._exportTo = this._isoDate(end);
      this._exportYear = Number(this._exportFrom.slice(0, 4));
      this._exportKey = ""; this._exportEvents = null;
      const fromInput = this.shadowRoot.querySelector("[data-export-from]");
      const toInput = this.shadowRoot.querySelector("[data-export-to]");
      if (fromInput) fromInput.value = this._exportFrom;
      if (toInput) toInput.value = this._exportTo;
      this._loadExportEvents();
    }));
    ["[data-export-from]", "[data-export-to]"].forEach((selector) => {
      this.shadowRoot.querySelector(selector)?.addEventListener("change", () => {
        const from = this.shadowRoot.querySelector("[data-export-from]")?.value;
        const to = this.shadowRoot.querySelector("[data-export-to]")?.value;
        if (!from || !to || to < from) { this._showMessage("Bitte prüfe den ausgewählten Exportzeitraum."); return; }
        this._exportFrom = from; this._exportTo = to;
        this._exportYear = Number(from.slice(0, 4));
        this._exportKey = ""; this._exportEvents = null; this._loadExportEvents();
      });
    });
    this.shadowRoot.querySelector("[data-export-calendar]")?.addEventListener("change", (event) => {
      this._calendarEntityId = event.target.value; this._calendarInitialized = true;
      this._loadedMonth = ""; this._events = []; this._exportKey = ""; this._exportEvents = null;
      this._selected = null; this._render();
      if (this._tab === "calendar") this._loadEvents();
      if (this._tab === "export") this._loadExportEvents();
    });
    this.shadowRoot.querySelectorAll("[data-download]").forEach((button) => button.addEventListener("click", () => this._downloadExport(button.dataset.download)));
    this.shadowRoot.querySelector("[data-backup]")?.addEventListener("click", () => this._downloadBackup());
    this.shadowRoot.querySelector("[data-save-backup]")?.addEventListener("click", () => this._savePreparedBackup());
    this.shadowRoot.querySelector("[data-restore]")?.addEventListener("click", () => this.shadowRoot.querySelector("[data-restore-file]")?.click());
    this.shadowRoot.querySelector("[data-restore-file]")?.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      await this._prepareRestore(file);
      event.target.value = "";
    });
    this.shadowRoot.querySelector("[data-restore-cancel]")?.addEventListener("click", () => this._cancelRestore());
    this.shadowRoot.querySelector("[data-restore-confirm]")?.addEventListener("click", () => this._restoreBackup());
    this.shadowRoot.querySelectorAll("[data-review-date]").forEach((button) => button.addEventListener("click", () => {
      const parts = button.dataset.reviewDate.split("-").map(Number);
      this._month = new Date(parts[0], parts[1] - 1, 1); this._selected = button.dataset.reviewDate;
      this._rangeAnchorDate = this._selected;
      this._selectedDates = new Set([button.dataset.reviewDate]); this._selectionMode = "single";
      this._correctionFrom = button.dataset.reviewDate; this._correctionTo = button.dataset.reviewDate;
      this._tab = "calendar"; this._loadedMonth = ""; this._render(); this._loadEvents();
    }));
    this.shadowRoot.querySelectorAll("[data-type]").forEach((button) => button.addEventListener("click", async () => {
      if (this._busy) return;
      const selectedCalendar = this._calendarEntity();
      const personEntity = selectedCalendar?.attributes.worklog_person_entity;
      const fromValue = this.shadowRoot.querySelector("[data-correction-from]")?.value || this._selected;
      const toValue = this.shadowRoot.querySelector("[data-correction-to]")?.value || fromValue;
      const start = new Date(fromValue + "T12:00:00");
      const end = new Date(toValue + "T12:00:00");
      let days = [];
      if (!fromValue || !toValue || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
        this._showMessage("Bitte prüfe den ausgewählten Zeitraum.");
        return;
      }
      if (this._selectionMode === "multiple" || this._rangeSelectionBounds) {
        days = [...(this._selectedDates || [])].sort();
      } else {
        for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
          days.push(this._isoDate(cursor));
          if (days.length > 366) {
            this._showMessage("Ein Zeitraum darf höchstens 366 Tage umfassen.");
            return;
          }
        }
      }
      if (!days.length || days.length > 366) {
        this._showMessage("Wähle mindestens einen und höchstens 366 Tage aus.");
        return;
      }
      const operation = {
        days: days.map((date) => ({
          date,
          before: this._manualOverrideForDate(date),
          after: button.dataset.type,
        })).filter((item) => item.before !== item.after),
      };
      if (!operation.days.length) {
        this._showMessage("Für die ausgewählten Tage ist keine Änderung nötig.");
        return;
      }
      const appliedDays = [];
      this._busy = true;
      this._message = "Speichere " + operation.days.length + (operation.days.length === 1 ? " Tag …" : " Tage …");
      this._render();
      try {
        for (const day of operation.days) {
          await this._hass.callService("steuertage", "set_day_override", {
            person_entity: personEntity,
            date: day.date,
            day_type: day.after,
          });
          appliedDays.push(day);
        }
        const editHistory = this._editHistoryForCurrentPerson();
        editHistory.undo.push(operation);
        if (editHistory.undo.length > 50) editHistory.undo.shift();
        editHistory.redo = [];
        this._correctionFrom = fromValue;
        this._correctionTo = toValue;
        this._loadedMonth = "";
        await this._loadEvents();
        this._showMessage(operation.days.length === 1 ? "Änderung gespeichert." : operation.days.length + " Tage wurden aktualisiert.");
      } catch (error) {
        if (appliedDays.length) {
          const editHistory = this._editHistoryForCurrentPerson();
          editHistory.undo.push({ days: appliedDays });
          if (editHistory.undo.length > 50) editHistory.undo.shift();
          editHistory.redo = [];
          this._loadedMonth = "";
          await this._loadEvents();
        }
        this._showMessage("Änderung konnte nicht vollständig gespeichert werden. Bereits gespeicherte Tage kannst du rückgängig machen.");
      } finally {
        this._busy = false;
        this._render();
      }
    }));
  }
}

customElements.define("steuertage-panel", SteuertagePanel);
