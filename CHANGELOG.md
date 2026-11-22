# Änderungsprotokoll

## 0.2.0-beta.16

- Kalender: „Mehrfachauswahl beenden“ hebt jetzt zugleich die Auswahl und den markierten Zeitraum auf.
- Bedienung: Tastenkürzel einschließlich Esc wurden entfernt. Tagestypen werden über die Schaltflächen gesetzt; Mausgesten und die Auswahlbuttons steuern die Mehrfachauswahl.
- Einrichtung: Optionale Home-Zone, optionales Homeoffice-Gerät und optionaler Arbeitskalender blockieren das Speichern nicht mehr, wenn die jeweilige Funktion ausgeschaltet ist. Beim Bearbeiten bleiben vorhandene Werte vorausgewählt.
- Daten & Export: Die Personenauswahl passt sich in der mobilen Ansicht an die verfügbare Breite an.

## 0.2.0-beta.15

- Tastenkürzel reagierten auf Klein- und Großbuchstaben und wurden während Speichervorgängen nacheinander verarbeitet.
- Mehrfachauswahl, Zeitraum-Markierung, Legendenfarbe und Info-Symbol wurden angepasst.
- Alte Krankheits- und Urlaubseinträge bleiben manuell und werden beim Zurücksetzen nicht als automatische Erkennung übernommen.

## 0.2.0-beta.14

- Tastenkürzel: A setzt Arbeitsstätte, H Homeoffice (falls aktiviert), U Urlaub, K Krankheit, E automatische Erkennung und 0 manuell „Kein Arbeitstag“.
- Tastenkürzel greifen auch auf mehrere markierte Tage und nicht während der Eingabe in Text- oder Formularfelder. Wiederholte Tastaturereignisse werden ignoriert.
- Esc leert temporäre und dauerhafte Mehrfachauswahlen und beendet den Mehrfachmodus.
- Manuell auf „Kein Arbeitstag“ gesetzte Tage bleiben im Kalender als manuelle Änderungen sichtbar, werden aber in Auswertungen und Exportdateien vollständig ausgelassen.
- Legende: automatische Erkennung und alle manuellen Tagestypen zeigen jetzt die passenden Tasten.
- Konfiguration: Die automatische Erkennung wird über ein Info-Symbol erklärt. Der Hilfetext beschreibt jetzt die Arbeitszone, optionale Homeoffice-Erkennung, den optionalen Arbeitskalender inklusive ganztägiger Einträge und die personenspezifische Mindestdauer.
- Konfiguration: Im Infofenster gibt es direkte Links zum Repository und zum Melden von Fragen oder Änderungswünschen.
- Kalender: Ziehen oder ⌘/Strg-Klick markiert Tage vorübergehend mehrfach, ohne den dauerhaften Mehrfachauswahl-Modus einzuschalten.
- Kalender: Der eigene Mehrfachauswahl-Modus lässt sich gezielt aktivieren. „Auswahl aufheben“ leert die Auswahl und beendet den Modus.
## 0.2.0-beta.13

- Kalender: Bei mehreren ausgewählten Tagen zeigt die Bearbeitungsüberschrift jetzt den gesamten Zeitraum, zum Beispiel „12.11.2026 bis 16.11.2026“.
## 0.2.0-beta.12

- Konfigurationsübersicht: Angaben kompakter und gleichmäßiger anordnen.
- Kalender: Tagestypen, Mischtage, manuelle Änderungen und Tastenkürzel in einer gemeinsamen farbigen Legende zusammenfassen.
- Kalender: Mehrfachauswahl beim Ziehen sofort aktivieren und den Status passend zur Anzahl ausgewählter Tage setzen.
- Einrichtung und Einstellungen: alle Angaben auf einer Seite bündeln. Arbeitsstätte und Mindestanwesenheit sind erforderlich; Homeoffice-Erkennung und Arbeitskalender sind optional.
- Einrichtung: die Mindestanwesenheit erklärt, wie lange ein Aufenthalt in der Arbeitszone beziehungsweise bei aktivierter Homeoffice-Erkennung in der Home-Zone dauern muss, bevor ein Tag automatisch zählt. Standardwert: 2 Stunden.
- Bedienoberfläche: den Inhaltsbereich scrollbar machen, damit die Ansicht über dem fixierten Home-Assistant-Theme-Hintergrund bewegt werden kann.

- Oberfläche: Fußzeile auf allen Tabs mittig ausrichten.
- Daten & Export: Von- und Bis-Datumsfelder bei Hover und Fokus mit einem klaren Rahmen hervorheben.
