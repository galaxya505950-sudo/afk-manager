#!/usr/bin/env bash
# Startet das AFK-Panel und holt vorher automatisch das neueste Update von GitHub.
#   ./start.sh              -> Update holen + starten
#   ./start.sh --ohne-update -> nur starten
cd "$(dirname "$0")" || exit 1

if [ "$1" != "--ohne-update" ] && [ -d .git ]; then
  echo "🔎 Suche nach Updates ..."
  alt=$(git rev-parse HEAD 2>/dev/null)
  if git pull --ff-only --quiet; then
    neu=$(git rev-parse HEAD)
    if [ "$alt" != "$neu" ]; then
      echo "⬇️  Update geladen:"
      git log --oneline "$alt..$neu" | head -20
      if git diff --name-only "$alt" "$neu" | grep -qx 'package.json'; then
        echo "📦 Neue Pakete werden installiert ..."
        npm install --omit=dev
      fi
    else
      echo "✅ Schon aktuell."
    fi
  else
    echo "⚠️  Update hat nicht geklappt (kein Internet oder Dateien lokal geändert) - starte die vorhandene Version."
  fi
fi

if [ ! -d node_modules ]; then
  echo "📦 Pakete werden installiert ..."
  npm install --omit=dev || exit 1
fi

# Einstellungen (Discord-Token usw.) - optional
if [ -f panel.env ]; then
  set -a
  . ./panel.env
  set +a
fi

exec node server.js
