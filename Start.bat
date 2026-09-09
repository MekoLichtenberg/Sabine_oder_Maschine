@echo off
title MENSCH//KI
cd /d "%~dp0"
echo.
echo   MENSCH//KI wird gestartet ...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js fehlt noch. Das ist einmalig noetig.
  echo   Es oeffnet sich jetzt die Download-Seite: bitte "LTS" installieren,
  echo   danach diese Datei nochmal doppelklicken.
  start "" https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo   Erster Start: Zubehoer wird installiert, das dauert kurz ...
  call npm install --omit=dev
  if errorlevel 1 (
    echo   Installation fehlgeschlagen. Ist Internet da?
    pause
    exit /b 1
  )
)

if not exist .env copy .env.example .env >nul

set OPEN_BROWSER=1
node server.js
echo.
echo   Das Spiel wurde beendet.
pause
