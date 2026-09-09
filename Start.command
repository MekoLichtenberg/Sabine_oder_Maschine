#!/bin/bash
# SABINE//MASCHINE starten (Mac: Doppelklick; Linux: im Terminal ./Start.command)
cd "$(dirname "$0")"
echo
echo "  SABINE//MASCHINE wird gestartet ..."
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js fehlt noch. Das ist einmalig noetig."
  echo "  Es oeffnet sich jetzt die Download-Seite: bitte 'LTS' installieren,"
  echo "  danach diese Datei nochmal doppelklicken."
  (open https://nodejs.org/ 2>/dev/null || xdg-open https://nodejs.org/ 2>/dev/null)
  echo
  read -r -p "  Enter zum Schliessen ..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  Erster Start: Zubehoer wird installiert, das dauert kurz ..."
  npm install --omit=dev || { echo "  Installation fehlgeschlagen. Ist Internet da?"; read -r -p "  Enter zum Schliessen ..."; exit 1; }
fi

[ -f .env ] || cp .env.example .env

OPEN_BROWSER=1 node server.js
echo
echo "  Das Spiel wurde beendet."
read -r -p "  Enter zum Schliessen ..."
