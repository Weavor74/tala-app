@echo off
:: ============================================================
:: TALA Unified Dev Launcher
:: ============================================================
:: This batch file starts Vite, Electron, and the Inference Server
:: concurrently using the dev environment.

cd /d "%~dp0"

echo Starting Tala Development Environment...
npm run dev
