@echo off
:: Resolve repo root from this script's location so it works from any CWD.
cd /d "%~dp0"
echo Starting TALA Environment...
npm run dev
