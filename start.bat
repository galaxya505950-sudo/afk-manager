@echo off
rem AFK Manager starten (Windows). Holt vorher automatisch das neueste Update.
rem Benoetigt: Node.js (https://nodejs.org) und Git (https://git-scm.com)
cd /d "%~dp0"
chcp 65001 >nul

if exist .git (
  echo Suche nach Updates ...
  git pull --ff-only
)

echo Pakete pruefen ...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 goto ende

if not exist panel.env copy panel.env.example panel.env >nul
rem Einstellungen aus panel.env laden (Zeilen mit # werden uebersprungen)
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("panel.env") do if not "%%b"=="" set "%%a=%%b"

node server.js

:ende
pause
