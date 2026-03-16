@echo off
setlocal EnableDelayedExpansion

echo ============================================================
echo      TALA - PORTABLE BUILD (Windows)
echo ============================================================
echo.
echo Creates a self-contained portable folder ready for USB.
echo No installation required on target machines.
echo.
pause

:: Derive repo root from this script's location (%~dp0 = scripts\diagnostics\)
:: Two levels up: scripts\diagnostics\ -> scripts\ -> repo root
cd /d "%~dp0..\.."
echo [INFO] Project root: %CD%

:: ============================================================
:: STEP 1: Check / Download Python runtime
:: ============================================================
echo.
echo [STEP 1/4] Checking bundled Python runtime...

set "PYTHON_VER=3.13.12"
set "PBS_TAG=20260211"
set "PY_WIN=cpython-%PYTHON_VER%+%PBS_TAG%-x86_64-pc-windows-msvc-install_only.tar.gz"
set "PY_URL=https://github.com/astral-sh/python-build-standalone/releases/download/%PBS_TAG%/%PY_WIN%"

if exist "bin\python-win\python.exe" (
    echo   [OK] bin\python-win\python.exe already exists.
    echo   Skipping download.
) else (
    echo   Downloading Python %PYTHON_VER%...
    if not exist "bin\python-win" mkdir "bin\python-win"
    powershell -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%PY_URL%' -OutFile 'bin\python-win.tar.gz'"
    if not exist "bin\python-win.tar.gz" (
        echo   [ERROR] Download failed. Check your internet connection.
        echo   URL: %PY_URL%
        pause
        exit /b 1
    )
    echo   Extracting...
    tar -xzf "bin\python-win.tar.gz" -C "bin\python-win" --strip-components=1
    del "bin\python-win.tar.gz"
    echo   [OK] Python downloaded and extracted.
)

:: ============================================================
:: STEP 2: Install Python dependencies
:: ============================================================
echo.
echo [STEP 2/4] Installing Python dependencies...

"bin\python-win\python.exe" -s -m pip install --no-user --upgrade pip --quiet 2>nul

if exist "local-inference\requirements.txt" (
    echo   Installing local-inference deps...
    "bin\python-win\python.exe" -s -m pip install --no-user -r "local-inference\requirements.txt" --quiet 2>nul
)

for %%D in (tala-core mem0-core astro-engine) do (
    if exist "mcp-servers\%%D\requirements.txt" (
        echo   Installing mcp-servers\%%D...
        "bin\python-win\python.exe" -s -m pip install --no-user -r "mcp-servers\%%D\requirements.txt" --quiet 2>nul
    )
)

echo   [OK] Dependencies installed.

:: ============================================================
:: STEP 3: Build Electron app
:: ============================================================
echo.
echo [STEP 3/4] Building Electron app...
echo   This includes TypeScript compile, Vite build, and electron-builder.
echo   electron-builder will bundle bin\, models\, mcp-servers\, etc.
echo.

call npm run dist

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Build failed. Check the errors above.
    echo   Common fix: npm install   then re-run this script.
    pause
    exit /b 1
)

:: ============================================================
:: STEP 4: Verify output
:: ============================================================
echo.
echo [STEP 4/4] Verifying portable build...

set "DIST=dist\win-unpacked"

echo.
echo Checking %DIST%\:
:: Create portable.flag so the app stores data on USB, not %APPDATA%
echo. > "%DIST%\portable.flag"
echo   [OK] portable.flag created

if exist "%DIST%\Tala.exe" (echo   [OK] Tala.exe) else (echo   [MISSING] Tala.exe)
if exist "%DIST%\bin\python-win\python.exe" (echo   [OK] bin\python-win\python.exe) else (echo   [MISSING] bin\python-win\python.exe)
if exist "%DIST%\models" (echo   [OK] models\) else (echo   [WARN] models\ - add a .gguf model)
if exist "%DIST%\mcp-servers\tala-core" (echo   [OK] mcp-servers\tala-core) else (echo   [MISSING] mcp-servers\tala-core)
if exist "%DIST%\memory" (echo   [OK] memory\) else (echo   [WARN] memory\)
if exist "%DIST%\launch-inference.bat" (echo   [OK] launch-inference.bat) else (echo   [WARN] launch-inference.bat)

echo.
echo ============================================================
echo [SUCCESS] Portable build created at: %DIST%\
echo.
echo TO USE:
echo   1. Copy the '%DIST%' folder to your USB drive
echo   2. On target machine, double-click Tala.exe
echo   3. For AI brain, double-click launch-inference.bat
echo ============================================================
pause
