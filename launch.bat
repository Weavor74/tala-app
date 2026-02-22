@echo off
:: ============================================================
:: TALA UNIVERSAL LAUNCHER - Windows
:: ============================================================
:: Double-click this file to launch Tala on Windows.

cd /d "%~dp0"

if exist "platforms\win\Tala.exe" (
    echo Launching Tala...
    start "" "platforms\win\Tala.exe"
) else if exist "Tala.exe" (
    echo Launching Tala...
    start "" "Tala.exe"
) else (
    echo [ERROR] Tala.exe not found (Compiled/Portable build not found).
    echo Expected at: platforms\win\Tala.exe
    echo.
    echo If you want to run in Development Mode, run: dev.bat
    echo.
    echo Otherwise, did you run scripts\make_universal.bat first?
    pause
)
