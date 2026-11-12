@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First start: installing, this takes a minute...
  call npm install --no-audit --no-fund
)
start "" http://localhost:3000
node server.js
pause
