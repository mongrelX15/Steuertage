# Steuertage

[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-Integration-41BDF5?logo=homeassistant&logoColor=white)](https://www.home-assistant.io/)
[![Status: Beta](https://img.shields.io/badge/status-Beta-orange)](https://github.com/mongrelX15/Steuertage/releases)
[![Lizenz](https://img.shields.io/github/license/mongrelX15/Steuertage)](LICENSE)

**Steuertage** hilft dabei, steuerlich relevante Arbeitstage in Home Assistant zu erfassen und auszuwerten. Die Integration erkennt Tage anhand deiner Zonen, optional deines Homeoffice-Signals und eines optionalen Arbeitskalenders. Im Seitenleisten-Panel kannst du Tage prüfen und manuell ändern, Auswertungen erstellen und deine Daten sichern.

> Steuertage ist eine Beta. Die App unterstützt die Erfassung; sie ersetzt keine steuerliche Beratung. Für Richtigkeit und Vollständigkeit der Steuererklärung bist du selbst verantwortlich. Alle Angaben ohne Gewähr.

## Was Steuertage kann

- **Kalender für mehrere Personen:** Jede eingerichtete Person erhält einen eigenen Verlauf. Die Ansicht wählt nach Möglichkeit automatisch die Person aus, die deinem Home-Assistant-Benutzer zugeordnet ist.
- **Automatische Erkennung:** Aufenthaltszeiten werden intern ausgewertet. Der Standard-Schwellwert beträgt 2 Stunden und lässt sich pro Person anpassen. Arbeitsstunden werden nicht als Tagesübersicht angezeigt.
- **Arbeitsstätte:** Eine verpflichtende Arbeitszone erkennt Besuche am Ort, zu dem du für die Arbeit fährst und für den Wegstrecken relevant sein können.
- **Homeoffice, wenn benötigt:** Die Homeoffice-Erkennung ist optional. Bei Aktivierung werden Home-Zone und Device Tracker konfiguriert; im Kalender und in der Auswertung erscheinen Homeoffice-Tage nur für Personen mit eingeschalteter Homeoffice-Erkennung.
- **Arbeitskalender, wenn benötigt:** Ein in Home Assistant eingebundener Kalender kann optional festlegen, wann ein Besuch der Arbeitszone als Arbeitstag zählt. Zeitgebundene und ganztägige Arbeitstermine werden berücksichtigt.
- **Prüfen und korrigieren:** Offene Prüftage werden hervorgehoben. Du kannst einzelne Tage oder mehrere ausgewählte Tage manuell festlegen. Änderungen werden mit Zeitpunkt und Home-Assistant-Benutzer dokumentiert.
- **Auswertung und Sicherung:** CSV-, TXT- und HTML-Auswertungen enthalten Summen, Monatsübersicht, Tagesliste und Prüfhinweise. Eine JSON-Sicherung umfasst die Verläufe aller eingerichteten Personen.

## Installation

Solange Steuertage noch nicht im offiziellen HACS-Store gelistet ist, installierst du das Repository als benutzerdefiniertes HACS-Repository:

1. Öffne in Home Assistant **HACS → Integrationen** und wähle im Menü **Benutzerdefinierte Repositories**.
2. Füge `mongrelX15/Steuertage` als Repository vom Typ **Integration** hinzu.
3. Installiere **Steuertage** über HACS und starte Home Assistant neu.
4. Öffne **Einstellungen → Geräte & Dienste → Integration hinzufügen**, suche nach **Steuertage** und folge dem Einrichtungsdialog.
5. Öffne anschließend **Steuertage** über die Seitenleiste.

Für eine Beta wähle in HACS die gewünschte veröffentlichte Beta-Version aus. Die aktuelle Versionsnummer und Änderungen stehen auf der [Releases-Seite](https://github.com/mongrelX15/Steuertage/releases).

## Einrichtung

Pro Person wird eine eigene Steuertage-Konfiguration angelegt. Für die Erkennung werden folgende Angaben verwendet:

| Einstellung | Erforderlich? | Zweck |
| --- | --- | --- |
| Home-Assistant-Person | Ja | Ordnet Erkennung und Verlauf einer Person zu. |
| Arbeitsstätte (Zone) | Ja | Erkennt Anwesenheit am Arbeitsort. |
| Erkennungsschwelle | Ja | Mindestdauer eines passenden Signals. Standard: 2 Stunden. |
| Homeoffice-Erkennung | Nein | Schaltet Homeoffice als Tagestyp hinzu. Bei Aktivierung werden Home-Zone und Device Tracker benötigt. |
| Arbeitskalender | Nein | Begrenzt die automatische Wertung der Arbeitszone auf Arbeitstermine im eingebundenen Home-Assistant-Kalender. |

Ohne Arbeitskalender zählt die erkannte Anwesenheit in der Arbeitszone. Ist ein Arbeitskalender ausgewählt, zählt die Arbeitszone nur während eines passenden laufenden Termins. Ein Homeoffice-Gerät, das nach der Arbeit ausgeschaltet oder nicht erreichbar ist, gilt nicht als Homeoffice-Signal.

## Kalender und Auswertung

Das Seitenleisten-Panel enthält die Bereiche **Kalender**, **Konfiguration** und **Daten & Export**. Die Oberfläche passt sich an das aktive Home-Assistant-Theme und den Hell-/Dunkelmodus an.

Im Kalender siehst du Tagesstatus, Monatsstatistik, Wochenenden und Hinweise auf manuelle Änderungen. Mehrere Tage lassen sich über Ziehen, Umschalt-Klick oder ⌘-Klick (Mac) beziehungsweise Strg-Klick (Windows/Linux) auswählen. Arbeitsstätte und Homeoffice können am selben Tag als Mischtag erfasst werden; dabei zählt der Tag insgesamt nur einmal.

Im Bereich **Daten & Export** kannst du Steuerjahre oder eigene Zeiträume auswählen. Monatsübersicht, Tagesliste und Änderungsverlauf lassen sich aufklappen. Die Exportdateien enthalten nur Tage, die Steuertage erfasst hat. Manuell als „Kein Arbeitstag“ markierte Tage werden nicht als Arbeitstage gezählt oder exportiert.

## Sicherung und Wiederherstellung

Die Steuertage-Sicherung enthält die Verläufe aller in der Integration eingerichteten Personen, unabhängig von der aktuell angezeigten Person. Für das Erstellen und Wiederherstellen ist ein Home-Assistant-Administrator erforderlich.

Beim Wiederherstellen gibt es zwei Möglichkeiten:

- **Ergänzen:** Fehlende Einträge aus der Sicherung werden ergänzt; vorhandene lokale Änderungen bleiben bestehen.
- **Ersetzen:** Einträge für Tage, die in der Sicherung enthalten sind, werden durch den Sicherungsstand ersetzt. Tage, die nicht in der Sicherung stehen, bleiben unverändert.

Eine Wiederherstellung betrifft nur Personen, die aktuell in Steuertage eingerichtet sind. Bewahre zusätzlich ein aktuelles Home-Assistant-Backup auf.

## Umstieg von HA Work-Log

Steuertage verwendet die Integrations-Domain `steuertage` und ist kein direktes Upgrade der bisherigen `ha_worklog`-Integration. Sichere benötigte Daten, entferne HA Work-Log und richte Steuertage neu ein. Alte Konfigurationen und lokale Verläufe werden nicht automatisch übernommen.

## Hilfe und Rückmeldungen

Fehler, Fragen und Vorschläge kannst du über [GitHub Issues](https://github.com/mongrelX15/Steuertage/issues) melden. Bitte füge keine Zugangsdaten, privaten Adressen oder personenbezogenen Kalenderdaten bei.

## Entwicklung

Steuertage entsteht mit KI-Unterstützung und wird zunächst im `beta`-Zweig erprobt. Geprüfte Änderungen werden später als stabile Version in `main` veröffentlicht. Beta-Versionen können unvollständig sein oder Fehler enthalten.

Änderungen pro Version findest du in den [GitHub Release Notes](https://github.com/mongrelX15/Steuertage/releases).
