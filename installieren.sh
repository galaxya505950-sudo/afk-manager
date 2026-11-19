#!/usr/bin/env bash
# AFK Manager - Einrichtung unter Linux (Debian, Ubuntu, Linux Mint, Raspberry Pi OS)
#
#   curl -fsSL https://raw.githubusercontent.com/galaxya505950-sudo/afk-manager/main/installieren.sh | bash
#
# Legt den Ordner ~/afk-manager an. Danach startest du immer mit:
#   cd ~/afk-manager && ./start.sh
set -e
REPO_URL="https://github.com/galaxya505950-sudo/afk-manager.git"
ZIEL="${AFK_ZIEL:-$HOME/afk-manager}"

echo "== 1/3 Programme prüfen =="
fehlt=""
command -v git >/dev/null || fehlt="$fehlt git"
command -v node >/dev/null || fehlt="$fehlt nodejs npm"
if [ -n "$fehlt" ]; then
  echo "Installiere:$fehlt"
  sudo apt-get update && sudo apt-get install -y $fehlt
fi
nodever=$(node -v | sed 's/^v//; s/\..*//')
if [ "$nodever" -lt 18 ]; then
  echo "❌ Node.js $nodever ist zu alt - mindestens 18 nötig (https://nodejs.org)."
  exit 1
fi

echo "== 2/3 AFK Manager herunterladen =="
if [ -d "$ZIEL/.git" ]; then
  echo "Ordner gibt es schon - hole nur das neueste Update."
  git -C "$ZIEL" pull --ff-only
else
  if [ -e "$ZIEL" ]; then
    ALT="$ZIEL-alt-$(date +%Y%m%d-%H%M%S)"
    echo "Ordner $ZIEL gibt es schon (ohne Updates) - wird umbenannt in $ALT"
    mv "$ZIEL" "$ALT"
  fi
  git clone "$REPO_URL" "$ZIEL"
fi
cd "$ZIEL"
[ -f panel.env ] || cp panel.env.example panel.env

echo "== 3/3 Pakete installieren =="
npm install --omit=dev --no-audit --no-fund

echo
echo "✅ Fertig! Starten mit:"
echo "   cd $ZIEL && ./start.sh"
echo "Dann im Browser http://localhost:3000 öffnen und den Einrichtungscode aus dem Terminal eingeben."
echo "Discord (optional): Token in $ZIEL/panel.env eintragen."
