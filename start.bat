@echo off
rem Starts the invoice program on Windows. Double-click it, or run it from cmd.
rem   start.bat             start and open the page in the browser
rem   start.bat --no-open   start without opening the browser
setlocal
rem Show Greek text correctly in this window.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Χρειάζεται το Node.js ^(έκδοση 18 ή νεότερη^) και δεν βρέθηκε.
  echo Εγκατάστησέ το από το https://nodejs.org και άνοιξε ξανά αυτό το αρχείο.
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)"
if errorlevel 1 (
  echo Χρειάζεται Node.js 18 ή νεότερο. Εγκατάστησε νεότερη έκδοση από το https://nodejs.org
  pause
  exit /b 1
)

node server\server.js %*
if errorlevel 1 pause
