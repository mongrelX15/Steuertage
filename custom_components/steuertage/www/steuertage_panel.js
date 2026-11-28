const TRACKING_STATUS_LABEL = "Erkennung läuft – bitte warten";

class SteuertagePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "calendar";
    this._month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    this._calendarEntityId = null;
    this._activeUserId = null;
    this._calendarInitialized = false;
    this._calendarSignature = "";
    this._hasReceivedHass = false;
    this._haThemeVariables = new Set();
    this._events = [];
    this._holidayRequestKey = "";
    this._holidayRegionKey = "";
    this._holidayDates = {};
    this._loadedMonth = "";
    this._busy = false;
    this._siteQueue = Promise.resolve();
    this._pendingSiteEdits = 0;
    this._historicalSites = null;
    this._historicalRequest = null;
    this._historicalStatus = "";
    this._message = "";
    this._messageTimer = undefined;
    this._backupNotice = null;
    this._preparedBackup = null;
    this._pendingRestore = null;
    this._backupRestoring = false;
    this._automaticBackups = null;
    this._styles = this.shadowRoot.appendChild(document.createElement("style"));
    this._view = this.shadowRoot.appendChild(document.createElement("div"));
    this._dialogs = new Map();
    this._unsubscribe = undefined;
    this._exportEvents = null;
    this._exportKey = "";
    this._exportUnsubscribe = undefined;
    this._exportYear = new Date().getFullYear();
    this._exportFrom = this._exportYear + "-01-01";
    this._exportTo = this._exportYear + "-12-31";
    this._multiSelectMode = false;
    this._clearDateSelection();
    this._rangeWeekdaySettings = new Map();
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
      JSON.stringify(item.attributes.worklog_homeoffice_years || []),
      item.attributes.worklog_home_zone_entity,
      item.attributes.worklog_device_tracker,
      item.attributes.worklog_legacy_signal,
      (item.attributes.worklog_office_zone_entities || [item.attributes.worklog_office_zone_entity]).join(","),
      JSON.stringify(item.attributes.worklog_office_sites || []),
      item.attributes.worklog_threshold_hours,
      item.attributes.worklog_work_calendar_entity,
      item.attributes.worklog_holiday_country,
      item.attributes.worklog_holiday_subdivision,
    ].join(":")).join("|");
    const initial = !this._hasReceivedHass;
    const listChanged = signature !== this._calendarSignature;
    let selectionChanged = false;

    if (userChanged && this._hasReceivedHass) {
      const calendar = this._preferredCalendarEntity(calendars);
      this._calendarEntityId = calendar?.entity_id || null;
      this._calendarInitialized = true;
      this._historicalSites = null;
      this._historicalRequest = null;
      this._historicalStatus = "";
      this._loadedMonth = "";
      this._events = [];
      this._exportEvents = null;
      this._exportKey = "";
      this._clearDateSelection();
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
    } else if (this._tab === "export" && (listChanged || selectionChanged)) {
      this._loadExportEvents();
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

  _holidayRegion() {
    const attrs = this._calendarEntity()?.attributes;
    const country = attrs?.worklog_holiday_country;
    const subdivision = attrs?.worklog_holiday_subdivision || "";
    return country ? { country, subdivision, key: country + ":" + subdivision } : null;
  }

  async _loadHolidays() {
    const region = this._holidayRegion();
    const connection = this._hass?.connection;
    if (!region || !connection) {
      this._holidayRequestKey = "";
      return;
    }
    const year = this._month.getFullYear();
    const key = region.key + ":" + year;
    if (key === this._holidayRequestKey) return;
    this._holidayRequestKey = key;
    try {
      const dates = await connection.sendMessagePromise({
        type: "steuertage/holidays", country: region.country, subdivision: region.subdivision, year,
      });
      if (this._holidayRequestKey !== key) return;
      this._holidayRegionKey = region.key;
      this._holidayDates = dates;
      if (this._tab === "calendar") this._render({ preserveEditorPosition: true });
    } catch {
      if (this._holidayRequestKey === key) this._holidayRequestKey = "";
    }
  }

  async _loadEvents({ refresh = false } = {}) {
    this._loadHolidays();
    const entityId = this._calendarEntity()?.entity_id;
    const monthKey = entityId + ":" + this._isoDate(this._month);
    const sameMonth = this._loadedMonth === monthKey;
    if (entityId && (!this._hass?.connection || (sameMonth && !refresh))) return;

    // Keep the current calendar visible until the refreshed subscription responds.
    const keepEvents = refresh && sameMonth;
    const request = Symbol();
    this._calendarRequest = request;
    const unsubscribe = this._unsubscribe;
    this._unsubscribe = undefined;
    this._loadedMonth = entityId ? monthKey : "";
    if (!keepEvents) {
      this._events = [];
      this._render();
    }

    try {
      await unsubscribe?.();
      if (!entityId || this._calendarRequest !== request) return;

      const start = new Date(this._month.getFullYear(), this._month.getMonth(), 1);
      const mondayOffset = (start.getDay() + 6) % 7;
      start.setDate(start.getDate() - mondayOffset);
      const end = new Date(start);
      end.setDate(end.getDate() + 42);
      const nextUnsubscribe = await this._hass.connection.subscribeMessage(
        (message) => {
          if (this._calendarRequest !== request || this._calendarEntityId !== entityId) return;
          this._events = Array.isArray(message?.events)
            ? message.events
            : Array.isArray(message?.event?.events)
              ? message.event.events
              : [];
          if (!this._pendingSiteEdits) this._render({ preserveEditorPosition: keepEvents });
        },
        {
          type: "calendar/event/subscribe",
          entity_id: entityId,
          start: start.toISOString(),
          end: end.toISOString(),
        }
      );
      if (this._calendarRequest === request) this._unsubscribe = nextUnsubscribe;
      else await nextUnsubscribe();
    } catch (error) {
      if (this._calendarRequest !== request) return;
      this._loadedMonth = "";
      this._message = "Der Kalender konnte nicht geladen werden.";
      this._render({ preserveEditorPosition: keepEvents });
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
    if (summary.includes("dienstreise")) return "business_trip";
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
      business_trip: "Dienstreise",
      vacation: "Urlaub",
      sick_leave: "Krankheit",
    })[type] || "Noch kein Eintrag";
  }

  _eventForDay(day) {
    if (!day) return undefined;
    return this._events.find((event) => (event.start || "").slice(0, 10) === day);
  }

  _officeSites() {
    return [...(this._calendarEntity()?.attributes?.worklog_office_sites || [])]
      .filter((site) => site?.id && Number.isInteger(site.number))
      .sort((a, b) => a.number - b.number);
  }

  _siteIds(event) {
    const marker = (event?.description || "").match(/(?:^|\n)STEUERTAGE_SITES:(\[[^\n]*\])/);
    if (!marker) return [];
    try { const ids = JSON.parse(marker[1]); return Array.isArray(ids) ? ids : []; }
    catch { return []; }
  }

  _orderedSites(ids, extraSite) {
    const sites = new Map(this._officeSites().map((site) => [site.id, site]));
    if (extraSite) sites.set(extraSite.id, extraSite);
    return [...new Set(ids)].map((id) => sites.get(id) || { id, name: id + " (historisch)" })
      .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || a.id.localeCompare(b.id));
  }

  _siteNumber(site) {
    return Number.isInteger(site.number) ? "<span class='office-site-number'>" + site.number + "</span>" : "";
  }

  _siteNames(ids, { markup = false, extraSite, includeNumbers = true } = {}) {
    return this._orderedSites(ids, extraSite).map((site) => markup
      ? "<span class='office-site-label'>" + this._siteNumber(site) + "<span>" + this._escape(site.name) + "</span></span>"
      : site.name + (includeNumbers && Number.isInteger(site.number) ? " (" + site.number + ")" : ""));
  }

  _siteChangeMarkup(entry) {
    const oldIds = entry.old_office_site_ids;
    const newIds = entry.new_office_site_ids;
    if (!Array.isArray(oldIds) || !Array.isArray(newIds) || oldIds.join(",") === newIds.join(",")) return "";
    const options = { markup: true, extraSite: entry.deleted_office_site };
    return " · Standorte " + (this._siteNames(oldIds, options).join(", ") || "Nicht zugeordnet") +
      " → " + (this._siteNames(newIds, options).join(", ") || "Nicht zugeordnet");
  }

  _siteBreakdown(rows) {
    const groups = new Map();
    const add = (ids) => {
      const sortedIds = [...new Set(ids)].sort();
      const key = JSON.stringify(sortedIds);
      if (!groups.has(key)) groups.set(key, { ids: sortedIds, days: 0 });
      return groups.get(key);
    };
    this._officeSites().filter((site) => site.active).forEach((site) => add([site.id]));
    for (const row of rows) {
      if (row.type === "office") add(row.officeSiteIds).days++;
    }
    return [...groups.values()];
  }

  _relevantSiteCount(groups) {
    return new Set(groups.flatMap(({ ids }) => ids)).size;
  }

  _historicalSitesMarkup() {
    const person = this._calendarEntity()?.attributes?.worklog_person_entity;
    const data = this._historicalSites?.person === person ? this._historicalSites : null;
    if (!this._hass.user?.is_admin || !data?.sites.length) return "";
    return "<details class='data-disclosure' data-disclosure-id='historical-sites' " +
      (this._openDisclosures.has("historical-sites") ? "open" : "") +
      "><summary><span>Historische Arbeitsstandorte</span><small>" + data.sites.length + "</small></summary>" +
      "<div class='disclosure-content'><div class='table-wrap'><table><thead><tr><th>Arbeitsstandort</th>" +
      "<th>Tage über alle Steuerjahre</th><th></th></tr></thead><tbody>" +
      data.sites.map((site) => "<tr><td>" + this._siteNumber(site) + " " + this._escape(site.name) +
        "</td><td>" + site.days + "</td><td><button type='button' class='export-button site-delete' data-delete-site='" +
        this._escape(site.id).replaceAll("'", "&#39;") + "' aria-label='Arbeitsstandort löschen' title='Arbeitsstandort löschen'>" +
        "<ha-icon icon='mdi:trash-can-outline' aria-hidden='true'></ha-icon></button></td></tr>").join("") +
      "</tbody></table></div></div></details>";
  }

  async _loadHistoricalSites() {
    const person = this._calendarEntity()?.attributes?.worklog_person_entity;
    if (!person || !this._hass.user?.is_admin || this._historicalSites?.person === person || this._historicalRequest?.person === person) return;
    const request = { person, user: this._activeUserId };
    this._historicalRequest = request;
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "steuertage/historical_office_sites", person_entity: person,
      });
      if (this._historicalRequest !== request || this._activeUserId !== request.user) return;
      this._historicalSites = { person, ...result };
      if (this._tab === "export") this._render();
    } catch {
      if (this._historicalRequest === request && this._tab === "export") {
        this._historicalStatus = "Historische Arbeitsstandorte konnten nicht geladen werden.";
        this._render();
      }
    } finally {
      if (this._historicalRequest === request) this._historicalRequest = null;
    }
  }

  async _deleteHistoricalSite(siteId) {
    const data = this._historicalSites;
    const calendar = this._calendarEntity();
    const site = data?.sites.find((item) => item.id === siteId);
    if (this._deletingSite || !site || data.person !== calendar?.attributes?.worklog_person_entity) return;
    if (!window.confirm("Arbeitsstandort „" + site.name + "“ endgültig löschen?\n\nBetroffene Arbeitstage: " +
      site.days + ". Die Arbeitstage und ihre Tagestypen bleiben erhalten.")) return;
    this._deletingSite = true;
    this.shadowRoot.querySelectorAll("[data-download]").forEach((button) => { button.disabled = true; });
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "steuertage/historical_office_sites", person_entity: data.person,
        site_id: site.id, confirmed_days: site.days,
      });
      const history = this._editHistoryByPerson.get(data.person);
      if (history) {
        const retainsValidSites = ({ days }) => days.every(({ beforeSites, afterSites }) =>
          !beforeSites?.includes(site.id) && !afterSites?.includes(site.id));
        history.undo = history.undo.filter(retainsValidSites);
        history.redo = history.redo.filter(retainsValidSites);
      }
      if (this._calendarEntity()?.attributes?.worklog_person_entity !== data.person) return;
      this._historicalSites = { person: data.person, ...result };
      this._historicalStatus = "Arbeitsstandort gelöscht.";
      if (this._tab !== "calendar") this._loadedMonth = "";
      this._exportKey = "";
      if (this._tab === "calendar") await this._loadEvents({ refresh: true });
      else if (this._tab === "export") await this._loadExportEvents({ keepEvents: true });
    } catch (error) {
      if (this._calendarEntity()?.attributes?.worklog_person_entity !== data.person) return;
      this._historicalStatus = error?.message || "Der Arbeitsstandort konnte nicht gelöscht werden.";
      this._historicalSites = null;
      await this._loadHistoricalSites();
    } finally {
      this._deletingSite = false;
      if (this._calendarEntity()?.attributes?.worklog_person_entity === data.person) this._render();
    }
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
      "needs_review", "business_trip", "vacation", "sick_leave",
    ]);
    if (knownTypes.has(latest?.new_value)) return latest.new_value;
    if (/Manuell geändert zu: Arbeitsstätte \+ Homeoffice/i.test(description)) {
      return "office_and_home_office";
    }
    return this._type(event) || "automatic";
  }

  async _applyEditHistory(direction) {
    if (this._busy || this._pendingSiteEdits) return;
    const calendar = this._calendarEntity();
    const personEntity = calendar?.attributes?.worklog_person_entity;
    const history = this._editHistoryForCurrentPerson();
    const source = direction === "undo" ? history.undo : history.redo;
    const target = direction === "undo" ? history.redo : history.undo;
    const operation = source.at(-1);
    if (!personEntity || !operation) return;

    this._beginCalendarEdit(direction === "undo" ? "Mache Änderung rückgängig …" : "Wiederhole Änderung …");
    let message;
    try {
      for (const day of operation.days) {
        await this._hass.callService("steuertage", "set_day_override", {
          person_entity: personEntity,
          date: day.date,
          day_type: direction === "undo" ? day.before : day.after,
          office_site_ids: direction === "undo" ? day.beforeSites : day.afterSites,
        });
      }
      source.pop();
      target.push(operation);
      this._historicalSites = null;
      message = direction === "undo" ? "Änderung rückgängig gemacht." : "Änderung wiederhergestellt.";
    } catch (error) {
      message = "Die Aktion konnte nicht vollständig ausgeführt werden. Du kannst es erneut versuchen.";
    } finally {
      await this._loadEvents({ refresh: true });
      this._finishCalendarEdit(message);
    }
  }

  _queueSiteEdit({ personEntity, siteId, days }) {
    if (!personEntity) return;
    const editHistory = this._editHistoryForCurrentPerson();
    this._pendingSiteEdits++;
    this._siteQueue = this._siteQueue.catch(() => {}).then(async () => {
      try {
        const changed = await this._hass.connection.sendMessagePromise({
          type: "steuertage/toggle_office_site", person_entity: personEntity, site_id: siteId, dates: days,
        });
        if (changed.length) {
          editHistory.undo.push({ days: changed });
          if (editHistory.undo.length > 50) editHistory.undo.shift();
          editHistory.redo = [];
          this._historicalSites = null;
        }
      } catch (error) {
        this._siteEditError = error?.message || "Arbeitsstandort konnte nicht gespeichert werden.";
      } finally {
        if (--this._pendingSiteEdits === 0) {
          const message = this._siteEditError || "Arbeitsstandorte gespeichert.";
          this._siteEditError = "";
          if (this._tab === "calendar") await this._loadEvents({ refresh: true });
          else if (this._tab === "export") {
            this._exportKey = "";
            await this._loadExportEvents({ keepEvents: true });
          }
          if (this._calendarEntity()?.attributes?.worklog_person_entity === personEntity) {
            this._showMessage(message, { preserveEditorPosition: true });
          }
        }
      }
    });
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
    const workTypes = new Set(["office", "home_office", "business_trip"]);
    return {
      workdays: entries.filter((types) => [...types].some((type) => workTypes.has(type))).length,
      office: entries.filter((types) => types.has("office")).length,
      homeOffice: entries.filter((types) => types.has("home_office")).length,
      mixed: entries.filter((types) => types.has("mixed_day")).length,
      businessTrips: entries.filter((types) => types.has("business_trip")).length,
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
    if (this._rangeSelectionBounds) {
      const { from, to } = this._rangeSelectionBounds;
      this._applyFilteredRange(from, to);
    } else if (this._multiSelectMode || this._selectedDates.size > 1) {
      const candidates = new Set([...this._selectedDates, ...this._filteredMultiDates]);
      const visibleDates = new Set();
      this._filteredMultiDates.clear();
      for (const date of candidates) {
        if (selected.has(new Date(date + "T12:00:00").getDay())) {
          visibleDates.add(date);
        } else if (this._multiSelectMode) {
          this._filteredMultiDates.add(date);
        }
      }
      this._setDateSelection(visibleDates, this._selected);
    }
    this._render();
  }

  _setDateSelection(dates, target, range = null) {
    const ordered = [...dates].sort();
    this._selectedDates = dates;
    this._selected = dates.has(target) ? target : ordered.at(-1) ?? null;
    this._rangeAnchorDate = range?.from ?? this._selected;
    this._rangeSelectionBounds = range;
    this._selectionMode = range ? "range" : dates.size > 1 ? "multiple" : "single";
    this._correctionFrom = range ? (range.from < range.to ? range.from : range.to) : ordered[0] ?? "";
    this._correctionTo = range ? (range.from > range.to ? range.from : range.to) : ordered.at(-1) ?? "";
  }

  _selectDate(date, toggle = this._multiSelectMode) {
    const dates = toggle ? new Set(this._selectedDates) : new Set();
    this._filteredMultiDates.delete(date);
    if (dates.has(date)) dates.delete(date);
    else dates.add(date);
    this._setDateSelection(dates, date);
  }

  _applyFilteredRange(from, to, { baseDates = null, filteredDates = this._filteredMultiDates, remove = false } = {}) {
    const start = new Date((from < to ? from : to) + "T12:00:00");
    const end = new Date((from > to ? from : to) + "T12:00:00");
    const weekdays = this._rangeWeekdays();
    const dates = new Set(baseDates);
    const hiddenDates = new Set(filteredDates);
    for (let cursor = new Date(start), limit = 0; cursor <= end && limit < 366; cursor.setDate(cursor.getDate() + 1), limit++) {
      const date = this._isoDate(cursor);
      const included = weekdays.has(cursor.getDay());
      if (remove) {
        hiddenDates.delete(date);
        if (included) dates.delete(date);
      } else if (included) {
        dates.add(date);
        hiddenDates.delete(date);
      } else if (baseDates && !dates.has(date)) {
        hiddenDates.add(date);
      }
    }
    if (baseDates) this._filteredMultiDates = hiddenDates;
    this._setDateSelection(dates, to, baseDates ? null : { from, to });
  }

  _mobileMultiSelectLabel(count) {
    return !this._multiSelectMode ? "Mehrfachauswahl" : count >= 2 ? "Mehrfachauswahl aufheben" : "Mehrfachauswahl aktiv";
  }

  _desktopMultiSelectLabel() {
    return this._multiSelectMode ? "Mehrfachauswahl beenden" : "Mehrfachauswahl aktivieren";
  }

  _updateVisibleDateSelection(dates) {
    this.shadowRoot.querySelectorAll("[data-date]").forEach((cell) => {
      const selected = dates.has(cell.dataset.date);
      cell.classList.toggle("range-selected", selected);
      cell.classList.toggle("selected", cell.dataset.date === this._selected);
    });
    const multiButton = this.shadowRoot.querySelector("[data-action='multi-select']");
    if (multiButton) {
      multiButton.setAttribute("aria-pressed", String(this._multiSelectMode));
      multiButton.textContent = this._desktopMultiSelectLabel();
    }
    const clearButton = this.shadowRoot.querySelector("[data-action='clear-selection']");
    if (clearButton) clearButton.hidden = dates.size < 2;
    const mobileButton = this.shadowRoot.querySelector("[data-action='mobile-multi-select']");
    if (mobileButton) {
      mobileButton.setAttribute("aria-pressed", String(this._multiSelectMode));
      mobileButton.textContent = this._mobileMultiSelectLabel(dates.size);
    }
    const mobileCount = this.shadowRoot.querySelector(".mobile-range-count");
    if (mobileCount) mobileCount.textContent = "(" + dates.size + (dates.size === 1 ? " Tag" : " Tage") + ")";
    const count = this.shadowRoot.querySelector(".selection-count");
    if (count) count.textContent = dates.size === 1 ? "1 Tag" : dates.size + " Tage";
    this.shadowRoot.querySelectorAll(".range-filter-count").forEach((filterCount) => {
      filterCount.textContent = dates.size + (dates.size === 1 ? " Tag ausgewählt" : " Tage ausgewählt");
    });
  }


  _clearDateSelection() {
    this._filteredMultiDates = new Set();
    this._setDateSelection(new Set(), null);
  }

  _updateCalendarEditMessage() {
    const status = this.shadowRoot.querySelector(".selection-card .message");
    if (!status) return;
    status.textContent = this._message;
    status.hidden = !this._message;
  }

  _beginCalendarEdit(message) {
    if (this._messageTimer) clearTimeout(this._messageTimer);
    this._messageTimer = undefined;
    this._busy = true;
    this._message = message;
    this._updateCalendarEditMessage();
    this.shadowRoot.querySelectorAll("[data-type], .history-button").forEach((button) => {
      button.setAttribute("aria-disabled", "true");
    });
  }

  _finishCalendarEdit(message) {
    this._busy = false;
    this._showMessage(message, { preserveEditorPosition: true });
  }

  _showMessage(message, { preserveEditorPosition = false } = {}) {
    if (this._messageTimer) clearTimeout(this._messageTimer);
    this._message = message;
    this._render({ preserveEditorPosition });
    this._messageTimer = setTimeout(() => {
      this._message = "";
      this._messageTimer = undefined;
      if (preserveEditorPosition) this._updateCalendarEditMessage();
      else this._render();
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
    const officeZones = a.worklog_office_zone_entities || (a.worklog_office_zone_entity ? [a.worklog_office_zone_entity] : []);
    officeZones.forEach((zone) => check(zone, "Arbeitsstätte (Zone)"));
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

  _renderDialog(opener, markup, bindContent, onOpen) {
    const cached = this._dialogs.get(opener);
    let dialog = cached?.dialog;
    if (cached?.markup !== markup) {
      const template = document.createElement("template");
      template.innerHTML = markup;
      const updated = template.content.firstElementChild;
      if (dialog) {
        const strategy = dialog.querySelector("input[name='restore-strategy']:checked")?.value;
        const scrollTop = dialog.scrollTop;
        dialog.replaceChildren(...updated.childNodes);
        dialog.scrollTop = scrollTop;
        if (strategy) {
          dialog.querySelectorAll("input[name='restore-strategy']").forEach((input) => {
            input.checked = input.value === strategy;
          });
        }
      } else {
        dialog = updated;
        // Keep native modal elements mounted while the main view rerenders.
        this.shadowRoot.appendChild(dialog);
        dialog.addEventListener("click", (event) => {
          if (event.target === dialog || event.target.closest(".dialog-close-button")) dialog.close();
        });
        dialog.addEventListener("close", () => {
          if (!dialog.open) this.shadowRoot.querySelector(opener)?.focus();
        });
      }
      bindContent?.(dialog);
      this._dialogs.set(opener, { dialog, markup });
    }
    this._view.querySelector(opener)?.addEventListener("click", () => {
      dialog.showModal();
      onOpen?.();
    }, {
      signal: this._viewListeners.signal,
    });
  }

  _bindBackupActions(dialog) {
    dialog.querySelector("[data-backup]")?.addEventListener("click", () => this._downloadBackup());
    dialog.querySelector("[data-save-backup]")?.addEventListener("click", () => this._savePreparedBackup());
    dialog.querySelector("[data-restore]")?.addEventListener("click", () => dialog.querySelector("[data-restore-file]")?.click());
    dialog.querySelector("[data-restore-file]")?.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      await this._prepareRestore(file);
      event.target.value = "";
    });
    dialog.querySelectorAll("[data-automatic-backup]").forEach((button) =>
      button.addEventListener("click", () => this._prepareRestore(null, button.dataset.automaticBackup)));
    dialog.querySelector("[data-restore-cancel]")?.addEventListener("click", () => this._cancelRestore());
    dialog.querySelector("[data-restore-confirm]")?.addEventListener("click", () => this._restoreBackup());
  }

  _configInfoMarkup() {
    const calendar = this._calendarEntity();
    const attributes = calendar?.attributes || {};
    const threshold = Number(attributes.worklog_threshold_hours ??
      (attributes.worklog_threshold_minutes != null ? attributes.worklog_threshold_minutes / 60 : 2));
    const thresholdLabel = threshold.toLocaleString(this._hass?.locale?.language || "de-DE");
    const duration = thresholdLabel + (threshold === 1 ? " Stunde" : " Stunden");
    const homeofficeEnabled = this._homeOfficeEnabled(calendar);
    const legacySignal = !attributes.worklog_device_tracker && attributes.worklog_legacy_signal;
    const homeoffice = !homeofficeEnabled
      ? "Für diese Person ist die automatische Homeoffice-Erkennung ausgeschaltet."
      : legacySignal
        ? "Bei dieser älteren Einrichtung zählt die Zeit, in der der konfigurierte Binärsensor eingeschaltet ist."
        : "Die Zeit zählt, solange sich die zugeordnete Person und das erfasste Gerät gleichzeitig in der eingestellten Home-Zone befinden.";
    const mixedDay = homeofficeEnabled
      ? "<li><b>Mischtag:</b> Wurde am selben Tag in Arbeitsstätten und im Homeoffice Zeit erfasst und an mindestens einem Ort die Mindestdauer erreicht, erscheint ein Mischtag. Er zählt einmal, und zwar für den Ort mit der längeren erfassten Dauer. Bei Gleichstand zählt die Arbeitsstätte.</li>"
      : "";
    const support = /^en(?:-|$)/i.test(this._hass?.locale?.language || "")
      ? ["Support the project", "You can voluntarily contribute to the continued development of Steuertage. All features remain free."]
      : ["Projekt unterstützen", "Du kannst die Weiterentwicklung von Steuertage freiwillig finanziell unterstützen. Alle Funktionen bleiben kostenlos."];
    return "<dialog class='config-info-dialog' data-config-info-dialog aria-label='So funktioniert die automatische Erkennung'><div class='config-info-dialog-content'><header class='config-info-header'><div><span class='eyebrow'>ERKENNUNG</span><h3>So funktioniert die automatische Erkennung</h3></div><button type='button' class='dialog-close-button' data-action='config-info-close' aria-label='Information schließen'><ha-icon icon='mdi:close' aria-hidden='true'></ha-icon></button></header><section class='info-card explanation-card'><p>Steuertage sammelt Anwesenheitszeiten pro Kalendertag und leitet daraus Einträge für Arbeitsstätte und Homeoffice ab. Im Kalender und im Export siehst du die erkannten Tage. Ist deinem Home-Assistant-Konto eine in Steuertage eingerichtete Person zugeordnet, wird ihr Kalender beim Einstieg vorausgewählt.</p><ul>" +
      "<li><b>Arbeitsstätte:</b> Die Zeit zählt, solange sich die Person in mindestens einer der eingerichteten Arbeitszonen befindet. Aufenthalte an mehreren Arbeitsstätten werden am selben Tag addiert; überlappende Arbeitszonen zählen dabei nicht doppelt. Ist ein Arbeitskalender eingerichtet, muss gleichzeitig ein Termin in diesem Kalender laufen. Das gilt für Termine mit Uhrzeit und für ganztägige Termine.</li>" +
      "<li><b>Homeoffice:</b> " + homeoffice + "</li>" +
      "<li><b>Mindestdauer:</b> Die Zeitabschnitte eines Tages werden für Arbeitsstätten insgesamt und Homeoffice getrennt addiert. " +
      (calendar ? "Für die ausgewählte Person sind <b>" + duration + "</b> eingestellt." : "Standardmäßig sind <b>2 Stunden</b> eingestellt.") +
      " Die Mindestdauer lässt sich pro Person ändern.</li>" +
      "<li><b>„" + TRACKING_STATUS_LABEL + "“:</b> Ein passendes Signal ist gerade aktiv, und die Mindestdauer wurde bisher an keinem Ort erreicht. Enden alle Signale vorher, wird der Tag automatisch als „Kein Arbeitstag“ eingestuft.</li>" +
      mixedDay +
      "<li><b>„Bitte prüfen“:</b> Ein so gekennzeichneter Eintrag kann im Kalender geprüft und bei Bedarf korrigiert werden. Du kannst Tage auch manuell als Urlaub oder Krankheit erfassen. Manuelle Änderungen stehen im Änderungsverlauf.</li><li><b>Kalenderauswahl:</b> Wochentage im Kalenderkopf filtern Zeiträume beim Ziehen oder Umschalt-Klick; „Wochenende auslassen“ und „Alle Tage“ setzen die Filter. Einzelne Tage kannst du unabhängig davon anklicken, für mehrere Tage auch den Mehrfachauswahl-Modus nutzen. Feiertage bleiben enthalten. ↶ nimmt Änderungen zurück, ↷ wiederholt sie.</li></ul></section><nav class='config-info-links' aria-label='Weitere Informationen'><a href='https://github.com/mongrelX15/Steuertage' target='_blank' rel='noopener noreferrer'>Repository öffnen</a><a href='https://github.com/mongrelX15/Steuertage/issues/new' target='_blank' rel='noopener noreferrer'>Frage oder Änderungswunsch stellen</a></nav>" +
      "<section class='config-info-support' aria-labelledby='config-info-support-title'>" +
      "<h4 id='config-info-support-title'>" + support[0] + "</h4><p>" + support[1] + "</p>" +
      "<div class='config-info-links'><a href='https://github.com/sponsors/mongrelX15' target='_blank' rel='noopener noreferrer'>" +
      "<span class='config-info-link-icon' aria-hidden='true'>♡</span><span>GitHub Sponsors</span></a>" +
      "<a href='https://buymeacoffee.com/mongrelx15' target='_blank' rel='noopener noreferrer'>" +
      "<span class='config-info-link-icon' aria-hidden='true'>☕</span><span>Buy Me a Coffee</span></a></div></section></div></dialog>";
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
        ["Arbeitsstätten (Zonen)", (a.worklog_office_zone_entities || (a.worklog_office_zone_entity ? [a.worklog_office_zone_entity] : [])).join(", ") || "Nicht eingerichtet"],
        ["Arbeitskalender", workCalendar],
        ["Gesetzliche Feiertage", a.worklog_holiday_country
          ? [a.worklog_holiday_country, a.worklog_holiday_subdivision].filter(Boolean).join(" · ")
          : "Ausgeblendet"],
        ["Schwellwert", thresholdLabel + " Stunden"]];
      return "<section class='config-card'><div class='config-title'><h3>" + this._escape(this._calendarLabel(calendar)) +
        "</h3><a class='settings-link' href='/config/integrations/integration/steuertage#config_entry=" + encodeURIComponent(a.worklog_entry_id || "") +
        "'>Einstellungen öffnen</a></div><dl>" + rows.map(([k,v]) => "<div><dt>" + k + "</dt><dd>" +
        this._escape(v || "Nicht eingerichtet") + "</dd></div>").join("") + "</dl>" +
        (issues.length ? "<div class='validation warning'><b>Bitte prüfen</b><ul>" + issues.map((issue) => "<li>" + this._escape(issue) + "</li>").join("") + "</ul></div>" :
        "<p class='validation ok'>Konfiguration und benötigte Entitäten sind verfügbar.</p>") +
        (!(a.worklog_office_zone_entities?.length || a.worklog_office_zone_entity) ? "<p class='muted'>Keine Arbeitszone hinterlegt: Bürotage werden nicht automatisch erkannt.</p>" : "") +
        "</section>";
    }).join("");
    return "<ha-card><header class='view-header'><div><span class='eyebrow'>EINSTELLUNGEN</span><h2>Konfiguration</h2><p>Personen, Erkennung und Schwellwerte im Blick behalten.</p></div><span class='header-badge'>"+calendars.length+" "+(calendars.length === 1 ? "Person" : "Personen")+"</span></header>" +
      (cards || "<p>Richte zuerst eine Person über Einstellungen → Geräte &amp; Dienste → Integration hinzufügen → Steuertage ein.</p>") + "</ha-card>";

  }

  _automaticBackupMarkup() {
    if (!this._hass.user?.is_admin) return "";
    const locale = this._hass.locale?.language || "de-DE";
    const [title, loading, empty, latest, unavailable] = /^en(?:-|$)/i.test(locale)
      ? ["Automatic backups", "Loading backups …", "No automatic backups yet.", "Latest", "Could not load automatic backups."]
      : ["Automatische Sicherungen", "Sicherungen werden geladen …", "Noch keine automatischen Sicherungen vorhanden.", "Neueste", "Automatische Sicherungen konnten nicht geladen werden."];
    const date = (value) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
    const backups = this._automaticBackups;
    let content = "<small>" + (backups === null ? loading : backups === false ? unavailable : empty) + "</small>";
    if (Array.isArray(backups) && backups.length) {
      content = backups.map(({ filename, created_at }, index) =>
        "<div class='backup-actions'><button type='button' class='export-button' data-automatic-backup='" +
        this._escape(filename) + "'>" + this._escape(date(created_at)) + "</button>" +
        (index === 0 ? "<small>" + latest + "</small>" : "") + "</div>").join("");
    }
    return "<fieldset class='restore-options'><legend>" + title + "</legend>" + content + "</fieldset>";
  }

  async _loadAutomaticBackups() {
    if (!this._hass.user?.is_admin) return;
    try {
      this._automaticBackups = await this._hass.connection.sendMessagePromise({ type: "steuertage/automatic_backups" });
    } catch {
      this._automaticBackups = false;
    }
    this._render();
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
        (this._pendingRestore.automaticFilename ? "<p>" +
          (/^en(?:-|$)/i.test(this._hass.locale?.language || "") ? "Restore this automatic backup?" : "Diese automatische Sicherung wiederherstellen?") + "</p>" : "") +
        "<fieldset class='restore-options' " + (this._backupRestoring ? "disabled" : "") + "><legend>Wie sollen die gesicherten Tage eingetragen werden?</legend>" +
        "<label class='restore-option'><input type='radio' name='restore-strategy' value='merge_newer' checked><span><strong>Ergänzen</strong><small>Fehlende Tage hinzufügen und neuere lokale Änderungen behalten.</small></span></label>" +
        "<label class='restore-option'><input type='radio' name='restore-strategy' value='replace'><span><strong>Ersetzen</strong><small>Tage aus der Sicherung überschreiben. Tage, die nicht in der Sicherung stehen, bleiben unverändert.</small></span></label></fieldset>" +
        (this._backupRestoring ? "<p class='restore-progress' role='status'>Wiederherstellung läuft …</p>" : "") +
        "<div class='restore-dialog-actions'><button class='export-button' data-restore-cancel " + (this._backupRestoring ? "disabled" : "") + ">Abbrechen</button>" +
        "<button class='export-button primary' data-restore-confirm " + (this._backupRestoring ? "disabled" : "") + ">Jetzt wiederherstellen</button></div></section>"
      : "<section class='backup-card'><p>Die Sicherung enthält die Verläufe aller in Steuertage eingerichteten Personen – unabhängig von der aktuell ausgewählten Person. Beim Wiederherstellen werden nur aktuell eingerichtete Personen berücksichtigt. Dafür ist ein Home-Assistant-Administrator erforderlich.</p>" +
        "<p>„Ergänzen“ fügt fehlende Tage hinzu und behält neuere lokale Änderungen. „Ersetzen“ überschreibt die gesicherten Tage; Tage, die nicht in der Sicherung stehen, bleiben unverändert.</p>" +
        this._automaticBackupMarkup() +
        "<h3>" + (/^en(?:-|$)/i.test(this._hass.locale?.language || "") ? "Your own backup file" : "Eigene Sicherungsdatei") + "</h3>" +
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
        officeSiteIds: this._siteIds(event),
        manual: (event.description || "").includes("Manuell geändert"),
      }));
  }

  _countsForRows(rows) {
    const homeofficeEnabled = this._homeOfficeEnabled();
    const counts = { office: 0, home_office: 0, mixed: 0, business_trip: 0, sick_leave: 0, vacation: 0, needs_review: 0, tracking: 0 };
    rows.forEach((row) => {
      if (row.type === "home_office" && !homeofficeEnabled) return;
      if (row.type in counts && row.type !== "mixed") counts[row.type]++;
      if (homeofficeEnabled && row.mixed) counts.mixed++;
    });
    counts.workdays = counts.office + counts.home_office + counts.business_trip;
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
    const siteGroups = this._siteBreakdown(rows || []);
    const siteSummary = this._relevantSiteCount(siteGroups) > 1
      ? "<details class='data-disclosure' data-disclosure-id='sites' " +
        (this._openDisclosures.has("sites") ? "open" : "") +
        "><summary><span>Arbeitsstätten</span><small>" + counts.office + " Bürotage</small></summary>" +
        "<div class='disclosure-content'><div class='table-wrap'><table><thead><tr><th>Arbeitsstandort</th><th>Tage</th></tr></thead><tbody>" +
        siteGroups.map(({ ids, days }) => "<tr><td>" +
          (this._siteNames(ids, { markup: true }).join(" + ") || "Nicht zugeordnet") +
          "</td><td>" + days + "</td></tr>").join("") +
        "<tr><th>Arbeitsstätte gesamt</th><td>" + counts.office + "</td></tr></tbody></table></div></div></details>"
      : "";
    const monthlyHead = "<th>Monat</th><th>Arbeitsstätte</th>" +
      (homeofficeEnabled ? "<th>Homeoffice</th><th>Mischtage (Info)</th>" : "") +
      "<th>Dienstreisen</th><th>Krank</th><th>Urlaub</th><th>Arbeitstage gesamt</th>";
    const monthlyRows = monthly.map((m) => "<tr><td>" + m.month + "</td><td>" + m.office + "</td>" +
      (homeofficeEnabled ? "<td>" + m.home_office + "</td><td>" + m.mixed + "</td>" : "") +
      "<td>" + m.business_trip + "</td><td>" + m.sick_leave + "</td><td>" + m.vacation + "</td><td>" + m.workdays + "</td></tr>").join("");
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
    const disabled = rows === null || this._deletingSite || this._refreshingExport ? "disabled" : "";
    const currentPerson = this._calendarEntity()?.attributes?.worklog_person_entity;
    const deletions = this._hass.user?.is_admin && this._historicalSites?.person === currentPerson
      ? this._historicalSites?.deletions || [] : [];
    const logEntries = rows === null ? [] : (this._exportEvents || []).flatMap((event) => {
      const date = (event.start || "").slice(0, 10);
      if (date < this._exportFrom || date > this._exportTo) return [];
      return this._changeHistory(event).map((entry) => ({ ...entry, date }));
    });
    logEntries.push(...deletions);
    logEntries.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
    const changeLabel = (value) => value === "automatic" ? "Automatik" : this._label(value);
    const currentYear = new Date().getFullYear();
    return "<ha-card><header class='view-header'><div><span class='eyebrow'>AUSWERTUNG &amp; DATENSICHERUNG</span><h2>Daten &amp; Export</h2><p>Steuerlich relevante Tage auswerten, exportieren und Verläufe sichern oder wiederherstellen.</p></div><span class='header-badge'>CSV · TXT · HTML · PDF</span></header>" +
      "<section class='info-card export-check " + (openItems.length ? "has-issues" : "all-clear") + "'><h3>Vor dem Export prüfen</h3>" + checklist + (rows === null ? "" : "<p class='muted'>" + counts.manual + " manuell geänderte Tage im Zeitraum.</p>") + "</section>" +
      "<section class='export-period'><div class='section-heading'><div><span class='eyebrow'>ZEITRAUM</span><h3>Auswertung eingrenzen</h3></div>" + person + "</div><div class='export-controls'>" +
      "<div class='preset-row'>" +
      [currentYear, currentYear - 1, currentYear - 2].map((year) => "<button class='export-button' data-period='year' data-year='" + year + "'>Steuerjahr " + year + "</button>").join("") +
      "<button class='export-button' data-period='month'>Dieser Monat</button><button class='export-button' data-period='week'>Diese Woche</button></div>" +
      "<label>Von <input data-export-from type='date' value='" + this._exportFrom + "'></label>" +
      "<label>Bis <input data-export-to type='date' value='" + this._exportTo + "'></label>" +
      "<button class='export-button' data-download='csv' " + disabled + ">CSV herunterladen</button>" +
      "<button class='export-button' data-download='txt' " + disabled + ">TXT herunterladen</button>" +
      "<button class='export-button' data-download='html' " + disabled + ">HTML herunterladen</button>" +
      "<button class='export-button' data-download='pdf' " + disabled + ">PDF herunterladen</button></div></section>" +
      "<p class='muted'>" + (homeofficeEnabled ? "Mischtage sind in ihrer Hauptkategorie enthalten und werden als Zusatzinformation ausgewiesen. " : "") + "Nur durch diese App erfasste Tage können in der Auswertung berücksichtigt werden.</p>" +
      (rows === null ? table : "<div class='stats export-stats'>" + stat("Tage mit Arbeitsstätte",counts.office) +
      (homeofficeEnabled ? stat("Homeoffice-Tage",counts.home_office) + stat("Davon Mischtage (Info)",counts.mixed) : "") +
      stat("Dienstreisen",counts.business_trip) + stat("Krankheitstage",counts.sick_leave) + stat("Urlaubstage",counts.vacation) +
      stat("Arbeitstage gesamt",counts.workdays) + stat("Bitte prüfen",counts.needs_review) + stat("Erkennung läuft",counts.tracking) + "</div>" +
      siteSummary + this._historicalSitesMarkup() +
      (this._historicalStatus ? "<p role='status'>" + this._escape(this._historicalStatus) + "</p>" : "") +
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
        const title = entry.date
          ? this._escape(entry.deleted_office_site ? "Standortzuordnung entfernt" :
            changeLabel(entry.old_value || "") + " → " + changeLabel(entry.new_value || ""))
          : this._siteNumber(entry) + " " + this._escape(entry.name) + " gelöscht";
        const details = entry.date ? this._siteChangeMarkup(entry) : " · " + entry.days + " betroffene Arbeitstage";
        return "<li><span><strong>" + title + "</strong><small>" + this._escape(timeLabel) +
          " · " + this._escape(changedBy) + details + "</small></span></li>";
      }).join("") + "</ol>" : "<p>Für diesen Zeitraum sind keine manuellen Änderungen gespeichert.</p>") + "</div></details>") +
      "<div class='backup-launch'><button type='button' class='export-button' data-open-data-management>Sicherung &amp; Wiederherstellung verwalten</button></div></ha-card>";
  }

  async _loadExportEvents({ keepEvents = false } = {}) {
    this._loadHistoricalSites();
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
    this._exportKey = key;
    const request = Symbol();
    this._exportRequest = request;
    this._refreshingExport = keepEvents;
    if (!keepEvents) this._exportEvents = null;
    const stop = this._exportUnsubscribe;
    this._exportUnsubscribe = undefined;
    try {
      await stop?.();
      if (this._exportRequest !== request) return;
      const unsubscribe = await this._hass.connection.subscribeMessage((message) => {
        if (this._exportRequest !== request || this._calendarEntityId !== entityId || this._exportKey !== key) return;
        this._refreshingExport = false;
        this._exportEvents = Array.isArray(message?.events) ? message.events :
          Array.isArray(message?.event?.events) ? message.event.events : [];
        if (this._tab === "export") this._render();
      }, { type: "calendar/event/subscribe", entity_id: entityId, start: queryStart.toISOString(), end: end.toISOString() });
      if (this._exportRequest === request) this._exportUnsubscribe = unsubscribe;
      else await unsubscribe();
    } catch (error) {
      if (this._exportRequest !== request) return;
      this._refreshingExport = false;
      this._exportEvents = [];
      if (this._tab === "export") this._render();
    }
  }

  _setBackupNotice(kind, title, text) {
    this._backupNotice = { kind, title, text };
    this._render();
  }

  async _downloadBackup() {
    this._preparedBackup = null;
    this._backupNotice = null;
    try {
      const backup = await this._hass.connection.sendMessagePromise({ type: "steuertage/export_history" });
      const { people, coverage, created_at: createdAt } = backup;
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

  async _prepareRestore(file, automaticFilename) {
    if ((!file && !automaticFilename) || this._preparingRestore) return;
    this._preparingRestore = true;
    this._backupNotice = null;
    try {
      const backup = automaticFilename
        ? await this._hass.connection.sendMessagePromise({ type: "steuertage/automatic_backups", filename: automaticFilename })
        : JSON.parse(await file.text());
      if (backup?.format !== "steuertage_backup") throw new Error("Das ist keine gültige Steuertage-Sicherung.");
      let people;
      if (backup.version === 1 && backup.person_entity && backup.records && typeof backup.records === "object") {
        people = [backup];
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
        filename: automaticFilename || file?.name || "Steuertage-Sicherung",
        automaticFilename,
      };
      this._render();
    } catch (error) {
      this._pendingRestore = null;
      this._setBackupNotice("error", "Sicherung konnte nicht gelesen werden", error?.message || "Die Datei ist ungültig.");
    } finally {
      this._preparingRestore = false;
    }
  }

  async _restoreBackup() {
    const pending = this._pendingRestore;
    if (!pending || this._backupRestoring) return;
    const strategy = this.shadowRoot.querySelector("input[name='restore-strategy']:checked")?.value || "merge_newer";
    this._backupRestoring = true;
    this._render();
    try {
      const source = pending.automaticFilename ? { filename: pending.automaticFilename } : { backup: pending.backup };
      const totals = await this._hass.connection.sendMessagePromise({ type: "steuertage/restore_backup", strategy, ...source });
      this._exportKey = "";
      this._exportEvents = null;
      this._historicalSites = null;
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

  _exportReport() {
    const rows = this._exportRows();
    const counts = this._countsForRows(rows);
    const homeOffice = this._homeOfficeEnabled();
    const date = (value) => this._formatDate(value, { day: "2-digit", month: "2-digit", year: "numeric" });
    const measures = [
      ["Arbeitsstätte", "office"],
      ...(homeOffice ? [["Homeoffice", "home_office"]] : []),
      ["Dienstreisen", "business_trip"],
      ["Krankheit", "sick_leave"],
      ["Urlaub", "vacation"],
    ];
    const siteGroups = this._siteBreakdown(rows);
    const relevantSiteCount = this._relevantSiteCount(siteGroups);
    const siteNames = (ids) => this._siteNames(ids, { includeNumbers: relevantSiteCount > 1 });
    const siteDetails = siteGroups.map(({ ids, days }) => [
      siteNames(ids).join(" + ") || "Nicht zugeordnet (Arbeitsstätte)", days,
    ]);
    const statuses = [["Bitte prüfen", counts.needs_review], ["Erkennung läuft", counts.tracking]];
    const notes = homeOffice ? [["Mischtage (im Haupttyp enthalten)", counts.mixed]] : [];
    const days = {
      headers: ["Datum", "Tagestyp", "Erfassung", "Hinweis", "Arbeitsstandorte"],
      values: rows.map((row) => [
        date(row.date), row.label, row.manual ? "Manuell" : "Automatisch",
        [
          row.mixed ? "Mischtag" : "",
          row.type === "needs_review" ? "Bitte im Kalender prüfen" : "",
          row.type === "tracking" ? "Erkennung noch nicht abgeschlossen" : "",
        ].filter(Boolean).join(" · "),
        row.type === "office" || (row.type === "home_office" && row.mixed)
          ? siteNames(row.officeSiteIds).join(", ") || (row.type === "office" ? "Nicht zugeordnet" : "") : "",
      ]),
    };
    const hasDayNotes = days.values.some((row) => row[3].trim().length > 0);
    if (!hasDayNotes) {
      days.headers.splice(3, 1);
      days.values.forEach((row) => row.splice(3, 1));
    }
    return {
      person: this._calendarLabel(this._calendarEntity() || { attributes: {}, entity_id: "" }),
      period: date(this._exportFrom) + " bis " + date(this._exportTo),
      generated: new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date()),
      credit: "Steuertage · Version " + (this._panel?.config?.version || "–") + " · Entwickelt von mongrelX15",
      total: counts.workdays,
      measures: measures.map(([label, key]) => [label, counts[key]]),
      notes,
      statuses,
      siteGroups,
      hasDayNotes,
      details: [...notes, ...siteDetails, ...statuses],
      months: {
        headers: ["Monat", ...measures.map(([label]) => label), ...(homeOffice ? ["Mischtage"] : []), "Arbeitstage"],
        values: this._monthlySummary(rows).map((month) => [
          month.month, ...measures.map(([, key]) => month[key]), ...(homeOffice ? [month.mixed] : []), month.workdays,
        ]),
      },
      days,
      notice: "Nur durch Steuertage erfasste Tage können in der Auswertung berücksichtigt werden. Steuertage unterstützt die automatische Erfassung auf Grundlage der in Home Assistant vorhandenen Erkennung. Für Richtigkeit und Vollständigkeit deiner Steuererklärung trägst du die Verantwortung. Alle Angaben ohne Gewähr.",
    };
  }

  async _exportLogo() {
    try {
      const image = this.shadowRoot.querySelector(".app-mark img");
      if (!image) return null;
      await image.decode();
      const size = 96;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, size, size);
      const scale = Math.min(size / image.naturalWidth, size / image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
      return { url: canvas.toDataURL("image/jpeg", .88), size };
    } catch {
      return null;
    }
  }

  _exportHtml(report, logo) {
    const esc = (value) => this._escape(value);
    const table = ({ headers, values }) => values.length
      ? "<div class='table-wrap'><table><thead><tr>" +
        headers.map((value) => "<th scope='col'>" + esc(value) + "</th>").join("") +
        "</tr></thead><tbody>" + values.map((row) => "<tr>" +
          row.map((value) => "<td>" + esc(value) + "</td>").join("") + "</tr>").join("") +
        "</tbody></table></div>"
      : "<p>Keine gespeicherten Tage in diesem Zeitraum.</p>";
    const stats = report.measures.map(([label, value]) =>
      "<div><dt>" + esc(label) + "</dt><dd>" + value + "</dd></div>").join("");
    return "<!doctype html><html lang='de'><head><meta charset='utf-8'>" +
      "<meta name='viewport' content='width=device-width, initial-scale=1'><title>Steuertage · Auswertung</title><style>" +
      "*{box-sizing:border-box}body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f5f4f0;color:#242220}" +
      "main{max-width:960px;margin:auto;padding:clamp(16px,5vw,48px)}header{display:flex;align-items:center;gap:14px}" +
      "header img{width:48px;height:48px;border-radius:10px}h1,h2,p{margin:0}h1{font-size:28px}h2{font-size:18px}" +
      ".meta,footer,.details{color:#5b544b}.meta{margin:12px 0 24px}.total{background:#fff0ce;border:1px solid #eac77b;border-radius:12px;padding:12px 16px}" +
      ".total strong{display:block;font-size:32px;line-height:1.15}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px;margin:8px 0}" +
      ".stats div{background:#fff;border:1px solid #e4dfd5;border-radius:9px;padding:8px 10px}.stats dd{margin:0;font-size:22px;font-weight:700}" +
      "section+section,footer{margin-top:24px}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;margin-top:6px}" +
      "th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e4dfd5}thead{background:#efece5}tbody tr:nth-child(even){background:#faf9f6}" +
      "footer{padding-top:10px;border-top:1px solid #c8c0b4;font-size:12px}footer p+p{margin-top:4px}" +
      "@media print{@page{margin:14mm}body{background:#fff}main{padding:0}.table-wrap{overflow:visible}thead{display:table-header-group}" +
      "h2{break-after:avoid}tr,footer,.stats div,.total{break-inside:avoid}}</style></head><body><main><header>" +
      (logo ? "<img src='" + logo.url + "' alt='' width='48' height='48'>" : "") +
      "<h1>Steuertage · Auswertung</h1></header><p class='meta'>" + esc(report.person) + "<br>" + esc(report.period) +
      " · Erstellt am " + esc(report.generated) + "</p><section aria-label='Gesamtübersicht'><div class='total'>Arbeitstage gesamt<strong>" +
      report.total + "</strong></div><dl class='stats'>" + stats + "</dl><p class='details'>" +
      report.details.map(([label, value]) => esc(label) + ": " + value).join(" · ") + "</p></section>" +
      "<section><h2>Monatsübersicht</h2>" + table(report.months) + "</section><section><h2>Tagesprotokoll</h2>" +
      table(report.days) + "</section><footer><p>" + esc(report.credit) + "</p><p>" + esc(report.notice) +
      "</p></footer></main></body></html>";
  }

  _exportPdf(report, logo) {
    const ascii = (value) => String(value).normalize("NFC").replace(/[^\x20-\xff]/gu, (char) =>
      ({ "–": "-", "—": "-", "’": "'", "€": "EUR", "…": "..." })[char] ||
      char.normalize("NFKD").replace(/[^\x20-\xff]/g, "") || "?");
    const literal = (value) => "(" + ascii(value).replace(/[\\()]/g, (char) => "\\" + char)
      .replace(/[\x7f-\xff]/g, (char) => "\\" + char.charCodeAt(0).toString(8).padStart(3, "0")) + ")";
    const context = document.createElement("canvas").getContext("2d");
    const wrap = (value, width, size, bold = false) => {
      context.font = (bold ? "bold " : "") + size + "px Arial";
      const lines = [];
      let line = "";
      for (const char of ascii(value).replace(/\s+/g, " ")) {
        if (line && context.measureText(line + char).width > width) {
          const split = line.lastIndexOf(" ");
          lines.push(split < 0 ? line : line.slice(0, split));
          line = split < 0 ? "" : line.slice(split + 1);
        }
        line += char;
      }
      return [...lines, line.trim()];
    };

    const width = 595, height = 842, margin = 42;
    const bodyWidth = width - 2 * margin;
    const pages = [];
    let commands, y;
    const text = (value, x, at, size = 10, bold = false) => {
      commands.push("0.13 0.11 0.08 rg BT /" + (bold ? "F2" : "F1") + " " + size +
        " Tf 1 0 0 1 " + x + " " + at + " Tm " + literal(value) + " Tj ET");
    };
    const rect = (x, top, w, h, color) => commands.push(color + " rg " + x + " " + (top - h) + " " + w + " " + h + " re f");
    const startPage = () => {
      commands = [];
      pages.push(commands);
      y = height - margin;
      if (pages.length > 1) {
        text("Steuertage · Auswertung", margin, y, 12, true);
        y -= 24;
      }
    };
    const footerLines = wrap(report.notice, bodyWidth, 8);
    const footerTop = 53 + 10 * footerLines.length;
    startPage();
    if (logo) commands.push("q 38 0 0 38 " + margin + " " + (y - 32) + " cm /Logo Do Q");
    text("Steuertage · Auswertung", margin + (logo ? 50 : 0), y - 13, 23, true);
    y -= 50;
    for (const line of wrap(report.person, bodyWidth, 12, true)) {
      if (y < footerTop + 16) startPage();
      text(line, margin, y, 12, true);
      y -= 15;
    }
    text(report.period + " · Erstellt am " + report.generated, margin, y);
    y -= 17;
    if (y < footerTop + 145) startPage();
    rect(margin, y, bodyWidth, 55, "1 .92 .68");
    text("Arbeitstage gesamt", margin + 12, y - 18, 11, true);
    text(report.total, margin + 12, y - 43, 24, true);
    y -= 63;
    const gap = 6;
    const tileWidth = (bodyWidth - gap * (report.measures.length - 1)) / report.measures.length;
    report.measures.forEach(([label, count], i) => {
      const x = margin + i * (tileWidth + gap);
      rect(x, y, tileWidth, 40, ".98 .96 .89");
      text(label, x + 7, y - 14, 9);
      text(count, x + 7, y - 32, 16, true);
    });
    y -= 55;
    for (const line of wrap(report.details.map(([label, value]) => label + ": " + value).join(" · "), bodyWidth, 9)) {
      if (y < footerTop + 20) startPage();
      text(line, margin, y, 9);
      y -= 12;
    }
    y -= 13;

    const table = (title, { headers, values }, widths) => {
      const rowLines = (cells, bold) => cells.map((value, i) => wrap(value, widths[i] - 12, 9, bold));
      const rowHeight = (lines) => Math.max(...lines.map((column) => column.length)) * 11 + 8;
      const drawRow = (lines, h, color, bold = false) => {
        if (color) rect(margin, y, bodyWidth, h, color);
        let x = margin;
        lines.forEach((column, i) => {
          column.forEach((line, j) => text(line, x + 6, y - 12 - j * 11, 9, bold));
          x += widths[i];
        });
        y -= h;
      };
      const heading = rowLines(headers, true);
      const headingHeight = rowHeight(heading);
      const section = (continued = false) => {
        text(title + (continued ? " (Fortsetzung)" : ""), margin, y, 14, true);
        y -= 9;
        if (values.length) drawRow(heading, headingHeight, ".97 .93 .81", true);
      };
      if (y < footerTop + headingHeight + 52) startPage();
      section();
      if (!values.length) {
        text("Keine gespeicherten Tage in diesem Zeitraum.", margin, y - 13);
        y -= 22;
      }
      values.forEach((cells, i) => {
        const lines = rowLines(cells, false);
        const h = rowHeight(lines);
        if (y - h < footerTop) {
          startPage();
          section(true);
        }
        drawRow(lines, h, i % 2 === 0 ? ".98 .97 .94" : null);
      });
      y -= 24;
    };
    context.font = "bold 9px Arial";
    const minimumMonthWidths = report.months.headers.map((header) => context.measureText(ascii(header)).width + 18);
    const monthWidthExtra = Math.max(0, bodyWidth - minimumMonthWidths.reduce((sum, width) => sum + width, 0)) /
      minimumMonthWidths.length;
    table("Monatsübersicht", report.months, minimumMonthWidths.map((width) => width + monthWidthExtra));
    const dayWidths = report.hasDayNotes ? [70, 105, 80, bodyWidth - 350, 95] : [70, 105, 80, bodyWidth - 255];
    table("Tagesprotokoll", report.days, dayWidths);

    pages.forEach((page, i) => {
      commands = page;
      rect(margin, footerTop - 5, bodyWidth, 1, ".9 .81 .57");
      text(report.credit, margin, footerTop - 17, 8, true);
      text((i + 1) + " / " + pages.length, width - margin - 42, footerTop - 17, 8);
      footerLines.forEach((line, j) => text(line, margin, footerTop - 29 - j * 10, 8));
    });

    // All PDF strings are ASCII, including the image's ASCIIHex stream and WinAnsi text escapes.
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    ];
    const stream = (data, dictionary = "") => "<< /Length " + data.length + " " + dictionary + " >>\nstream\n" + data + "\nendstream";
    let logoResource = "";
    if (logo) {
      const jpeg = atob(logo.url.split(",")[1]);
      const hex = Array.from(jpeg, (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("") + ">";
      const id = objects.push(stream(hex, "/Type /XObject /Subtype /Image /Width " + logo.size +
        " /Height " + logo.size + " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /DCTDecode]"));
      logoResource = " /XObject << /Logo " + id + " 0 R >>";
    }
    const kids = pages.map((page) => {
      const dataId = objects.push(stream(page.join("\n")));
      return objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + width + " " + height +
        "] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>" + logoResource + " >> /Contents " + dataId + " 0 R >>") + " 0 R";
    });
    objects[1] = "<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + kids.length + " >>";
    let pdf = "%PDF-1.4\n";
    const offsets = objects.map((object, i) => {
      const offset = pdf.length;
      pdf += (i + 1) + " 0 obj\n" + object + "\nendobj\n";
      return offset;
    });
    const xref = pdf.length;
    pdf += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
    pdf += offsets.map((offset) => String(offset).padStart(10, "0") + " 00000 n \n").join("");
    return pdf + "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  }

  async _downloadExport(format) {
    if (this._deletingSite || this._refreshingExport) return;
    const report = this._exportReport();
    const totals = [["Arbeitstage gesamt", report.total], ...report.measures, ...report.details];
    const person = report.person.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
      .slice(0, 60).replace(/^-+|-+$/g, "");
    const filename = ["steuertage", person, this._exportFrom, this._exportTo].filter(Boolean).join("-") + "." + format;
    let content;
    let mime = "text/plain;charset=utf-8";
    if (format === "csv") {
      const cell = (value) => {
        const text = String(value);
        const safe = typeof value === "string" && /^[ \t\r\n]*[=+\-@\t\r\n]/.test(text) ? "'" + text : text;
        return '"' + safe.replaceAll('"', '""') + '"';
      };
      content = "\ufeff" + [
        ["Steuertage", report.period, report.person, "Erstellt am " + report.generated],
        [], ["Gesamtübersicht", "Tage"], ...totals,
        [], ["Tagesprotokoll"], report.days.headers, ...report.days.values,
        [], [report.credit], ["Hinweis", report.notice],
      ].map((row) => row.map(cell).join(";")).join("\r\n");
      mime = "text/csv;charset=utf-8";
    } else if (format === "txt") {
      const summary = [["Arbeitstage gesamt", report.total], ...report.measures, ...report.notes, ...report.statuses];
      const siteSection = [];
      if (this._relevantSiteCount(report.siteGroups) > 1) {
        const groups = [...report.siteGroups].sort((a, b) => (a.ids.length || Infinity) - (b.ids.length || Infinity));
        const officeDays = groups.reduce((total, group) => total + group.days, 0);
        siteSection.push("", "Arbeitsstätte (" + officeDays + ") sortiert nach Orten:");
        for (const { ids, days } of groups) {
          const label = this._siteNames(ids).map((name) => "Standort " + name).join(" + ");
          siteSection.push((label || "Nicht zugeordnet (Arbeitsstätte)") + ": " + days);
        }
      }
      const table = ({ headers, values }) => [headers, ...values].map((row) => row.join(" | ")).join("\n");
      content = [
        "Steuertage · Auswertung", report.person, report.period, "Erstellt am " + report.generated,
        "", "GESAMTÜBERSICHT", ...summary.map(([label, value]) => label + ": " + value), ...siteSection,
        "", "MONATSÜBERSICHT", table(report.months),
        "", "TAGESPROTOKOLL", table(report.days),
        "", "────────────────────────────────────────", report.credit, report.notice,
      ].join("\n");
    } else {
      const logo = await this._exportLogo();
      if (format === "pdf") {
        content = this._exportPdf(report, logo);
        mime = "application/pdf";
      } else {
        content = this._exportHtml(report, logo);
        mime = "text/html;charset=utf-8";
      }
    }
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  _scrollPositions() {
    const scrollers = new Set();
    for (let element = this; element; element = element.parentElement || element.getRootNode().host) {
      if (element.scrollTop > 0) scrollers.add(element);
    }
    if (document.scrollingElement?.scrollTop > 0) scrollers.add(document.scrollingElement);
    return Array.from(scrollers, (element) => ({ element, top: element.scrollTop }));
  }

  _calendarEditorTop() {
    const editor = this.shadowRoot.querySelector(".selection-card");
    if (!editor) return null;
    const { top, bottom } = editor.getBoundingClientRect();
    return bottom > 0 && top < window.innerHeight ? top : null;
  }

  _updateView(markup) {
    this._viewListeners?.abort();
    this._viewListeners = new AbortController();
    // Keep the shared header and the active controls connected on every tab.
    const template = document.createElement("template");
    template.innerHTML = markup;
    this._updateViewChildren(this._view, template.content);
  }

  _updateViewChildren(current, incoming) {
    const key = (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return node.nodeType;
      const identity = node.dataset?.action ?? node.dataset?.type ?? node.dataset?.officeSite ?? node.dataset?.date ??
        node.dataset?.calendar ?? node.dataset?.reviewDate ?? node.dataset?.rangeWeekday ??
        node.dataset?.rangePreset ?? node.dataset?.disclosureId ?? node.dataset?.tab ??
        node.dataset?.year ?? node.dataset?.period ?? node.dataset?.download ??
        (node.localName === "option" ? node.value : node.classList[0]) ?? "";
      return node.tagName + ":" + identity;
    };
    const available = new Map();
    for (const child of current.childNodes) {
      const id = key(child);
      if (!available.has(id)) available.set(id, []);
      available.get(id).push(child);
    }
    const children = Array.from(incoming.childNodes, (next) => ({
      next, previous: available.get(key(next))?.shift(),
    }));
    for (const unmatched of available.values()) {
      for (const child of unmatched) child.remove();
    }
    let position = current.firstChild;
    for (const { next, previous } of children) {
      const child = previous ?? next;
      if (child !== position) current.insertBefore(child, position);
      position = child.nextSibling;
      if (!previous || child.isEqualNode(next)) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.nodeValue = next.nodeValue;
        continue;
      }
      for (const name of child.getAttributeNames()) {
        if (!next.hasAttribute(name) && !(child.localName === "details" && name === "open")) {
          child.removeAttribute(name);
        }
      }
      for (const { name, value } of next.attributes) {
        if (child.getAttribute(name) !== value) {
          child.setAttribute(name, value);
          if (name === "value" && child.localName === "input") child.value = value;
        }
      }
      const selectedValue = child.localName === "select" ? next.value : null;
      this._updateViewChildren(child, next);
      if (selectedValue !== null && child.value !== selectedValue) child.value = selectedValue;
    }
  }

  _render({ preserveEditorPosition = false } = {}) {
    if (!this._hass) return;
    const scrollPositions = this._scrollPositions();
    const exportPeriod = this._tab === "export" && scrollPositions.length
      ? this.shadowRoot.querySelector(".export-period")
      : null;
    const exportPeriodRect = exportPeriod?.getBoundingClientRect();
    const editorTop = this._tab === "calendar" && (preserveEditorPosition || this._busy)
      ? this._calendarEditorTop()
      : null;
    const locale = this._hass.locale?.language || "de-DE";
    const title = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(this._month);
    const selectedEvent = this._eventForDay(this._selected);
    const monthStats = this._monthStats();
    const officeSites = this._officeSites();
    const monthSiteIds = new Set(this._events.flatMap((event) => this._type(event) === "office" ? this._siteIds(event) : []));
    const legendSites = officeSites.filter((site) => site.active || monthSiteIds.has(site.id));
    const showSiteNumbers = legendSites.length > 1 || legendSites.some((site) => !site.active);
    const homeOfficeEnabled = this._homeOfficeEnabled();
    const showHomeOfficeLegend = homeOfficeEnabled ||
      (this._calendarEntity()?.attributes?.worklog_homeoffice_years || []).includes(this._month.getFullYear());
    const monthStatItems = [
      { label: "Arbeitstage", value: monthStats.workdays },
      { label: "Arbeitsstätte", value: monthStats.office },
      ...(homeOfficeEnabled ? [{ label: "Homeoffice", value: monthStats.homeOffice }] : []),
      ...(homeOfficeEnabled && monthStats.mixed ? [{ label: "Davon Mischtage", value: monthStats.mixed }] : []),
      ...(monthStats.businessTrips > 0 ? [{ label: "Dienstreisen", value: monthStats.businessTrips }] : []),
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
    const openReviewTypes = new Set(openReviewItems.map((event) => this._type(event)));
    const openReviewTitle = openReviewTypes.size > 1
      ? "Erkennung und Prüftage"
      : openReviewTypes.has("tracking") ? "Laufende Erkennung" : "Offene Prüftage";
    const openReviewMarkup = openReviewItems.length
      ? "<section class='open-review-card'><div class='open-review-heading'><div><span class='eyebrow'>DIESER MONAT</span><strong>" + openReviewTitle + "</strong></div><span class='open-review-count'>" + openReviewItems.length + "</span></div><div class='open-review-days'>" +
        openReviewItems.slice(0, 8).map((event) => {
          const date = (event.start || "").slice(0, 10);
          const type = this._type(event);
          return "<button class='review-day-chip " + (type === "needs_review" ? "needs-review" : "tracking") + "' data-review-date='" + date + "'><span>" +
            this._formatDate(date) + "</span><small>" + (type === "needs_review" ? "Bitte prüfen" : TRACKING_STATUS_LABEL) + "</small></button>";
        }).join("") +
        (openReviewItems.length > 8 ? "<span class='review-more'>+" + (openReviewItems.length - 8) + " weitere</span>" : "") +
        "</div></section>"
      : "";
    const detectedType = this._type(selectedEvent);
    const automaticSelection = !selectedEvent ||
      !(selectedEvent.description || "").includes("Manuell geändert zu:");
    const selectedType = automaticSelection ? "automatic" : detectedType;
    const detectedLabel = detectedType === "tracking" ? TRACKING_STATUS_LABEL : this._label(detectedType);
    const selectedTypeLabel = (detectedType ? detectedLabel : "Noch kein Eintrag") +
      (this._isMixedEvent(selectedEvent) ? " · Mischtag" : "");
    const selectedDates = this._selectedDates || new Set(this._selected ? [this._selected] : []);
    const selectedDateCount = selectedDates.size;
    const holidayRegion = this._holidayRegion();
    const holidayDates = holidayRegion?.key === this._holidayRegionKey ? this._holidayDates : {};
    const selectedHoliday = selectedDateCount === 1 && holidayDates[this._selected]
      ? "<p class='selection-status'>Feiertag · " + this._escape(holidayDates[this._selected]) + "</p>"
      : "";
    const rangeWeekdays = this._rangeWeekdays();
    const editHistory = this._editHistoryForCurrentPerson();
    const historyButtonsMarkup = "<div class='calendar-history-controls' aria-label='Kalenderänderungen'>" +
      "<button type='button' class='history-button' data-action='undo' aria-label='Rückgängig' title='Rückgängig' " +
      (!editHistory.undo.length || this._busy ? "aria-disabled='true'" : "") + "><span class='history-symbol' aria-hidden='true'>↶</span></button>" +
      "<button type='button' class='history-button' data-action='redo' aria-label='Wiederholen' title='Wiederholen' " +
      (!editHistory.redo.length || this._busy ? "aria-disabled='true'" : "") + "><span class='history-symbol' aria-hidden='true'>↷</span></button></div>";
    const monthStatsRows = Math.ceil(monthStatItems.length / 2);
    const monthStatsMarkup = "<div class='stats calendar-month-stats' style='--month-stat-rows:" + monthStatsRows + "'>" +
      monthStatItems.map((item) => "<div class='stat'><span>" + item.label + "</span><strong>" + item.value + "</strong></div>").join("") +
      "</div>";
    const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];
    const selectionCountLabel = selectedDateCount + (selectedDateCount === 1 ? " Tag ausgewählt" : " Tage ausgewählt");
    const selectionControlsMarkup = "<div class='selection-mode-controls'>" +
      "<button type='button' class='multi-select-toggle' data-action='multi-select' aria-pressed='" + this._multiSelectMode + "' title='Mehrfachauswahl ein- oder ausschalten'>" + this._desktopMultiSelectLabel() + "</button>" +
      "<button type='button' class='clear-selection' data-action='clear-selection'" + (selectedDateCount < 2 ? " hidden" : "") + " title='Auswahl aufheben'>Auswahl aufheben</button></div>";
    const mobileSelectionCount = selectedDateCount ? "<span class='mobile-range-count'>(" + selectedDateCount + (selectedDateCount === 1 ? " Tag" : " Tage") + ")</span>" : "";
    const mobileSelectionButton = "<button type='button' class='mobile-multi-toggle multi-select-toggle' data-action='mobile-multi-select' aria-pressed='" + this._multiSelectMode + "'>" +
      this._mobileMultiSelectLabel(selectedDateCount) + "</button>";
    const rangeFilterMarkup = "<section class='range-filter' aria-label='Wochentage für Bereichsauswahl'><div class='mobile-range-heading'><strong>Auswahlbereich</strong>" + mobileSelectionCount + "</div><div class='range-filter-heading'><strong>Bereichsauswahl</strong><span class='range-filter-count'>" + selectionCountLabel + "</span></div><div class='range-filter-actions'>" + selectionControlsMarkup + "<div class='range-filter-end'>" + historyButtonsMarkup + "<div class='range-filter-presets'><button type='button' data-range-preset='weekdays' title='Samstag und Sonntag für Zeiträume ausschließen'>Wochenende auslassen</button><button type='button' data-range-preset='all' title='Alle Wochentage für Zeiträume berücksichtigen'>Alle Tage</button></div></div></div>" + mobileSelectionButton + "</section>";
    const monthStart = new Date(this._month.getFullYear(), this._month.getMonth(), 1);
    const offset = (monthStart.getDay() + 6) % 7;
    const gridStart = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1 - offset);
    const todayIso = this._isoDate(new Date());
    const dayNames = new Intl.DateTimeFormat(locale, { weekday: "short" });
    const fullDayNames = new Intl.DateTimeFormat(locale, { weekday: "long" });
    let headers = "";
    let mobileWeekdayHeaders = "";
    for (let i = 0; i < 7; i++) {
      const weekday = new Date(2024, 0, 1 + i);
      const day = weekdayOrder[i];
      const active = rangeWeekdays.has(day);
      const weekendLabel = i >= 5 ? " weekend-label" : "";
      const fullName = this._escape(fullDayNames.format(weekday)).replaceAll("'", "&#39;");
      headers += "<button type='button' class='weekday range-weekday" + weekendLabel + (active ? " active" : "") +
        "' data-range-weekday='" + day + "' aria-pressed='" + active + "' aria-label='" +
        fullName + " für Bereichsauswahl'>" + this._escape(dayNames.format(weekday)) +
        "<span class='weekday-check' aria-hidden='true'>✓</span></button>";
      mobileWeekdayHeaders += "<div class='weekday mobile-weekday" + weekendLabel + "'>" + this._escape(dayNames.format(weekday)) + "</div>";
    }
    let cells = "";
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const iso = this._isoDate(d);
      const holidayTitle = holidayDates[iso] ? "Feiertag: " + this._escape(holidayDates[iso]).replaceAll("'", "&#39;") : "";
      const event = this._eventForDay(iso);
      const type = this._type(event);
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
      const manuallyChanged = (event?.description || "").includes("Manuell geändert");
      const mixedDay = this._isMixedEvent(event);
      const siteIds = type === "office" && showSiteNumbers ? this._siteIds(event) : [];
      const siteMarks = this._orderedSites(siteIds).map((site) => this._siteNumber(site)).join("");
      const cls = ["day", holidayTitle ? "holiday" : "", isWeekend ? "weekend" : "", type ? "type-" + type : "", manuallyChanged ? "manual" : "", mixedDay ? "mixed" : "", d.getMonth() !== this._month.getMonth() ? "outside" : "", iso === todayIso ? "today" : "", iso === this._selected ? "selected" : "", selectedDates.has(iso) ? "range-selected" : ""].filter(Boolean).join(" ");
      cells += "<button class='" + cls + "' data-date='" + iso + "'" +
        (holidayTitle ? " title='" + holidayTitle + "'" : "") +
        " aria-label='" + this._formatDate(iso) + (event ? ": " + this._label(type) : "") +
        (mixedDay ? ", Mischtag" : "") + (siteIds.length ? ", " + this._escape(this._siteNames(siteIds).join(", ")).replaceAll("'", "&#39;") : "") + (manuallyChanged ? ", manuell geändert" : "") +
        (holidayTitle ? ", " + holidayTitle : "") + "'>" +
        (siteMarks ? "<span class='office-site-mark' title='" + this._escape(this._siteNames(siteIds).join(", ")).replaceAll("'", "&#39;") + "' aria-hidden='true'>" + siteMarks + "</span>" : "") +
        "<span class='day-number'>" + d.getDate() + "</span>" +
        (holidayTitle ? "<span class='holiday-symbol holiday-mark' aria-hidden='true'>F</span>" : "") + (mixedDay ? "<span class='mixed-mark' aria-hidden='true'>M</span>" : "") + (manuallyChanged ? "<span class='manual-mark' title='Manuell geändert' aria-hidden='true'>✦</span>" : "") + "</button>";
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
          const siteChange = this._siteChangeMarkup(change);
          return "<li><time>" + this._escape(displayTime) + "</time> · " + who + ": " + from + " → " + to + siteChange + "</li>";
        }).join("") + "</ul></details>"
      : "";
    const orderedSelectedDates = [...selectedDates].sort();
    const numericDate = (date) => this._formatDate(date, {
      day: "2-digit", month: "2-digit", year: "numeric",
    });
    const selectionTitle = selectedDateCount > 1
      ? numericDate(orderedSelectedDates[0]) + " bis " + numericDate(orderedSelectedDates.at(-1))
      : this._formatDate(this._selected);
    const typeButton = (type, label, icon) =>
      "<button type='button' class='type-option " + (selectedType === type ? "selected-type" : "") +
      "' data-type='" + type + "'" + (this._busy ? " aria-disabled='true'" : "") + " aria-pressed='" + (selectedType === type ? "true" : "false") + "'>" +
      "<span class='type-symbol' aria-hidden='true'>" + icon + "</span><span class='type-label'>" + label +
      "</span>" + (selectedType === type ? "<span class='type-check' aria-hidden='true'>✓</span>" : "") + "</button>";
    const typeButtons = [
      typeButton("office", "Arbeitsstätte", "<svg viewBox='0 0 24 24' focusable='false' aria-hidden='true'><path d='M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z'/></svg>"),
      ...(homeOfficeEnabled ? [typeButton("home_office", "Homeoffice", "⌂")] : []),
      typeButton("business_trip", "Dienstreise", "<ha-icon icon='mdi:briefcase-outline' aria-hidden='true'></ha-icon>"),
      typeButton("vacation", "Urlaub", "☀"),
      typeButton("sick_leave", "Krankheit", "<ha-icon icon='mdi:thermometer' aria-hidden='true'></ha-icon>"),
      typeButton("no_work", "Kein Arbeitstag", "—"),
    ].join("");
    const rangeMarkup = this._selectionMode === "range" && selectedDateCount > 1
      ? "<div class='date-range'><label>Von<input data-correction-from type='date' value='" + (this._correctionFrom || this._selected) + "'></label><label>Bis<input data-correction-to type='date' value='" + (this._correctionTo || this._selected) + "'></label></div>"
      : "";
    const officeSelectionDates = [...selectedDates].filter((date) => this._type(this._eventForDay(date)) === "office");
    const selectionSites = officeSelectionDates.map((date) => this._siteIds(this._eventForDay(date)));
    const pickerSites = officeSites.filter((site) => site.active || selectionSites.some((ids) => ids.includes(site.id)));
    const soleSite = officeSites.length === 1 && officeSites[0].active ? officeSites[0] : null;
    const showSitePicker = !soleSite && (pickerSites.length > 1 || pickerSites.some((site) => !site.active) ||
      (detectedType === "office" && !this._siteIds(selectedEvent).length));
    const sitePickerMarkup = showSitePicker && officeSelectionDates.length > 0
      ? "<fieldset class='office-site-picker'><legend>Arbeitsstandorte</legend><div class='type-options'>" +
        pickerSites.map((site) => {
          const assigned = selectionSites.filter((ids) => ids.includes(site.id)).length;
          const pressed = assigned === officeSelectionDates.length ? "true" : assigned ? "mixed" : "false";
          return "<button type='button' class='type-option " + (pressed === "true" ? "selected-type" : "") +
            "' data-office-site='" + this._escape(site.id).replaceAll("'", "&#39;") + "' aria-pressed='" + pressed + "'>" +
            this._siteNumber(site) + "<span class='type-label'>" + this._escape(site.name) +
            "</span><span class='type-check' aria-hidden='true'>" +
            (pressed === "true" ? "✓" : pressed === "mixed" ? "−" : "") + "</span></button>";
        }).join("") + "</div>" +
        (officeSelectionDates.length === 1 && !selectionSites[0].length ? "<small>Nicht zugeordnet</small>" : "") +
        "</fieldset>" : "";
    const selectedPanelMarkup = this._selected
      ? "<section class='selection-card' aria-label='Tagestyp ändern'>" +
        "<header class='selection-card-header'><h3>" + this._escape(selectionTitle + (selectedDateCount === 1 ? " - " + selectedTypeLabel : "")) + "</h3>" +
        (selectedDateCount > 1 ? "<span class='selection-count'>" + selectedDateCount + " Tage</span>" : "") + "</header>" +
        "<div class='selection-tools'><button type='button' class='automatic-button" +
        (selectedType === "automatic" ? " selected-type" : "") + "' data-type='automatic'" +
        (this._busy ? " aria-disabled='true'" : "") + " aria-pressed='" + (selectedType === "automatic") +
        "' title='Automatische Erkennung verwenden'><span aria-hidden='true'>↻</span>" +
        "<span class='automatic-title'><span class='automatic-title-current'>Automatik</span>" +
        "<span class='automatic-title-reset'>Zurück zur Automatik</span></span>" +
        "<span class='automatic-standard'>Standard</span></button>" + rangeMarkup + "</div>" +
        "<div class='type-options' role='group' aria-label='Tagestyp manuell festlegen'>" + typeButtons + "</div>" + sitePickerMarkup +
        selectedHoliday +
        (selectedHistoryMarkup ? "<div class='selection-history'>" + selectedHistoryMarkup + "</div>" : "") +
        "<p class='message' role='status'" + (this._message ? "" : " hidden") + ">" + this._escape(this._message) + "</p></section>"
      : "";
    const tab = this._tab;
    const panelConfig = this._panel?.config;
    const buildLabel = /(?:^|[-.])beta(?:[.\d-]|$)/i.test(panelConfig?.version || "")
      ? "BETA"
      : panelConfig?.development ? "DEV" : "";
    const buildBadge = buildLabel ? "<span class='header-badge'>" + buildLabel + "</span>" : "";
    const calendarHeaderMarkup = "<div class='calendar-overview'><div class='calendar-head'><h2>" + title + "</h2><div class='calendar-navigation'>" +
      "<div class='month-nav-group' role='group' aria-label='Monat wechseln'>" +
      "<button class='month-nav' data-action='prev' aria-label='Vorheriger Monat'>‹</button>" +
      "<button class='today-nav' data-action='today' aria-label='Zum heutigen Datum springen'>Heute</button>" +
      "<button class='month-nav' data-action='next' aria-label='Nächster Monat'>›</button></div></div></div>" +
      monthStatsMarkup + "</div>";
    const siteLegendMarkup = showSiteNumbers
      ? "<div class='office-site-legend'><strong>Arbeitsstandorte</strong><div>" +
        this._siteNames(legendSites.map((site) => site.id), { markup: true }).join("") + "</div>" +
        "</div>" : "";
    const content = tab === "calendar"
      ? (this._calendarEntity() ? "<ha-card class='calendar-view'>" + calendarTabs + calendarHeaderMarkup +
        openReviewMarkup + rangeFilterMarkup + "<div class='grid'>" + headers + mobileWeekdayHeaders + cells + "</div>" +
        selectedPanelMarkup + (selectedPanelMarkup ? "" :
          "<div class='calendar-legend'><div class='legend-status'><strong>Legende</strong><span><i class='legend-dot office-dot'></i>Arbeitsstätte</span>" + (showHomeOfficeLegend ? "<span><i class='legend-dot home-dot'></i>Homeoffice</span>" : "") + "<span><i class='legend-dot business-trip-dot'></i>Dienstreise</span><span><i class='legend-dot vacation-dot'></i>Urlaub</span><span><i class='legend-dot sick-dot'></i>Krankheit</span><span><i class='legend-dot no-work-dot'></i>Kein Arbeitstag</span><span class='legend-divider' aria-hidden='true'></span><span class='legend-pulse'><i class='legend-dot tracking-dot'></i>Erkennung läuft</span><span><i class='mixed-legend-mark'>M</i>Mischtag</span>" + (holidayRegion ? "<span><i class='holiday-symbol' aria-hidden='true'>F</i>Feiertag</span>" : "") + "<span><i class='manual-legend-mark' aria-hidden='true'>✦</i>Manuell geändert</span></div>" + siteLegendMarkup + "</div>") + "<p class='muted calendar-help calendar-help-desktop'>Für einzelne Tage nutze ⌘ (Mac) oder Strg (Windows/Linux) mit Klick oder schalte „Mehrfachauswahl“ ein. Einen Zeitraum markierst du durch Ziehen oder mit Umschalt-Klick. Die Wochentage im Kalenderkopf filtern nur Zeiträume; „Wochenende auslassen“ und „Alle Tage“ setzen diese Filter. Feiertage bleiben enthalten. Änderungen kannst du mit ↶ zurücknehmen und mit ↷ wiederholen.</p><p class='muted calendar-help calendar-help-mobile'>Tippe auf „Mehrfachauswahl“ und wähle Tage einzeln aus. Mit „Auswahl aufheben“ beendest du den Modus und entfernst die Markierungen. Feiertage bleiben auswählbar. ↶ und ↷ nehmen Änderungen zurück oder wiederholen sie.</p></ha-card>" : calendars.length > 1 ? "<ha-card>" + calendarTabs + "<p>Bitte wähle eine Person aus, um den Kalender zu öffnen.</p></ha-card>" : "<ha-card><p>Es ist noch keine Person für Steuertage eingerichtet.</p></ha-card>")
      : tab === "config" ? this._configMarkup(calendars) : this._exportMarkup(calendars);
    const buttonHoverStyles = `
      @media (hover: hover) {
        button:enabled:not([aria-disabled="true"]):hover,
        .config-info-links a:hover {
          outline: 2px solid var(--primary-color);
          outline-color: color-mix(in srgb, var(--primary-color) 75%, currentColor);
          outline-offset: -2px;
        }
      }
      .config-info-header .dialog-close-button ha-icon {
        display: block; width: 18px; height: 18px; --mdc-icon-size: 18px; pointer-events: none;
      }
      .data-management-dialog [data-automatic-backup] + small { align-self: center; color: var(--secondary-text-color); }
      .config-info-support { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--steuertage-divider, var(--divider-color)); }
      .config-info-support h4 { margin: 0 0 4px; font-size: 14px; }
      .config-info-support p { margin: 0; color: var(--steuertage-muted, var(--secondary-text-color)); font-size: 13px; }
      .config-info-support .config-info-links { margin-top: 8px; padding-top: 0; border-top: 0; }
      .config-info-dialog .config-info-links a { gap: 8px; color: color-mix(in srgb, var(--primary-color) 50%, var(--steuertage-text, var(--primary-text-color))); }
      .config-info-dialog .config-info-links a:hover { color: color-mix(in srgb, var(--primary-color) 65%, var(--steuertage-text, var(--primary-text-color))); }
      .config-info-link-icon { display: inline-flex; align-items: center; justify-content: center; min-width: 1.2em; font-size: 1.1em; line-height: 1; }
      button:enabled:not([aria-disabled="true"]):focus-visible,
      .config-info-links a:focus-visible {
        outline: 2px solid var(--primary-color);
        outline-offset: 2px;
      }
      @media (hover: hover) {
        .tabs button:enabled:hover:not(:focus-visible),
        .person-tab:enabled:hover:not(:focus-visible) {
          outline: none;
        }
        .tabs button:enabled:hover { font-weight: 650; }
        .person-tab:enabled:hover { font-weight: 600; }
      }
    `;
    const headerStyles = `
      .top-actions .top-action {
        box-sizing: border-box;
        display: grid;
        place-items: center;
        inline-size: 36px;
        block-size: 36px;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 10px;
        background: transparent;
        color: var(--steuertage-text, var(--primary-text-color));
        cursor: pointer;
      }
      .top-action ha-icon {
        --mdc-icon-size: 21px;
        pointer-events: none;
      }
      .top-actions .top-action:active {
        background: var(--secondary-background-color, var(--steuertage-card-background, var(--card-background-color)));
      }
      .top-actions .top-action:focus-visible {
        outline: 2px solid var(--primary-color);
        outline-offset: 2px;
      }
    `;
    const calendarStyles = `
      .office-site-number {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 1.1em; padding: .2em .3em; border-radius: .38em;
        background: color-mix(in srgb, currentColor 15%, transparent);
        color: inherit; font-size: .81em; line-height: 1; font-weight: 700;
        font-variant-numeric: tabular-nums; flex: none;
      }
      .office-site-mark {
        justify-self: stretch; min-width: 0;
        display: flex; flex-wrap: wrap; gap: 2px; align-content: start;
        font-size: clamp(9px, 2.25vw, 13px); pointer-events: none;
      }
      .office-site-legend {
        display: grid; gap: 5px; padding: 7px 10px; border-radius: 8px;
        background: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
        font-size: 12px;
      }
      .office-site-legend > div { display: flex; flex-wrap: wrap; gap: 4px 12px; }
      .office-site-label { display: inline-flex; gap: 4px; align-items: baseline; }
      .change-log-list li .office-site-label { display: inline-flex; gap: 4px; }
      .change-log-list li .office-site-number { display: inline-flex; }
      .office-site-picker { min-width: 0; margin: 2px 0; padding: 7px 8px; border: 1px solid var(--divider-color); border-radius: 8px; }
      .office-site-picker legend { font-size: 12px; font-weight: 600; }
      .office-site-picker small { display: block; margin-top: 4px; color: var(--secondary-text-color); }
      .office-site-picker [aria-pressed='mixed'] { border-color: var(--primary-color); }
      .office-site-picker .type-label { overflow-wrap: anywhere; }
      .site-delete ha-icon { --mdc-icon-size: 18px; }
      .selection-card {
        display: grid;
        gap: 8px;
        margin-top: 10px;
        padding: 10px 12px;
        border: 1px solid var(--divider-color);
        border-radius: 12px;
        background: var(--secondary-background-color, var(--card-background-color, Canvas));
      }
      .selection-card-header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
      }
      .selection-card-header h3 { margin: 0; font-size: 15px; font-weight: 600; }
      .selection-count, .selection-status { color: var(--secondary-text-color); font-size: 12px; }
      .selection-count { white-space: nowrap; }
      .selection-status, .selection-card .message { margin: 0; }
      .selection-history .change-history { margin: 0; }
      .type-options {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 128px), 1fr));
        gap: 6px;
      }
      .type-option, .automatic-button {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 38px;
        padding: 4px 8px;
        border: 1px solid var(--divider-color);
        border-radius: 8px;
        background: var(--card-background-color);
        color: var(--primary-text-color);
        font: inherit;
        font-size: 13px;
        text-align: left;
        cursor: pointer;
      }
      .type-option.selected-type, .automatic-button.selected-type { border-color: var(--primary-color); }
      .type-option.selected-type {
        background: var(--primary-color);
        color: var(--text-primary-color, #fff);
      }
      .type-symbol {
        display: grid;
        flex: none;
        place-items: center;
        width: 18px;
        color: inherit;
        font-size: 16px;
        --mdc-icon-size: 16px;
      }
      .type-option .type-check { margin-left: auto; font-weight: 700; }
      .selection-tools { display: flex; flex-wrap: wrap; align-items: end; gap: 8px 12px; }
      .automatic-button {
        border-color: color-mix(in srgb, var(--primary-color) 60%, var(--divider-color));
        background: color-mix(in srgb, var(--primary-color) 12%, var(--card-background-color, Canvas));
        font-weight: 600;
      }
      .automatic-button.selected-type {
        background: var(--primary-color);
        color: var(--text-primary-color, #fff);
      }
      .automatic-standard {
        margin-inline-start: 2px;
        padding: 2px 6px;
        border: 1px solid currentColor;
        border-radius: 999px;
        font-size: 11px;
        line-height: 1.2;
      }
      .automatic-title { display: grid; }
      .automatic-title > span { grid-area: 1 / 1; }
      .automatic-title-current, .automatic-button.selected-type .automatic-title-reset { visibility: hidden; }
      .automatic-button.selected-type .automatic-title-current { visibility: visible; }
      .selection-tools .date-range { margin: 0; gap: 8px; }
      .selection-tools .date-range label { font-size: 12px; }
      .selection-tools .date-range input { box-sizing: border-box; max-width: 100%; font-size: 13px; }
      @media (max-width: 650px) {
        .selection-card { padding: 8px; }
        .type-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .type-label { min-width: 0; overflow-wrap: anywhere; }
        .type-option, .automatic-button { min-height: 44px; }
      }
      .holiday-symbol {
        display: inline-grid;
        place-items: center;
        inline-size: 14px;
        block-size: 14px;
        box-sizing: border-box;
        border: 1px solid #765500;
        border-radius: 4px;
        background: #f9cc52;
        color: #352600;
        font-size: 9px;
        font-weight: 700;
        font-style: normal;
        line-height: 1;
      }
      .day.holiday {
        display: grid;
        align-content: center;
        justify-items: center;
        row-gap: 2px;
        padding: 2px 0;
      }
      .day:has(.office-site-mark) {
        display: grid; grid-template-rows: auto 1fr; justify-items: center;
        align-items: center; gap: 1px; padding: 5px;
      }
      .day.holiday .day-number { line-height: 1.2; }
      .holiday-mark {
        inline-size: 11px;
        block-size: 11px;
        font-size: 8px;
        pointer-events: none;
      }
      .calendar-head > h2, .calendar-head > .calendar-navigation { grid-row: 1; }
      .range-filter-actions .selection-mode-controls { display: flex; flex: none; gap: 6px; }
      .range-filter-actions .calendar-history-controls { display: flex; flex: none; gap: 4px; margin-inline-start: 0; }
      .range-filter-actions .selection-mode-controls button { box-sizing: border-box; min-height: 32px; padding: 5px 9px; font-size: 12px; }
      .range-filter-actions .history-button { box-sizing: border-box; width: 32px; height: 32px; padding: 0; }
      .range-filter-actions .clear-selection[hidden] { display: block; visibility: hidden; pointer-events: none; }
      :is(.export-controls, .selection-tools .date-range) input[type='date'] {
        border: 1px solid var(--steuertage-divider, var(--divider-color));
        box-shadow: none;
      }
      @media (hover: hover) {
        :is(.export-controls, .selection-tools .date-range) input[type='date']:hover:not(:focus) {
          border-color: var(--primary-color);
          outline: 2px solid var(--primary-color);
          outline-color: color-mix(in srgb, var(--primary-color) 75%, currentColor);
          outline-offset: -2px;
        }
      }
      :is(.export-controls, .selection-tools .date-range) input[type='date']:focus {
        border-color: var(--primary-color);
        outline: 2px solid var(--primary-color);
        outline-offset: 2px;
      }
      .history-button {
        display: grid;
        place-items: center;
        box-sizing: border-box;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        color: var(--secondary-text-color);
        cursor: pointer;
      }
      .history-button[aria-disabled="true"], .selection-card [data-type][aria-disabled="true"] {
        opacity: .45;
        cursor: not-allowed;
      }
      .history-symbol { font-size: 16px; line-height: 1; }
      .calendar-help-mobile { display: none; }
      .day { touch-action: manipulation; }
      .day:is(.selected, .range-selected) {
        font-weight: 750;
        opacity: 1;
      }
      .day:is(.selected, .range-selected)::before {
        content: "";
        position: absolute;
        inset: 0;
        border: 3px solid color-mix(in srgb, var(--primary-color, #ec9b2d) 75%, white);
        border-radius: inherit;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .7);
        pointer-events: none;
      }
      .day:is(.selected, .range-selected):focus-visible {
        outline: 2px solid var(--primary-text-color, CanvasText);
        outline-offset: 2px;
      }
      .day.today.type-tracking:is(.selected, .range-selected)::after {
        inset: 5px;
      }
      .day.today.type-tracking::after {
        content: "";
        position: absolute;
        inset: 2px;
        border: 2px solid rgba(255, 255, 255, .9);
        border-radius: 5px;
        pointer-events: none;
        animation: steuertage-today-tracking 1.8s ease-in-out infinite;
      }
      @keyframes steuertage-today-tracking {
        0%, 100% { opacity: .22; }
        50% { opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .day.today.type-tracking::after { animation: none; opacity: .7; }
      }
      @media (max-width: 650px) {
        .calendar-head {
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 8px 6px;
          margin-bottom: 12px;
        }
        .calendar-head > h2 {
          grid-column: 1;
          justify-self: start;
          text-align: start;
          min-width: 0;
          font-size: 17px;
          font-weight: 600;
          line-height: 1.2;
        }
        .calendar-head > .calendar-navigation { grid-column: 2; gap: 4px; }
        .calendar-navigation .month-nav-group { gap: 4px; }
        .calendar-navigation .today-nav, .calendar-navigation .month-nav {
          box-sizing: border-box;
          min-width: 32px;
          min-height: 36px;
          padding: 4px 7px;
          font-size: 13px;
        }
        .calendar-navigation .month-nav { font-size: 20px; line-height: 1; }
        .range-filter-actions .selection-mode-controls { flex: 1 1 auto; }
        .range-filter-actions .selection-mode-controls button { min-height: 44px; font-size: 13px; }
        .history-button {
          width: 36px;
          height: 36px;
          border-color: var(--divider-color);
          background: var(--secondary-background-color, var(--card-background-color));
        }
        .history-symbol { font-size: 18px; }
        .legend-status > .legend-divider {
          flex: 0 0 100%;
          width: auto;
          height: 1px;
        }
        .calendar-view .person-tabs { margin-bottom: 20px; }
        .calendar-view .open-review-card { margin-block: 18px 22px; }
        .calendar-view .grid { gap: 5px; }
        .calendar-view .grid .day { min-height: clamp(48px, 12vw, 54px); padding-block: 5px; }
        .calendar-view .calendar-legend { margin-block: 22px; }
        .calendar-help-desktop { display: none; }
        .calendar-help-mobile { display: block; margin: 16px 0 0; }
      }
      @media (min-width: 651px) {
        .calendar-view .legend-status > .legend-divider {
          flex: 0 0 100%;
          width: auto;
          height: 1px;
          margin-block: 2px;
        }
      }
      .calendar-view .range-filter {
        gap: 8px;
        margin: 12px 0 8px;
        padding: 12px 0 6px;
        border: 0;
        border-top: 1px solid var(--steuertage-divider, var(--divider-color));
        border-radius: 0;
        background: transparent;
      }
      .range-filter-heading { justify-content: flex-start; flex-wrap: wrap; gap: 4px 10px; }
      .range-filter-heading strong { font-size: 13px; }
      .range-filter-heading .range-filter-count {
        display: inline;
        inline-size: 22ch;
        white-space: nowrap;
        color: var(--secondary-text-color);
        font-size: 12px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .range-filter-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
      .range-filter-actions .range-filter-end { display: flex; flex-wrap: nowrap; align-items: center; gap: 6px; margin-left: auto; }
      .range-filter-actions .range-filter-presets { margin-left: 0; }
      .range-filter-actions .calendar-history-controls { margin-left: 0; }
      .range-filter-actions .history-button { min-height: 32px; }
      .range-filter-presets { gap: 4px; margin-left: auto; }
      .range-filter button { min-height: 28px; padding: 4px 9px; border-radius: 6px; font-size: 12px; }
      .calendar-view .weekday.range-weekday {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 2px;
        min-width: 0;
        min-height: 36px;
        padding: 5px 2px;
        border: 1px solid var(--steuertage-divider, var(--divider-color));
        border-radius: 8px;
        background: var(--steuertage-card-background, var(--card-background-color));
        color: var(--steuertage-muted, var(--secondary-text-color));
        font: inherit;
        font-size: 15px;
        font-weight: 650;
        cursor: pointer;
      }
      .calendar-view .weekday.range-weekday.active {
        border-color: color-mix(in srgb, var(--primary-color) 45%, var(--steuertage-divider, var(--divider-color)));
        background: color-mix(in srgb, var(--primary-color) 11%, var(--steuertage-card-background, var(--card-background-color)));
        color: var(--steuertage-text, var(--primary-text-color));
      }
      .weekday-check { visibility: hidden; color: var(--primary-color); font-size: 12px; line-height: 1; }
      .weekday.range-weekday.active .weekday-check { visibility: visible; }
      .mobile-range-heading, .mobile-multi-toggle, .calendar-view .mobile-weekday { display: none; }
      @media (max-width: 650px) {
        .calendar-view .range-filter { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; margin: 10px 0 12px; }
        .calendar-view .range-filter-heading, .calendar-view .range-filter-actions .selection-mode-controls,
        .calendar-view .range-filter-presets, .calendar-view .weekday.range-weekday { display: none; }
        .calendar-view .mobile-range-heading { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
        .mobile-range-heading strong { font-size: 17px; font-weight: 600; line-height: 1.2; }
        .mobile-range-count { color: var(--steuertage-muted, var(--secondary-text-color)); font-size: 11px; font-weight: 500; white-space: nowrap; }
        .calendar-view .range-filter-actions, .calendar-view .range-filter-end { display: contents; }
        .calendar-view .calendar-history-controls { grid-column: 2; grid-row: 1; display: flex; gap: 0; margin: 0; border: 1px solid var(--steuertage-divider, var(--divider-color)); border-radius: 8px; overflow: hidden; }
        .calendar-view .calendar-history-controls .history-button { box-sizing: border-box; width: 38px; height: 40px; min-height: 40px; padding: 0; border: 0; border-radius: 0; background: var(--steuertage-card-background, var(--card-background-color)); }
        .calendar-view .calendar-history-controls .history-button + .history-button { border-left: 1px solid var(--steuertage-divider, var(--divider-color)); }
        .calendar-view .calendar-history-controls .history-symbol { font-size: 16px; }
        .calendar-view .mobile-multi-toggle { display: block; grid-column: 1 / -1; grid-row: 2; box-sizing: border-box; width: 100%; min-height: 44px; margin: 0; text-align: center; font-size: 13px; }
        .calendar-view .mobile-multi-toggle[aria-pressed='true'] { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
        .calendar-view .mobile-weekday { display: block; }
      }
      @media (max-width: 650px) and (pointer: coarse) {
        .calendar-overview {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 12px 8px;
          margin-bottom: 18px;
        }
        .calendar-overview > .calendar-head { display: contents; }
        .calendar-overview > .calendar-month-stats {
          grid-column: 1 / -1;
          grid-row: 2;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          grid-template-rows: repeat(var(--month-stat-rows), auto);
          grid-auto-flow: column;
          gap: 7px 20px;
          margin: 0;
        }
        .calendar-month-stats .stat {
          flex-direction: row;
          align-items: baseline;
          justify-content: space-between;
          gap: 6px;
          padding: 0;
          border: 0;
          background: transparent;
        }
        .calendar-month-stats .stat span, .calendar-month-stats .stat strong { font-size: 12px; }
        .calendar-month-stats .stat strong { font-weight: 650; }
      }
    `;
    // Keep the stylesheet mounted so replacing the view cannot reset its scroll container.
    if (!this._styles.textContent) {
      this._styles.textContent = ":host{display:block;height:100vh;height:100dvh;overflow-y:auto;overscroll-behavior:contain;overflow-anchor:none;color:var(--steuertage-text,var(--primary-text-color,#202124));background:var(--steuertage-page-background,var(--lovelace-background,var(--primary-background-color,#f5f6f8)));background-attachment:fixed;min-height:100vh;font-family:var(--paper-font-body1_-_font-family,Roboto,Noto,sans-serif)}.page{max-width:1050px;margin:auto;padding:24px}.top{display:flex;align-items:center;gap:14px;margin-bottom:18px;padding:12px 16px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:16px;background:var(--steuertage-card-background,var(--card-background-color));box-shadow:var(--ha-card-box-shadow,0 1px 3px rgba(0,0,0,.06))}.top .top-info-button{margin-left:auto;flex:0 0 36px}.app-mark{width:46px;height:46px;flex:0 0 46px;overflow:hidden;border-radius:12px}.app-mark img{width:100%;height:100%;object-fit:contain}.developer-credit a{color:inherit;text-decoration:none}.developer-credit a:focus-visible{outline:2px solid var(--primary-color);outline-offset:2px}.brand-meta{display:flex;gap:6px;margin-top:5px;color:var(--steuertage-muted,var(--secondary-text-color));font-size:11px}.brand{display:grid;gap:2px}.top h1{font-size:24px;font-weight:500;margin:0}.brand p{margin:0;color:var(--secondary-text-color);font-size:14px}.tabs{display:flex;gap:8px;flex-wrap:wrap;padding:5px;margin:0 0 20px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:14px;background:var(--secondary-background-color,var(--steuertage-card-background));box-shadow:var(--ha-card-box-shadow,0 1px 2px rgba(0,0,0,.05))}.tabs button,.actions button,.month-nav,.today-nav,.multi-select-toggle,.clear-selection{font:inherit;color:var(--primary-text-color);background:var(--ha-card-background,var(--card-background-color,Canvas));border:1px solid var(--divider-color);border-radius:8px;padding:9px 14px;cursor:pointer}.tabs button{border:0;background:transparent}.tabs button.active{color:var(--primary-color);border-color:var(--primary-color);background:var(--steuertage-card-background,var(--card-background-color));box-shadow:0 1px 4px rgba(0,0,0,.12);font-weight:650}.multi-select-toggle[aria-pressed='true']{background:var(--primary-color);color:var(--text-primary-color,#fff);border-color:var(--primary-color);font-weight:600}.selection-mode-controls{display:flex;align-items:center;gap:8px;flex:none}.clear-selection{color:var(--secondary-text-color);background:transparent}.clear-selection[hidden]{display:none}.actions button.selected-type{background:var(--primary-color);color:var(--text-primary-color,#fff);border-color:var(--primary-color);font-weight:600;box-shadow:0 0 0 2px var(--primary-color)}.export-check{padding:8px 12px;margin:0 0 14px}.export-check h3{font-size:15px;margin:0 0 4px}.export-check .validation.ok{color:var(--success-color,#2e7d32);font-size:13px;margin:0}.export-check.has-issues{border:1px solid var(--error-color);background:var(--ha-card-background,var(--card-background-color))}.export-check.has-issues h3{color:var(--error-color)}.preset-row{display:flex;flex-wrap:wrap;gap:8px;grid-column:1/-1}.actions button.selected-type{background:var(--primary-color);color:var(--text-primary-color,#fff);border-color:var(--primary-color);font-weight:600;box-shadow:0 0 0 2px var(--primary-color)}.export-check{padding:8px 12px;margin:0 0 14px}.export-check h3{font-size:15px;margin:0 0 4px}.export-check .validation.ok{color:var(--success-color,#2e7d32);font-size:13px;margin:0}.preset-row{display:flex;flex-wrap:wrap;gap:8px;grid-column:1/-1}.view-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin:0 0 20px}.view-header h2{font-size:26px;line-height:1.2;font-weight:650;margin:2px 0 7px;letter-spacing:-.02em}.view-header p{margin:0;color:var(--steuertage-muted,var(--secondary-text-color));font-size:14px;line-height:1.5}.eyebrow{display:block;color:var(--primary-color);font-size:11px;font-weight:700;letter-spacing:.09em;margin-bottom:4px}.header-badge{border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:999px;padding:7px 11px;color:var(--steuertage-muted,var(--secondary-text-color));font-size:12px;white-space:nowrap}.header-actions{display:flex;align-items:center;gap:8px}.info-icon-button,.dialog-close-button{display:grid;place-items:center;width:36px;height:36px;padding:0;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:50%;background:var(--steuertage-card-background,var(--card-background-color));color:var(--steuertage-text,var(--primary-text-color));font:inherit;font-size:20px;line-height:1;cursor:pointer}.info-icon-button:focus-visible,.dialog-close-button:focus-visible{border-color:var(--primary-color);outline:2px solid var(--primary-color);outline-offset:2px}.config-info-dialog{width:min(620px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:86vh;margin:auto;padding:0;overflow:auto;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:18px;background:var(--steuertage-card-background,var(--card-background-color,#fff));color:var(--steuertage-text,var(--primary-text-color));box-shadow:0 18px 60px rgba(0,0,0,.3)}.config-info-dialog::backdrop{background:rgba(0,0,0,.46);backdrop-filter:blur(2px)}.config-info-dialog-content{padding:22px}.config-info-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}.config-info-header h3{margin:2px 0;font-size:20px}.config-info-dialog .explanation-card{margin:0;padding:0;border:0;background:transparent;box-shadow:none}.config-info-links{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px;padding-top:16px;border-top:1px solid var(--steuertage-divider,var(--divider-color))}.config-info-links a{display:inline-flex;align-items:center;padding:9px 12px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:10px;color:var(--primary-color);text-decoration:none;font-weight:600}@media(max-width:600px){.config-info-dialog-content{padding:18px}.config-info-links a{width:100%;justify-content:center}}.config-card{padding:26px;border-radius:18px;background:var(--steuertage-card-background,var(--card-background-color,#fff));box-shadow:var(--ha-card-box-shadow,0 1px 3px rgba(0,0,0,.08))}.config-title{align-items:flex-start}.config-title h3{font-size:18px;font-weight:650}.settings-link{display:inline-flex;align-items:center;gap:6px;border-radius:9px;padding:8px 12px;background:var(--secondary-background-color,var(--primary-background-color));text-decoration:none;font-weight:600}.config-card dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:26px}.config-card dt,.config-card dd,.config-card h3{-webkit-user-select:text;user-select:text}.config-card dl>div{display:flex;flex-direction:column;justify-content:center;gap:11px;min-height:88px;padding:18px 20px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:11px;background:var(--secondary-background-color,var(--steuertage-card-background))}.config-card dt{font-size:12px;line-height:1.4;margin:0;color:var(--steuertage-muted,var(--secondary-text-color))}.config-card dd{font-size:14px;line-height:1.5;font-weight:550;margin:0;overflow-wrap:anywhere}.validation.ok{border-inline-start:3px solid var(--success-color,#43a047)}.validation.warning{border-inline-start:3px solid var(--error-color,#db4437)}.explanation-card{margin-top:20px;padding:20px;border-radius:16px}.export-period{padding:18px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:16px;background:var(--steuertage-card-background,var(--card-background-color,#fff))}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.section-heading h3{margin:0;font-size:17px}.person-picker{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--primary-color);border-radius:12px;background:var(--secondary-background-color,var(--steuertage-card-background));font-weight:650}.person-picker span{font-size:13px;color:var(--steuertage-muted,var(--secondary-text-color))}.person-picker select{min-width:150px;padding:8px 10px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:8px;background:var(--steuertage-card-background,var(--card-background-color));color:var(--steuertage-text,var(--primary-text-color));font:inherit;font-weight:650}.backup-card{margin-top:18px}.backup-card [data-backup]{font-weight:700}.export-controls{margin:12px 0 0}.preset-row{width:100%;padding:4px 0 6px}.preset-row .export-button{border-radius:999px;background:var(--secondary-background-color,var(--steuertage-card-background));font-weight:600}.export-button{transition:transform .14s ease,box-shadow .14s ease,border-color .14s ease}.export-stats .stat{border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:14px;padding:16px;background:var(--steuertage-card-background,var(--card-background-color,#fff))}.export-stats .stat strong{font-size:24px}.export-check{border-radius:12px}.disclaimer{border-radius:0 10px 10px 0}.app-disclaimer{margin:24px 2px 8px;padding:12px 2px 0;border-top:1px solid var(--steuertage-divider,var(--divider-color));color:var(--steuertage-text,var(--primary-text-color));font-size:11px;line-height:1.55;text-align:center}@media(max-width:700px){.page{padding:14px}.view-header{gap:8px}.view-header h2{font-size:22px}.header-badge{font-size:11px}.config-card dl{grid-template-columns:1fr}.config-title{flex-direction:column}.export-period{padding:14px}ha-card{padding:16px}}ha-card{display:block;background:var(--steuertage-card-background,var(--ha-card-background,var(--card-background-color,#fff)));color:var(--steuertage-text,var(--primary-text-color,#202124));border:1px solid var(--steuertage-divider,var(--divider-color,#dadce0));border-radius:var(--ha-card-border-radius,16px);padding:24px;box-shadow:var(--ha-card-box-shadow,0 2px 8px rgba(0,0,0,.12))}.calendar-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:16px}.calendar-head h2{flex:1;text-align:center;font-size:20px;font-weight:500;margin:0;text-transform:capitalize}.month-nav-group{display:flex;gap:6px;flex:0 0 auto}.grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}.weekday{text-align:center;color:var(--secondary-text-color);font-size:13px;padding:8px 0}.legend{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:14px;color:var(--secondary-text-color);font-size:13px}.legend span{display:inline-flex;align-items:center;gap:6px}.legend-dot{width:11px;height:11px;border-radius:50%;display:inline-block}.office-dot{background:var(--info-color,#039be5)}.home-dot{background:var(--success-color,#43a047)}.vacation-dot{background:var(--warning-color,#fbc02d)}.sick-dot{background:var(--error-color,#db4437)}.tracking-dot,.automatic-dot{background:#8b5cf6}.no-work-dot{background:var(--divider-color,#9e9e9e)}.weekday.weekend-label{color:var(--secondary-text-color);font-weight:600}.day{position:relative;min-height:44px;border:1px solid var(--divider-color);border-radius:8px;background:var(--card-background-color);color:var(--primary-text-color);font:inherit;cursor:pointer;-webkit-user-select:none;user-select:none}.day.weekend{background:color-mix(in srgb,var(--card-background-color,Canvas) 95%,var(--primary-text-color,#202124) 5%);border-bottom:2px solid var(--divider-color)}.day.outside{opacity:.45}.day.today{box-shadow:inset 0 0 0 2px var(--secondary-text-color,#6b7280)}.day.mixed .mixed-mark{position:absolute;right:4px;bottom:3px;font-size:8px;line-height:1;font-weight:700;color:var(--secondary-text-color);opacity:.8}.mixed-legend-mark{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:4px;border:1px solid var(--divider-color);font-size:9px;font-style:normal;font-weight:700;color:var(--secondary-text-color)}.mixed-tag{display:inline-block;margin-left:5px;padding:2px 6px;border:1px solid var(--divider-color);border-radius:999px;font-size:10px;font-weight:600;color:var(--secondary-text-color);white-space:nowrap}.day.manual .manual-mark{position:absolute;top:3px;right:4px;font-size:9px;line-height:1;color:var(--secondary-text-color);opacity:.78;pointer-events:none}.manual-legend-mark{display:inline-flex;align-items:center;justify-content:center;font-size:11px;line-height:1;color:var(--secondary-text-color);opacity:.8;font-style:normal}.person-tabs{display:flex;gap:8px;margin:0 0 16px;border-bottom:1px solid var(--divider-color)}.person-tab{font:inherit;color:var(--secondary-text-color);background:transparent;border:0;border-bottom:2px solid transparent;padding:10px 14px;cursor:pointer}.person-tab[aria-pressed='true']{color:var(--primary-color);border-bottom-color:var(--primary-color);font-weight:600}.config-card,.info-card{border:1px solid var(--divider-color);border-radius:10px;padding:16px;margin:14px 0}.config-title{display:flex;justify-content:space-between;align-items:center;gap:12px}.config-title h3,.info-card h3{margin:0 0 8px;font-size:17px;font-weight:500}.config-title a{color:var(--primary-color)}dl{margin:10px 0 0}.config-card dl>div{display:grid;grid-template-columns:minmax(130px,1fr) 2fr;gap:10px;padding:7px 0;border-top:1px solid var(--divider-color)}dt{color:var(--secondary-text-color)}dd{margin:0;overflow-wrap:anywhere}.info-card li{margin:8px 0}.export-controls{display:flex;align-items:end;flex-wrap:wrap;gap:10px;margin:16px 0}.export-controls label{display:grid;gap:5px;color:var(--secondary-text-color)}.export-controls input,.export-controls select,.export-button{font:inherit;color:var(--primary-text-color);background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:7px;padding:9px 12px}.export-button{cursor:pointer}.export-button:disabled{opacity:.5;cursor:wait}.export-stats{grid-template-columns:repeat(4,minmax(0,1fr));margin-top:16px}.muted{color:var(--secondary-text-color);font-size:13px}.disclaimer{margin-top:16px;padding:12px 14px;border-inline-start:3px solid var(--warning-color,var(--primary-color));background:var(--secondary-background-color,var(--card-background-color,Canvas));color:var(--secondary-text-color);font-size:13px;line-height:1.5}.date-range{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}.date-range label{display:grid;gap:5px;color:var(--secondary-text-color)}.date-range input{font:inherit;color:var(--primary-text-color);background:var(--ha-card-background,var(--card-background-color,Canvas));border:1px solid var(--divider-color);border-radius:7px;padding:8px 10px}.calendar-help{margin:8px 0 16px;text-align:center;font-size:12px}.selection-instructions{margin:8px 0 12px}.validation{padding:10px 12px;border-radius:8px;margin-top:12px}.validation.ok{color:var(--success-color,var(--primary-text-color));background:var(--secondary-background-color,var(--card-background-color,Canvas))}.validation.warning{color:var(--error-color,var(--primary-text-color));background:var(--secondary-background-color,var(--card-background-color,Canvas))}.validation ul{margin-bottom:0}.checklist{padding-left:20px}.checklist li{margin:6px 0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--divider-color)}th{color:var(--secondary-text-color);font-weight:500}.needs-review{background:var(--secondary-background-color)}.tracking-row{background:var(--secondary-background-color)}.manual-tag{display:inline-block;border-radius:10px;background:var(--secondary-background-color);padding:2px 7px;font-size:12px;color:var(--secondary-text-color)}.text-button{border:0;background:transparent;color:var(--primary-color);font:inherit;cursor:pointer;padding:0}.change-history{margin-top:12px;color:var(--secondary-text-color)}.change-history ul{padding-left:20px}.change-history time{font-variant-numeric:tabular-nums}.day.type-office,.day.type-office_and_home_office{background:var(--info-color,#039be5);color:var(--text-primary-color,#fff)}.day.type-home_office{background:var(--success-color,#43a047);color:var(--text-primary-color,#fff)}.day.type-business_trip{background:#943875;color:#fff}.business-trip-dot{background:#943875}.day.type-vacation{background:var(--warning-color,#fbc02d);color:var(--primary-text-color)}.day.type-sick_leave,.day.type-needs_review{background:var(--error-color,#db4437);color:var(--text-primary-color,#fff)}.stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:0 0 16px}.stat{display:flex;flex-direction:column;gap:4px;background:var(--secondary-background-color,var(--card-background-color));border-radius:8px;padding:10px 12px}.stat span{color:var(--secondary-text-color);font-size:12px}.stat strong{font-size:20px;font-weight:500}.selection{border-top:1px solid var(--divider-color);margin-top:20px;padding-top:12px}.selection h3{font-size:17px;margin:0 0 6px}.selection p{color:var(--secondary-text-color)}.actions{display:flex;flex-wrap:wrap;gap:8px}.actions button{padding:8px 10px}.message:empty{display:none}.message{min-height:1em}ha-card>h2{font-weight:500}.page li{margin:8px 0}@media(max-width:600px){.calendar-head{gap:8px}.calendar-head h2{flex-basis:100%;order:-1}.selection-mode-controls{width:100%}.selection-mode-controls .multi-select-toggle{flex:1}.today-nav{flex:0 0 auto}.page{padding:12px}.day{min-height:38px}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.export-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.config-title{align-items:flex-start;flex-direction:column}.grid{gap:3px}.tabs{overflow-x:auto}.tabs button{white-space:nowrap;padding:8px 10px}}.day.type-tracking{background:#8b5cf6;color:#fff}@keyframes steuertage-tracking-pulse{0%{box-shadow:0 0 0 0 rgba(139,92,246,.55)}70%{box-shadow:0 0 0 7px rgba(139,92,246,0)}100%{box-shadow:0 0 0 0 rgba(139,92,246,0)}}@media(max-width:650px){.page{padding:14px}.top{min-width:0}.brand{min-width:0}.brand-meta{flex-wrap:wrap}.config-card{padding:18px}.config-card dl{grid-template-columns:1fr;gap:10px}.config-card dl>div{min-height:0;padding:14px 16px}.legend-shortcuts small{width:100%;margin-left:0}}.calendar-legend{display:grid;gap:14px;margin:18px 8px 20px;padding:16px 18px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:14px;background:var(--secondary-background-color,var(--steuertage-card-background))}.legend-status{display:flex;align-items:center;flex-wrap:wrap;gap:10px 14px}.legend-status>span{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--steuertage-muted,var(--secondary-text-color))}.legend-status>strong{font-size:12px;color:var(--steuertage-text,var(--primary-text-color))}.legend-status small{margin-left:auto;color:var(--steuertage-muted,var(--secondary-text-color));font-size:11px}.legend-status kbd{min-width:19px;padding:2px 6px;text-align:center;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:5px;background:var(--steuertage-card-background,var(--card-background-color));font:inherit;font-size:11px;font-weight:600}.legend-pulse{font-weight:600}.legend-pulse .tracking-dot{animation:steuertage-tracking-pulse 1.8s ease-out infinite}.legend-status>.legend-divider{display:block;flex:0 0 1px;width:1px;height:16px;background:var(--steuertage-divider,var(--divider-color));opacity:.8}/* Compact, consistent configuration rows */.config-card dl{align-items:start;grid-auto-rows:minmax(0,auto);gap:12px;margin-top:20px}.config-card dl>div{display:grid;grid-template-columns:minmax(125px,.9fr) minmax(0,1.5fr);align-items:start;justify-content:initial;gap:8px 14px;min-height:0;padding:14px 16px}.config-card dt{line-height:1.35}.config-card dd{line-height:1.4}@media(max-width:700px){.config-card dl{grid-template-columns:1fr;gap:9px}.config-card dl>div{grid-template-columns:minmax(115px,.8fr) minmax(0,1.2fr);padding:12px 14px}}@media(prefers-reduced-motion:reduce){.legend-pulse .tracking-dot{animation:none}}@media(max-width:650px){.export-period .section-heading{flex-direction:column;align-items:stretch}.person-picker{width:100%;max-width:100%;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr);gap:6px}.person-picker select{width:100%;min-width:0;max-width:100%;box-sizing:border-box}}.backup-feedback{display:flex;align-items:flex-start;gap:12px;margin-top:16px;padding:16px;border:1px solid var(--divider-color);border-radius:14px;background:var(--secondary-background-color,var(--card-background-color))}.backup-feedback-icon{display:grid;place-items:center;width:28px;height:28px;flex:0 0 28px;border-radius:50%;font-weight:700;background:var(--info-color,#1976d2);color:var(--text-primary-color,#fff)}.backup-feedback.success{border-color:var(--success-color,#2e7d32)}.backup-feedback.success .backup-feedback-icon{background:var(--success-color,#2e7d32)}.backup-feedback.error{border-color:var(--error-color,#c62828)}.backup-feedback.error .backup-feedback-icon{background:var(--error-color,#c62828)}.backup-feedback strong{display:block;margin:2px 0 4px}.backup-feedback p{margin:0 0 10px;color:var(--secondary-text-color);line-height:1.5}.backup-actions{display:flex;flex-wrap:wrap;gap:10px}.restore-dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}.export-button.primary{background:var(--primary-color);color:var(--text-primary-color,#fff);border-color:var(--primary-color);font-weight:600}.dialog-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.48)}.restore-dialog{width:min(560px,100%);max-height:min(90vh,760px);overflow:auto;padding:24px;border:1px solid var(--divider-color);border-radius:18px;background:var(--card-background-color,var(--primary-background-color,Canvas));color:var(--primary-text-color);box-shadow:0 18px 60px rgba(0,0,0,.28)}.restore-dialog h3{font-size:22px;margin:4px 0 12px}.restore-summary{padding:12px 14px;border-radius:12px;background:var(--secondary-background-color,var(--primary-background-color));line-height:1.55}.restore-options{display:grid;gap:10px;margin:18px 0 0;padding:14px;border:1px solid var(--divider-color);border-radius:14px}.restore-options legend{padding:0 6px;font-weight:600}.restore-option{display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--divider-color);border-radius:12px;cursor:pointer}.restore-option:has(input:checked){border-color:var(--primary-color);box-shadow:0 0 0 1px var(--primary-color)}.restore-option input{margin:3px 0 0;accent-color:var(--primary-color)}.restore-option span{display:grid;gap:4px}.restore-option small{color:var(--secondary-text-color);line-height:1.45}.restore-progress{color:var(--primary-color);font-weight:600}.open-review-card{display:grid;gap:10px;margin:16px 0;padding:14px 16px;border:1px solid var(--divider-color);border-radius:14px;background:var(--secondary-background-color,var(--card-background-color))}.open-review-heading{display:flex;align-items:center;justify-content:space-between}.open-review-heading>div{display:grid;gap:3px}.open-review-heading strong{font-size:15px}.open-review-count{display:grid;place-items:center;min-width:30px;height:30px;padding:0 8px;border-radius:16px;background:var(--warning-color,#ed9b00);color:var(--text-primary-color,#fff);font-weight:700}.open-review-days{display:flex;flex-wrap:wrap;gap:8px}.review-day-chip{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--divider-color);border-radius:10px;color:var(--primary-text-color);background:var(--card-background-color);font:inherit;text-align:left;cursor:pointer}.review-day-chip small{color:var(--secondary-text-color)}.review-day-chip.needs-review{border-color:var(--error-color,#c62828)}.review-day-chip.tracking{border-color:var(--primary-color)}.review-more{align-self:center;color:var(--secondary-text-color);font-size:13px}.open-review-card.all-clear{display:flex;align-items:center;gap:10px;color:var(--success-color,#2e7d32)}.open-review-card.all-clear strong,.open-review-card.all-clear small{display:block}.open-review-card.all-clear small{margin-top:3px;color:var(--secondary-text-color)}.open-review-check{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--success-color,#2e7d32);color:var(--text-primary-color,#fff);font-weight:700}@media(max-width:600px){.restore-dialog{padding:18px}.restore-dialog-actions{flex-direction:column-reverse}.restore-dialog-actions button{width:100%}}.app-disclaimer{display:grid;justify-items:center;gap:5px;max-width:820px;margin:30px auto 12px;padding:16px 14px 4px;border-top:1px solid var(--steuertage-divider,var(--divider-color));color:var(--steuertage-text,var(--primary-text-color));font-size:11px;line-height:1.55;text-align:center}.app-disclaimer p{margin:0}.disclaimer-label{color:var(--steuertage-text,var(--primary-text-color));font-size:11px;font-weight:700;letter-spacing:.1em}.disclaimer-caveat{font-weight:600}.calendar-head{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;justify-content:initial;flex-wrap:initial}.selection-mode-controls{grid-column:1;justify-self:start;min-width:0}.calendar-head h2{grid-column:2;min-width:max-content;flex:none}.calendar-navigation{grid-column:3;justify-self:end;display:flex;align-items:center;gap:6px}.data-disclosure{margin:12px 0;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:14px;background:var(--secondary-background-color,var(--steuertage-card-background,var(--card-background-color)))}.data-disclosure>summary{display:grid;grid-template-columns:minmax(0,1fr) clamp(100px,30vw,140px) 16px;align-items:center;gap:12px;padding:15px 18px;cursor:pointer;font-weight:600;list-style:none}.data-disclosure>summary::-webkit-details-marker{display:none}.data-disclosure>summary:after{content:'⌄';justify-self:end;color:var(--secondary-text-color);font-size:18px;transition:transform .16s ease}.data-disclosure[open]>summary:after{transform:rotate(180deg)}.data-disclosure>summary small{margin:0;color:var(--secondary-text-color);font-size:12px;font-weight:500;text-align:center}.data-disclosure[open]>summary{border-bottom:1px solid var(--steuertage-divider,var(--divider-color))}.disclosure-content{padding:4px 16px 16px}.disclosure-content>p:first-child{margin-top:12px}.change-log-list{display:grid;gap:8px;margin:12px 0 0;padding:0;list-style:none}.change-log-list li{display:flex;align-items:center;padding:11px 12px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:10px}.change-log-list li span{display:grid;gap:4px}.change-log-list small{color:var(--secondary-text-color)}@media(max-width:600px){.calendar-head{grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:6px}.selection-mode-controls{width:auto}.calendar-head h2{grid-column:2;flex-basis:auto;font-size:16px}.calendar-navigation{gap:4px}.app-disclaimer{margin-top:24px;padding-inline:6px}.data-disclosure>summary{padding:13px 14px;grid-template-columns:minmax(0,1fr) clamp(94px,30vw,120px) 16px}.disclosure-content{padding:4px 10px 12px}}.range-filter{display:grid;gap:10px;margin:14px 0;padding:14px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:14px;background:var(--secondary-background-color,var(--steuertage-card-background,var(--card-background-color)))}.range-filter-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.range-filter-heading>div:first-child{display:grid;gap:3px}.range-filter-heading small,.range-filter>small{color:var(--secondary-text-color);font-size:12px}.range-filter-presets{display:flex;flex-wrap:wrap;gap:6px}.range-filter button{font:inherit;color:var(--primary-text-color);border:1px solid var(--divider-color);border-radius:999px;background:var(--card-background-color);padding:6px 10px;cursor:pointer}@media(max-width:600px){.range-filter-heading{align-items:flex-start;flex-direction:column}.range-filter-presets{width:100%}.range-filter-presets button{flex:1}}.top .data-management-button{margin-left:auto;flex:0 0 36px}.top .top-info-button{margin-left:0;flex:0 0 36px}.data-management-dialog{width:min(680px,calc(100vw - 32px));max-width:none;max-height:min(90dvh,900px);margin:auto;padding:0;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:20px;background:var(--steuertage-card-background,var(--card-background-color));color:var(--steuertage-text,var(--primary-text-color));box-shadow:var(--ha-card-box-shadow,0 16px 48px rgba(0,0,0,.28));overflow:auto}.data-management-dialog::backdrop{background:rgba(0,0,0,.48);backdrop-filter:blur(2px)}.data-management-content{padding:24px}.data-management-header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}.data-management-header h2{margin:4px 0;font-size:22px}.data-management-header p{margin:4px 0;color:var(--secondary-text-color);line-height:1.45}.data-management-header .dialog-close-button{flex:0 0 auto}.data-management-dialog .backup-card,.restore-review-card{display:grid;gap:12px;padding:18px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:14px;background:var(--secondary-background-color,var(--card-background-color))}.data-management-dialog .backup-card p,.restore-review-card p{margin:0;line-height:1.55}.data-management-dialog .backup-actions{margin-top:4px}.backup-launch{display:flex;justify-content:flex-end;margin:20px 0}.data-management-dialog .restore-options{margin:8px 0}.data-management-dialog .restore-dialog-actions{margin-top:16px}@media(max-width:600px){.data-management-content{padding:18px}.data-management-header h2{font-size:19px}.data-management-dialog .backup-actions{display:grid}.data-management-dialog .backup-actions button{width:100%}.data-management-dialog .restore-dialog-actions{flex-direction:column-reverse}.data-management-dialog .restore-dialog-actions button{width:100%}}.type-symbol svg{display:block;width:17px;height:17px;fill:currentColor}@media(max-width:650px){.top{display:grid;grid-template-columns:36px 40px minmax(0,1fr);grid-template-rows:auto auto;align-items:center;gap:8px 10px;padding:12px}.top ha-menu-button{grid-column:1;grid-row:1}.top .app-mark{grid-column:2;grid-row:1;width:40px;height:40px;flex:0 0 40px}.top .brand{grid-column:3;grid-row:1;min-width:0;gap:3px}.top .brand h1{font-size:20px;line-height:1.15}.top .brand p{font-size:12px;line-height:1.35}.top .brand-meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:10px}.top .data-management-button{grid-column:2;grid-row:2;justify-self:end;margin:0;flex:0 0 36px}.top .top-info-button{grid-column:3;grid-row:2;justify-self:end;margin:0;flex:0 0 36px}}.config-card{box-shadow:none;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:14px;background:var(--secondary-background-color,var(--steuertage-card-background,var(--card-background-color)))}.config-card dl>div{box-shadow:none}.top-actions{display:flex;align-items:center;gap:8px;margin-left:auto;flex:0 0 auto}.top .data-management-button,.top .top-info-button{margin:0;flex:0 0 36px}.config-info-dialog .dialog-close-button{box-sizing:border-box;flex:0 0 36px;min-width:36px;min-height:36px;aspect-ratio:1;border-radius:50%}@media(max-width:650px){.top .top-actions{grid-column:3;grid-row:2;justify-self:end;margin:0}.top .data-management-button,.top .top-info-button{margin:0;flex:0 0 36px}}@media(max-width:650px){:host{height:auto;min-height:100dvh;overflow-y:visible;overscroll-behavior:auto}.page{box-sizing:border-box;min-height:100dvh;padding-bottom:max(10px,env(safe-area-inset-bottom,0px))}.range-filter{display:none}.app-disclaimer{margin-bottom:0}}@media(max-width:650px){.top{grid-template-columns:36px minmax(0,1fr);grid-template-rows:auto auto auto auto;align-items:start}.top ha-menu-button{grid-column:1;grid-row:1;align-self:start}.top .app-mark{grid-column:1/-1;grid-row:2;justify-self:center;width:40px;height:40px;flex:0 0 40px;margin-top:4px}.top .brand{grid-column:1/-1;grid-row:3;min-width:0;gap:3px;text-align:center;justify-items:center}.top .brand h1{font-size:20px;line-height:1.15}.top .brand p{font-size:12px;line-height:1.35}.top .brand-meta{display:flex;flex-wrap:wrap;justify-content:center;gap:4px 10px;font-size:10px}.top .top-actions{grid-column:1/-1;grid-row:4;justify-self:end;margin:10px 0 0}}.app-version-meta{display:none}@media(max-width:650px){.top{grid-template-columns:36px 34px minmax(0,1fr) 72px;grid-template-rows:32px auto;align-items:center;gap:6px;padding:8px 10px;margin-bottom:12px}.top ha-menu-button{grid-column:1;grid-row:1;align-self:center;justify-self:center;width:32px;height:32px;--mdc-icon-size:20px}.top .top-actions{grid-column:3/-1;grid-row:1;justify-self:end;margin:0;gap:4px}.top .app-mark{grid-column:1;grid-row:2;justify-self:start;width:34px;height:34px;flex:0 0 34px;margin:0}.top .brand{grid-column:2/-1;grid-row:2;align-self:center;min-width:0;gap:2px;text-align:left;justify-items:start}.top .brand h1{font-size:17px;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.top .brand p{display:-webkit-box;min-width:0;max-width:100%;overflow:hidden;font-size:11px;line-height:1.2;-webkit-line-clamp:2;-webkit-box-orient:vertical}.top .brand-meta{display:none}.top .info-icon-button{width:32px;height:32px;min-width:32px;min-height:32px;flex:0 0 32px;font-size:17px}.app-version-meta{display:grid;gap:2px;margin:8px 0 0;text-align:center;font-size:10px;line-height:1.4}.range-filter-count{display:none}}@media(max-width:650px){.top{display:grid;box-sizing:border-box;grid-template-columns:38px minmax(0,1fr);grid-template-rows:38px auto;align-items:center;column-gap:12px;row-gap:10px;padding:12px 14px;margin:0 0 14px;min-width:0}.top ha-menu-button{grid-column:1;grid-row:1;justify-self:start;align-self:center;width:36px;height:36px;--mdc-icon-size:22px}.top .top-actions{grid-column:2;grid-row:1;justify-self:end;align-self:center;display:flex;gap:8px;margin:0;min-width:0}.top .data-management-button,.top .top-info-button,.top .info-icon-button{box-sizing:border-box;width:36px;height:36px;min-width:36px;min-height:36px;flex:0 0 36px;margin:0}.top .app-mark{grid-column:1;grid-row:2;justify-self:start;align-self:center;width:38px;height:38px;flex:0 0 38px;margin:0}.top .brand{grid-column:2;grid-row:2;align-self:center;justify-self:stretch;display:grid;min-width:0;max-width:100%;gap:4px;text-align:left;justify-items:start}.top .brand h1{margin:0;font-size:18px;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.top .brand p{display:-webkit-box;min-width:0;max-width:100%;margin:0;overflow:hidden;font-size:11px;line-height:1.3;-webkit-line-clamp:2;-webkit-box-orient:vertical}.top .brand-meta{display:none}.range-filter{display:grid;gap:0;margin:10px 0;padding:0;border:0;background:transparent}.range-filter-count{display:block;padding:8px 12px;border:1px solid var(--steuertage-divider,var(--divider-color));border-radius:10px;background:var(--secondary-background-color,var(--steuertage-card-background,var(--card-background-color)));color:var(--primary-text-color);font-size:13px;font-weight:600;text-align:center}.range-filter-heading,.range-filter>small{display:none}.app-version-meta{margin:8px 0 0}}" + headerStyles + calendarStyles + buttonHoverStyles;
    }
    this._updateView("<div class='page'><div class='top'><ha-menu-button></ha-menu-button><div class='app-mark'><img src='/steuertage_brand/icon.png?v=" + encodeURIComponent(this._panel?.config?.version || "") + "' alt='' loading='lazy'></div><div class='brand'><h1>Steuertage</h1><p>Arbeitsstätte- und Homeoffice-Tage für die Steuererklärung erfassen.</p><div class='brand-meta'><span>Version " + this._escape(this._panel?.config?.version || "–") + "</span><span class='developer-credit'><span aria-hidden='true'>•</span> Entwickelt von <a href='https://github.com/mongrelX15' target='_blank' rel='noopener noreferrer'>mongrelX15</a></span></div></div><div class='top-actions'>" + buildBadge + "<button type='button' class='top-action' data-action='config-info' aria-label='Funktionsweise anzeigen' title='Funktionsweise anzeigen'><ha-icon icon='mdi:information-outline' aria-hidden='true'></ha-icon></button></div></div><div class='tabs'><button data-tab='calendar' class='" + (tab === "calendar" ? "active" : "") + "'>Kalender</button><button data-tab='config' class='" + (tab === "config" ? "active" : "") + "'>Konfiguration</button><button data-tab='export' class='" + (tab === "export" ? "active" : "") + "'>Daten &amp; Export</button></div>" + content + "<footer class='app-disclaimer'><span class='disclaimer-label'>HINWEIS!</span><p>" + this._escape("Steuertage unterstützt die automatische Erfassung relevanter Daten auf Grundlage der in Home Assistant vorhandenen Erkennung.") + "</p><p>" + this._escape("Für Richtigkeit und Vollständigkeit Ihrer Steuererklärung tragen Sie die volle Verantwortung.") + "</p><span class='disclaimer-caveat'>Alle Angaben ohne Gewähr.</span><div class='app-version-meta'><span>Version " + this._escape(this._panel?.config?.version || "–") + "</span><span class='developer-credit'><span aria-hidden='true'>•</span> Entwickelt von <a href='https://github.com/mongrelX15' target='_blank' rel='noopener noreferrer'>mongrelX15</a></span></div></footer></div>");
    for (const { element, top } of scrollPositions) {
      if (element.scrollTop !== top) element.scrollTop = top;
    }
    if (editorTop !== null && scrollPositions.length) {
      const editor = this.shadowRoot.querySelector(".selection-card");
      const scroller = scrollPositions[0].element;
      if (editor) scroller.scrollTop += editor.getBoundingClientRect().top - editorTop;
    }
    if (exportPeriod?.isConnected && exportPeriodRect &&
        exportPeriodRect.bottom > 0 && exportPeriodRect.top < window.innerHeight) {
      scrollPositions[0].element.scrollTop += exportPeriod.getBoundingClientRect().top - exportPeriodRect.top;
    }
    const menu = this.shadowRoot.querySelector("ha-menu-button");
    if (menu) menu.hass = this._hass;
    this.shadowRoot.querySelectorAll("details[data-disclosure-id]").forEach((details) => details.addEventListener("toggle", () => {
      if (details.open) this._openDisclosures.add(details.dataset.disclosureId);
      else this._openDisclosures.delete(details.dataset.disclosureId);
    }, { signal: this._viewListeners.signal }));
    this.shadowRoot.querySelectorAll("[data-range-preset]").forEach((button) => button.addEventListener("click", () => {
      this._setRangeWeekdays(button.dataset.rangePreset === "weekdays" ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6]);
    }, { signal: this._viewListeners.signal }));
    this.shadowRoot.querySelectorAll("[data-range-weekday]").forEach((button) => button.addEventListener("click", () => {
      const days = new Set(this._rangeWeekdays());
      const day = Number(button.dataset.rangeWeekday);
      if (days.has(day) && days.size === 1) return;
      if (days.has(day)) days.delete(day); else days.add(day);
      this._setRangeWeekdays(days);
    }, { signal: this._viewListeners.signal }));
    this.shadowRoot.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
      const previousTab = this._tab;
      this._tab = button.dataset.tab;
      if (this._tab === "export" && previousTab !== "export") {
        this._historicalSites = null;
        this._historicalStatus = "";
      }
      this._render();
      if (this._tab === "calendar") this._loadEvents();
      if (this._tab === "export") this._loadExportEvents();
    }, { signal: this._viewListeners.signal }));
    this._renderDialog("[data-action='config-info']", this._configInfoMarkup());
    this._renderDialog("[data-open-data-management]", this._dataManagementMarkup(calendars),
      (dialog) => this._bindBackupActions(dialog), () => this._loadAutomaticBackups());
    this._cancelCalendarDrag?.();
    let dragMoved = false;
    const mobileCalendar = window.matchMedia("(max-width: 650px)");
    const dayButtons = [...this.shadowRoot.querySelectorAll("[data-date]")];
    dayButtons.forEach((button) => {
      button.addEventListener("pointerdown", (event) => {
        if (mobileCalendar.matches || event.pointerType !== "mouse" || event.button !== 0 ||
            event.metaKey || event.ctrlKey || event.shiftKey) return;
        this._cancelCalendarDrag?.();
        dragMoved = false;
        const startDate = button.dataset.date;
        let lastDate = startDate;
        const baseDates = this._multiSelectMode ? new Set(this._selectedDates) : null;
        const filteredDates = new Set(this._filteredMultiDates);
        const remove = baseDates?.has(startDate) ?? false;

        const moveDrag = (moveEvent) => {
          if (moveEvent.pointerId !== event.pointerId) return;
          const date = dayButtons.find((cell) => {
            const rect = cell.getBoundingClientRect();
            return moveEvent.clientX >= rect.left && moveEvent.clientX <= rect.right &&
              moveEvent.clientY >= rect.top && moveEvent.clientY <= rect.bottom;
          })?.dataset.date;
          if (!date || date === lastDate) return;
          lastDate = date;
          dragMoved = true;
          this._applyFilteredRange(startDate, date, { baseDates, filteredDates, remove });
          this._updateVisibleDateSelection(this._selectedDates);
        };
        const stopDrag = () => {
          window.removeEventListener("pointermove", moveDrag);
          window.removeEventListener("pointerup", finishDrag);
          window.removeEventListener("pointercancel", finishDrag);
          this._cancelCalendarDrag = null;
        };
        const finishDrag = (finishEvent) => {
          if (finishEvent.pointerId !== event.pointerId) return;
          stopDrag();
          if (dragMoved) setTimeout(() => this._render(), 0);
        };
        this._cancelCalendarDrag = stopDrag;
        window.addEventListener("pointermove", moveDrag, { passive: true });
        window.addEventListener("pointerup", finishDrag);
        window.addEventListener("pointercancel", finishDrag);
      }, { signal: this._viewListeners.signal });
      button.addEventListener("click", (event) => {
        const date = button.dataset.date;
        if (dragMoved) return;
        if (event.shiftKey) {
          const anchor = this._rangeAnchorDate || date;
          const baseDates = this._multiSelectMode ? this._selectedDates : null;
          this._applyFilteredRange(anchor, date, { baseDates });
        } else {
          const clickedSelectedDay = this._selectedDates.size === 1 && this._selectedDates.has(date);
          this._selectDate(date, this._multiSelectMode || event.metaKey || event.ctrlKey || clickedSelectedDay);
        }
        this._render();
      }, { signal: this._viewListeners.signal });
    });
    this.shadowRoot.querySelector("[data-action='prev']")?.addEventListener("click", () => {
      this._month = new Date(this._month.getFullYear(), this._month.getMonth() - 1, 1);
      this._clearDateSelection();
      this._loadedMonth = "";
      this._render();
      this._loadEvents();
    }, { signal: this._viewListeners.signal });
    this.shadowRoot.querySelector("[data-action='multi-select']")?.addEventListener("click", () => {
      this._multiSelectMode = !this._multiSelectMode;
      if (!this._multiSelectMode) this._clearDateSelection();
      this._render();
    }, { signal: this._viewListeners.signal });
    this.shadowRoot.querySelector("[data-action='mobile-multi-select']")?.addEventListener("click", () => {
      if (!window.matchMedia("(max-width: 650px)").matches) return;
      this._multiSelectMode = !this._multiSelectMode;
      if (!this._multiSelectMode) this._clearDateSelection();
      this._render();
    }, { signal: this._viewListeners.signal });
    this.shadowRoot.querySelector("[data-action='clear-selection']")?.addEventListener("click", () => {
      this._clearDateSelection();
      this._render();
    }, { signal: this._viewListeners.signal });
    this.shadowRoot.querySelector("[data-action='undo']")?.addEventListener("click", () => this._applyEditHistory("undo"), { signal: this._viewListeners.signal });
    this.shadowRoot.querySelector("[data-action='redo']")?.addEventListener("click", () => this._applyEditHistory("redo"), { signal: this._viewListeners.signal });
    this.shadowRoot.querySelector("[data-action='today']")?.addEventListener("click", () => {
      const today = new Date();
      const currentMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      if (this._isoDate(currentMonth) !== this._isoDate(this._month)) {
        this._clearDateSelection();
        this._loadedMonth = "";
      }
      this._month = currentMonth;
      this._selectDate(this._isoDate(today));
      this._render();
      this._loadEvents();
    }, { signal: this._viewListeners.signal });
    this.shadowRoot.querySelector("[data-action='next']")?.addEventListener("click", () => {
      this._month = new Date(this._month.getFullYear(), this._month.getMonth() + 1, 1);
      this._clearDateSelection();
      this._loadedMonth = "";
      this._render();
      this._loadEvents();
    }, { signal: this._viewListeners.signal });
    this.shadowRoot.querySelectorAll("[data-calendar]").forEach((button) => button.addEventListener("click", async () => {
      const nextCalendar = button.dataset.calendar;
      if (nextCalendar === this._calendarEntityId) return;
      this._calendarEntityId = nextCalendar;
      this._calendarInitialized = true;
      this._loadedMonth = "";
      this._events = [];
      this._clearDateSelection();
      this._render();
      await this._loadEvents();
    }, { signal: this._viewListeners.signal }));
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
    }, { signal: this._viewListeners.signal }));
    ["[data-export-from]", "[data-export-to]"].forEach((selector) => {
      this.shadowRoot.querySelector(selector)?.addEventListener("change", () => {
        const from = this.shadowRoot.querySelector("[data-export-from]")?.value;
        const to = this.shadowRoot.querySelector("[data-export-to]")?.value;
        if (!from || !to || to < from) { this._showMessage("Bitte prüfe den ausgewählten Exportzeitraum."); return; }
        this._exportFrom = from; this._exportTo = to;
        this._exportYear = Number(from.slice(0, 4));
        this._exportKey = ""; this._exportEvents = null; this._loadExportEvents();
      }, { signal: this._viewListeners.signal });
    });
    this.shadowRoot.querySelector("[data-export-calendar]")?.addEventListener("change", (event) => {
      this._calendarEntityId = event.target.value; this._calendarInitialized = true;
      this._loadedMonth = ""; this._events = []; this._exportKey = ""; this._exportEvents = null;
      this._historicalStatus = "";
      this._clearDateSelection();
      this._render();
      if (this._tab === "calendar") this._loadEvents();
      if (this._tab === "export") this._loadExportEvents();
    }, { signal: this._viewListeners.signal });
    this.shadowRoot.querySelectorAll("[data-download]").forEach((button) => button.addEventListener("click", () => this._downloadExport(button.dataset.download), { signal: this._viewListeners.signal }));
    this.shadowRoot.querySelectorAll("[data-review-date]").forEach((button) => button.addEventListener("click", () => {
      const date = button.dataset.reviewDate;
      const [year, month] = date.split("-").map(Number);
      const reviewMonth = new Date(year, month - 1, 1);
      if (this._isoDate(reviewMonth) !== this._isoDate(this._month)) this._clearDateSelection();
      this._month = reviewMonth;
      this._selectDate(date);
      this._tab = "calendar"; this._loadedMonth = ""; this._render(); this._loadEvents();
    }, { signal: this._viewListeners.signal }));
    this.shadowRoot.querySelectorAll("[data-delete-site]").forEach((button) => button.addEventListener("click",
      () => this._deleteHistoricalSite(button.dataset.deleteSite), { signal: this._viewListeners.signal }));
    this.shadowRoot.querySelectorAll("[data-type], [data-office-site]").forEach((button) => button.addEventListener("click", async () => {
      const siteId = button.dataset.officeSite;
      if (this._busy || (this._pendingSiteEdits && !siteId)) return;
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
      if (siteId) {
        const activeSite = this._officeSites().some((site) => site.id === siteId && site.active);
        const pressed = activeSite && button.getAttribute("aria-pressed") !== "true";
        button.setAttribute("aria-pressed", String(pressed));
        button.classList.toggle("selected-type", pressed);
        button.querySelector(".type-check").textContent = pressed ? "✓" : "";
        this._queueSiteEdit({ siteId, days: days.filter((date) => this._type(this._eventForDay(date)) === "office"), personEntity });
        return;
      }
      const targetType = button.dataset.type;
      const firstActiveSite = targetType === "office" ? this._officeSites().find((site) => site.active)?.id : null;
      const operation = {
        days: days.map((date) => {
          const beforeSites = this._siteIds(this._eventForDay(date));
          return {
            date,
            before: this._manualOverrideForDate(date),
            beforeSites,
            after: targetType,
            afterSites: targetType === "office" ? (beforeSites.length ? beforeSites : firstActiveSite ? [firstActiveSite] : []) : [],
          };
        }).filter((item) => item.before !== item.after ||
          (targetType === "office" && item.beforeSites.length !== item.afterSites.length)),
      };
      if (!operation.days.length) {
        this._showMessage("Für die ausgewählten Tage ist keine Änderung nötig.");
        return;
      }
      const appliedDays = [];
      const editHistory = this._editHistoryForCurrentPerson();
      this._beginCalendarEdit("Speichere " + operation.days.length + (operation.days.length === 1 ? " Tag …" : " Tage …"));
      let message;
      try {
        for (const day of operation.days) {
          await this._hass.callService("steuertage", "set_day_override", {
            person_entity: personEntity,
            date: day.date,
            day_type: day.after,
            office_site_ids: day.after === "office" ? day.afterSites : undefined,
          });
          appliedDays.push(day);
        }
        editHistory.undo.push(operation);
        if (editHistory.undo.length > 50) editHistory.undo.shift();
        editHistory.redo = [];
        this._correctionFrom = fromValue;
        this._correctionTo = toValue;
        message = operation.days.length === 1 ? "Änderung gespeichert." : operation.days.length + " Tage wurden aktualisiert.";
      } catch (error) {
        if (appliedDays.length) {
          editHistory.undo.push({ days: appliedDays });
          if (editHistory.undo.length > 50) editHistory.undo.shift();
          editHistory.redo = [];
        }
        message = "Änderung konnte nicht vollständig gespeichert werden. Bereits gespeicherte Tage kannst du rückgängig machen.";
      } finally {
        if (appliedDays.length) {
          this._historicalSites = null;
          await this._loadEvents({ refresh: true });
        }
        this._finishCalendarEdit(message);
      }
    }, { signal: this._viewListeners.signal }));
  }
}

customElements.define("steuertage-panel", SteuertagePanel);
