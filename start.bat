@echo off
rem Starts the invoice web client on Windows. Double-click it, or run it from cmd.
rem   start.bat             start and open the browser
rem   start.bat --no-open   start without opening the browser
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required but was not found.
  echo Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 18 or newer is required. Install a newer version from https://nodejs.org
  pause
  exit /b 1
)

if not exist key (
  echo WARNING: no key file found. Put your API secret in a file named "key" in:
  echo   %~dp0
)

node server\server.js %*
if errorlevel 1 pause
