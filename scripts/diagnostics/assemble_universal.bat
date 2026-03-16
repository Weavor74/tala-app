@echo off
setlocal EnableDelayedExpansion

:: ============================================================
:: TALA - ASSEMBLE UNIVERSAL BUILD
:: ============================================================
:: Run this if the build completed Steps 0-6 but Step 7 failed.
:: It copies launchers, models, memory, and MCP servers into
:: the universal-build folder.

cd /d "%~dp0..\.."
set "OUT=universal-build"

echo [INFO] Project root: %CD%
echo [INFO] Output: %OUT%\

if not exist "%OUT%\bin\python-win" (
    echo [ERROR] universal-build\bin\python-win not found.
    echo Run scripts\make_universal.bat first.
    pause
    exit /b 1
)

echo.
echo [STEP 7] Assembling universal package...

:: Copy shared resources
echo   Copying models...
if exist "models" (
    if not exist "%OUT%\models" mkdir "%OUT%\models"
    xcopy /E /I /Q /Y "models" "%OUT%\models"
) else (
    echo   [SKIP] No models\ directory found.
)

echo   Copying memory...
if exist "memory" (
    if not exist "%OUT%\memory" mkdir "%OUT%\memory"
    xcopy /E /I /Q /Y "memory" "%OUT%\memory"
) else (
    echo   [SKIP] No memory\ directory found.
)

echo   Copying MCP servers (source code only, no venvs)...
for %%D in (tala-core mem0-core astro-engine browser-use-core) do (
    if exist "mcp-servers\%%D" (
        echo     %%D...
        if not exist "%OUT%\mcp-servers\%%D" mkdir "%OUT%\mcp-servers\%%D"
        robocopy "mcp-servers\%%D" "%OUT%\mcp-servers\%%D" /E /XD venv __pycache__ .git /XF *.pyc /NFL /NDL /NJH /NJS /NC /NS /NP >nul
    )
)

echo   Copying local-inference config...
if not exist "%OUT%\local-inference" mkdir "%OUT%\local-inference"
if exist "local-inference\requirements.txt" (
    copy /Y "local-inference\requirements.txt" "%OUT%\local-inference\" >nul
)
if exist "local-inference\start_server.py" (
    copy /Y "local-inference\start_server.py" "%OUT%\local-inference\" >nul
)

:: Copy launchers
echo   Copying launchers...
copy /Y "launch.bat" "%OUT%\" >nul
copy /Y "launch.sh" "%OUT%\" >nul
copy /Y "launch-inference.bat" "%OUT%\" >nul
copy /Y "launch-inference.sh" "%OUT%\" >nul
copy /Y "CROSS_PLATFORM_BUILD.txt" "%OUT%\" >nul

:: Copy app settings
if exist "app_settings.json" (
    echo   Copying app_settings.json...
    copy /Y "app_settings.json" "%OUT%\" >nul
)

:: Cleanup downloads
if exist "%OUT%\downloads" (
    echo   Cleaning up downloads...
    rmdir /s /q "%OUT%\downloads"
)

echo.
echo ============================================================
echo [SUCCESS] Universal build assembled at: %OUT%\
echo.
echo Verify these exist:
if exist "%OUT%\launch.bat" (echo   [OK] launch.bat) else (echo   [MISSING] launch.bat)
if exist "%OUT%\launch-inference.bat" (echo   [OK] launch-inference.bat) else (echo   [MISSING] launch-inference.bat)
if exist "%OUT%\bin\python-win\python.exe" (echo   [OK] bin\python-win\python.exe) else (echo   [MISSING] bin\python-win\python.exe)
if exist "%OUT%\models\*.gguf" (echo   [OK] models\*.gguf) else (echo   [MISSING] models\*.gguf - add a model!)
if exist "%OUT%\mcp-servers\tala-core" (echo   [OK] mcp-servers\tala-core) else (echo   [MISSING] mcp-servers\tala-core)
if exist "%OUT%\memory" (echo   [OK] memory\) else (echo   [MISSING] memory\)
echo.
echo Copy the '%OUT%' folder to your USB drive!
echo ============================================================
pause
