#!/usr/bin/env bash
# Holt nur das neueste Update (ohne zu starten). Danach Panel neu starten.
cd "$(dirname "$0")" || exit 1
alt=$(git rev-parse HEAD)
git pull --ff-only || { echo "⚠️  Update fehlgeschlagen."; exit 1; }
neu=$(git rev-parse HEAD)
if [ "$alt" = "$neu" ]; then echo "✅ Schon aktuell."; exit 0; fi
git log --oneline "$alt..$neu" | head -20
git diff --name-only "$alt" "$neu" | grep -qx 'package.json' && npm install --omit=dev
echo "✅ Fertig - jetzt das Panel neu starten (Strg+C, dann ./start.sh)."
