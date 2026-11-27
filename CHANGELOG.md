# Änderungsprotokoll

## 1.0.4

- Gesetzliche Feiertage nach Land und Region im Kalender anzeigen.
- Dienstreisen als Tagestyp erfassen und auswerten.
- Tagestypen direkt unter dem Kalender bearbeiten und einzelne Tage per erneutem Antippen abwählen.
- PDF-, HTML-, TXT- und CSV-Exporte mit Gesamtsummen, Tagesprotokoll und Versionsangabe.
- Kompatibilität der Feiertagsbibliothek mit Home Assistant und Hilfelinks im Einrichtungsassistenten korrigiert.

## 1.0.2

- Testdaten verwenden fiktive Personen und Entitäten.
- Die README zeigt das Dashboard und weitere Ansichten der Integration.

## 1.0.0

Erste stabile Version der 1.0-Reihe.

- Automatische Erkennung für Arbeitsstätte und optional Homeoffice mit pro Person einstellbarer Mindestdauer. Ein optionaler Arbeitskalender kann die Erkennung am Arbeitsort auf laufende Termine begrenzen.
- Kalender für mehrere Personen mit getrennten Verläufen, Monatsstatistik, Mischtagen, Mehrfachauswahl und Änderungsverlauf.
- Auswertungen für Steuerjahre und eigene Zeiträume mit Export als CSV, TXT und HTML.
- JSON-Sicherung und Wiederherstellung für alle eingerichteten Personen über „Daten & Export“.
- Überarbeiteter Infodialog. Der Info- und der Sicherungsdialog bleiben bei internen Aktualisierungen geöffnet.
- Veröffentlichung unter GNU GPLv3. Der vollständige Lizenztext steht in [LICENSE](LICENSE).

## 0.3.0-beta.5

- Temporäre Mehrfachauswahl: Bei mehreren markierten Tagen ersetzt „Auswahl aufheben“ den Schalter „Mehrfachauswahl“ und erscheint bereits ab zwei Tagen.
- „Auswahl aufheben“ beendet die temporäre Auswahl und blendet die Wochentagsfilter wieder aus.
## 0.3.0-beta.4

- Kalender: Ziehen über die Tage markiert den Bereich während der Mausbewegung zuverlässiger.
- Kalender: „Rückgängig“ und „Wiederholen“ machen Änderungen wieder verfügbar; eine Mehrfachänderung zählt als ein Schritt. Der Verlauf gilt pro Person und bis zum Schließen oder Neuladen des Panels.
- Kalender: „Kein Arbeitstag“ steht in der Legende vor „Erkennung läuft“; ein dezenter Trenner hebt den Erkennungsstatus ab.
- Daten & Export: Monats-, Tages- und Änderungszahlen sind in einer gemeinsamen Spalte ausgerichtet. Geöffnete Bereiche bleiben bei einer Aktualisierung des Panels geöffnet.
- App-Symbol: Das ursprüngliche Koffer-Icon aus Beta 1/2 hat eine deutlich sichtbare weiße Kontur.
- App-Cache: Jede Panel-Version erhält eine URL mit eigenem Inhalts-Hash, damit Home Assistant eine aktualisierte Oberfläche laden kann.
## 0.3.0-beta.3

- Kalender: Die angemeldete Person erscheint im ersten Tab; weitere Personen folgen alphabetisch. Die Konfiguration verwendet dieselbe Reihenfolge.
- Kalender: Manuell geänderte Tage sind mit einem dezenten Sternchen markiert, auch in der Legende.
- App-Symbol: Das ursprüngliche Koffer-Icon aus Beta 1/2 hat eine deutlich sichtbare weiße Kontur für bessere Erkennbarkeit im Dark Mode.

## 0.2.0-beta.17

- Automatische Erkennung: Ein Tag wird erst gezählt, wenn der Schwellwert erreicht ist. Solange ein Signal aktiv ist und noch Zeit fehlt, erscheint „Erkennung läuft“; ohne aktives Signal gilt „Kein Arbeitstag“.
- Ein fehlender oder nicht erreichbarer Homeoffice-Tracker gilt als inaktives Signal und löst allein kein „Bitte prüfen“ aus.
- Wiederholtes Speichern desselben Zustands oder „Automatisch“ erzeugt keinen wirkungslosen Verlaufseintrag.

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
