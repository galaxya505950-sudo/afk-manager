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

# Beim ersten Start einmal nach dem Discord-Token fragen (Enter = ohne Discord)
if [ -t 0 ]; then
  if [ ! -f panel.env ]; then
    if [ -f panel.env.example ]; then cp panel.env.example panel.env; else touch panel.env; fi
  fi
  if ! grep -qE "^DISCORD_TOKEN=['\"]?[^'\"[:space:]]+" panel.env && ! grep -qE '^DISCORD_NICHT_FRAGEN=1' panel.env; then
    echo
    echo "🤖 Discord-Bot-Token einfügen und Enter drücken"
    echo "   (nur Enter = ohne Discord, geht später auch noch über panel.env):"
    read -r token
    token=$(printf '%s' "$token" | tr -d "[:space:]\"'")
    if [ -n "$token" ]; then
      if grep -qE '^DISCORD_TOKEN=' panel.env; then
        sed -i "s|^DISCORD_TOKEN=.*|DISCORD_TOKEN=$token|" panel.env
      else
        printf '\nDISCORD_TOKEN=%s\n' "$token" >> panel.env
      fi
      echo "✅ Token gespeichert - wird ab jetzt nicht mehr gefragt."
    else
      printf '\n# Nicht mehr nach dem Discord-Token fragen (Zeile löschen = wieder fragen)\nDISCORD_NICHT_FRAGEN=1\n' >> panel.env
      echo "➡️  Ohne Discord. Später: Token in panel.env bei DISCORD_TOKEN= eintragen."
    fi
    chmod 600 panel.env 2>/dev/null
  fi
fi

# Einstellungen (Discord-Token usw.) - optional
if [ -f panel.env ]; then
  set -a
  . ./panel.env
  set +a
fi

exec node server.js
