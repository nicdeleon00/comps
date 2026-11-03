@echo off
title Comps drop monitor
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is needed to run the drop monitor.
  echo Install the LTS version from https://nodejs.org then double-click this file again.
  start https://nodejs.org
  pause
  exit /b 1
)
node monitor.mjs %*
pause
