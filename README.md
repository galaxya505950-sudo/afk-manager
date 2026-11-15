# AFK Manager

Web-Panel, mit dem du mehrere Minecraft-Accounts gleichzeitig AFK laufen lässt und
sie bequem aus dem Browser steuerst – am PC oder am Handy. Gebaut für **clashsmp.de**,
andere Server kannst du in der Verwaltung hinzufügen.

## Was es kann

- **Mehrere Microsoft-Accounts** gleichzeitig online, automatisches Wiederverbinden, Warteschlange, Zeitplan
- **Chat** mit echten Rangfarben, Suche und Verlauf, Nachrichten und Befehle senden, Auto-Chat
- **Inventar wie im Spiel:** Items ziehen, Rechtsklick, Shift-Klick, 2×2-Crafting, Werkbank,
  Menüs wie `/shop` oder `/ah` öffnen und benutzen, Items rauswerfen
- **Steuerung** mit WASD, Springen, Schleichen, Links-/Rechtsklick, Hotbar
- **Stichwort-Alarm:** meldet sich, wenn bestimmte Wörter im Chat fallen
- **Benutzer & Rechte:** eigene Logins für Freunde, nur ausgewählte Accounts, Protokoll mit IP und Browser
- **Frei anordnen:** Karten verschieben, größer/kleiner ziehen, einklappen, Gesamtgröße per Regler
- **Discord (optional):** Status-Übersicht, Chat in beide Richtungen, Alarme mit Ping, Logs,
  Microsoft-Login-Codes, `/aufraeumen`
- **Echte Minecraft-Texturen** im Inventar (auf Knopfdruck, direkt von Mojang)

## Installieren

### Linux (Ubuntu, Linux Mint, Debian, Raspberry Pi OS)

```bash
curl -fsSL https://raw.githubusercontent.com/galaxya505950-sudo/afk-manager/main/installieren.sh | bash
```

Danach starten:

```bash
cd ~/afk-manager && ./start.sh
```

### Windows

1. [Node.js](https://nodejs.org) (LTS) und [Git](https://git-scm.com/download/win) installieren
2. In einem Ordner deiner Wahl die Eingabeaufforderung öffnen und eingeben:
   ```
   git clone https://github.com/galaxya505950-sudo/afk-manager.git
   ```
3. Im neuen Ordner `afk-manager` doppelt auf **`start.bat`** klicken

> Als ZIP herunterladen geht auch, dann gibt es aber keine automatischen Updates.

## Erster Start

1. Im Browser **http://localhost:3000** öffnen
2. Im Terminal steht ein **Einrichtungscode** – den eingeben und deinen Admin-Benutzer anlegen
3. Unter **Account hinzufügen** deinen Minecraft-Namen eintragen und den Microsoft-Code bestätigen

Vom Handy im selben WLAN: in `panel.env` die Zeile `PANEL_HOST=0.0.0.0` einschalten
(das `#` davor löschen) und dann `http://<IP-des-Rechners>:3000` öffnen.

## Updates

Passiert automatisch: `start.sh` bzw. `start.bat` holt bei jedem Start die neueste Version.
Deine Daten (Accounts, Logins, Benutzer, Einstellungen) bleiben dabei unangetastet.

## Discord einrichten (optional)

1. Auf <https://discord.com/developers/applications> → **New Application** → links **Bot**
2. **Reset Token** → Token kopieren und in `panel.env` bei `DISCORD_TOKEN=` einfügen
3. Auf derselben Seite **Message Content Intent** einschalten
4. Links **OAuth2 → URL Generator**: `bot` und `applications.commands` anhaken, Rechte:
   Kanäle ansehen, Nachrichten senden, Nachrichten verwalten, Links einbetten,
   Nachrichtenverlauf lesen, **Kanäle verwalten**, alle Rollen erwähnen
5. Den Link öffnen und den Bot auf deinen Discord-Server einladen
6. Panel neu starten – die Kanäle `#status`, `#chat`, `#stichwort-alarm`, `#logs` und
   `#microsoft-login` werden automatisch angelegt (oder vorhandene mit diesem Namen benutzt)

Wer bei Stichwort-Treffern gepingt wird: eine Rolle **AFK Manager** anlegen und dir geben.

## Was auf deinem Rechner bleibt

`accounts/` (Accounts, Microsoft-Logins, Benutzer, Protokoll, Einstellungen) und `panel.env`
werden nie hochgeladen. Gib diese Dateien an niemanden weiter.

## Hinweis

Inoffizielles Projekt, nicht von Mojang oder Microsoft. Prüfe die Regeln deines Servers,
bevor du AFK-Bots benutzt.
