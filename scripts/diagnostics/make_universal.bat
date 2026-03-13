@echo off
setlocal EnableDelayedExpansion

echo ============================================================
echo      TALA - UNIVERSAL BUILD SYSTEM
echo ============================================================
echo.
echo Builds a single portable package for Windows, Mac, and Linux.
echo No installation required on target machines.
echo.
echo Estimated size: 8-12 GB
echo Estimated time: 30-60 minutes
echo.
pause

:: ============================================================
:: CONFIGURATION - Update these if newer versions are available
:: ============================================================
set "PYTHON_VER=3.13.12"
set "PBS_TAG=20260211"
set "PBS_BASE=https://github.com/astral-sh/python-build-standalone/releases/download/%PBS_TAG%"

:: Python-build-standalone file names (install_only = includes pip)
set "PY_WIN=cpython-%PYTHON_VER%+%PBS_TAG%-x86_64-pc-windows-msvc-install_only.tar.gz"
set "PY_MAC=cpython-%PYTHON_VER%+%PBS_TAG%-x86_64-apple-darwin-install_only.tar.gz"
set "PY_MAC_ARM=cpython-%PYTHON_VER%+%PBS_TAG%-aarch64-apple-darwin-install_only.tar.gz"
set "PY_LINUX=cpython-%PYTHON_VER%+%PBS_TAG%-x86_64-unknown-linux-gnu-install_only.tar.gz"

:: Output directory
set "OUT=universal-build"

:: Ensure we run from project root
cd /d "%~dp0.."
echo [INFO] Project root: %CD%

:: ============================================================
:: STEP 0: Clean and create directory structure
:: ============================================================
echo.
echo [STEP 0/7] Creating directory structure...
if exist "%OUT%" (
    echo   Cleaning previous build...
    rmdir /s /q "%OUT%"
)

mkdir "%OUT%"
mkdir "%OUT%\bin\python-win"
mkdir "%OUT%\bin\python-mac"
mkdir "%OUT%\bin\python-linux"
mkdir "%OUT%\platforms"
mkdir "%OUT%\downloads"

:: ============================================================
:: STEP 1: Download Python runtimes
:: ============================================================
echo.
echo [STEP 1/7] Downloading Python %PYTHON_VER% for all platforms...
echo   (This may take a few minutes)

echo   [1/3] Windows...
powershell -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%PBS_BASE%/%PY_WIN%' -OutFile '%OUT%\downloads\python-win.tar.gz'"
if not exist "%OUT%\downloads\python-win.tar.gz" (
    echo [ERROR] Failed to download Windows Python. Check URL:
    echo %PBS_BASE%/%PY_WIN%
    echo.
    echo TIP: Visit https://github.com/astral-sh/python-build-standalone/releases
    echo and update the PBS_TAG and filename variables at the top of this script.
    pause
    exit /b 1
)

echo   [2/3] macOS (Intel)...
powershell -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%PBS_BASE%/%PY_MAC%' -OutFile '%OUT%\downloads\python-mac.tar.gz'"

echo   [3/3] Linux...
powershell -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%PBS_BASE%/%PY_LINUX%' -OutFile '%OUT%\downloads\python-linux.tar.gz'"

echo   Downloads complete.

:: ============================================================
:: STEP 2: Extract Python runtimes
:: ============================================================
echo.
echo [STEP 2/7] Extracting Python runtimes...

echo   [1/3] Windows...
tar -xzf "%OUT%\downloads\python-win.tar.gz" -C "%OUT%\bin\python-win" --strip-components=1

echo   [2/3] macOS...
tar -xzf "%OUT%\downloads\python-mac.tar.gz" -C "%OUT%\bin\python-mac" --strip-components=1

echo   [3/3] Linux...
tar -xzf "%OUT%\downloads\python-linux.tar.gz" -C "%OUT%\bin\python-linux" --strip-components=1

:: ============================================================
:: STEP 3: Install dependencies into Windows Python (direct)
:: ============================================================
echo.
echo [STEP 3/7] Installing Python dependencies (Windows - direct)...

"%OUT%\bin\python-win\python.exe" -m pip install --upgrade pip --quiet

echo   Installing local-inference deps...
"%OUT%\bin\python-win\python.exe" -m pip install -r local-inference\requirements.txt --quiet

for %%D in (mcp-servers\tala-core mcp-servers\mem0-core mcp-servers\astro-engine) do (
    if exist "%%D\requirements.txt" (
        echo   Installing %%D...
        "%OUT%\bin\python-win\python.exe" -m pip install -r "%%D\requirements.txt" --quiet
    )
)

:: ============================================================
:: STEP 4: Cross-install dependencies for Mac and Linux
:: ============================================================
echo.
echo [STEP 4/7] Cross-installing Python dependencies (Mac/Linux)...
echo   Using pip to download platform-specific wheels.
echo   Packages without pre-built wheels will be skipped.

:: Collect all requirements into one temp file
type nul > "%OUT%\downloads\all_requirements.txt"
if exist "local-inference\requirements.txt" type "local-inference\requirements.txt" >> "%OUT%\downloads\all_requirements.txt"
for %%D in (mcp-servers\tala-core mcp-servers\mem0-core mcp-servers\astro-engine) do (
    if exist "%%D\requirements.txt" type "%%D\requirements.txt" >> "%OUT%\downloads\all_requirements.txt"
)

:: Mac (Intel x86_64)
echo   [1/2] macOS (Intel x86_64)...
"%OUT%\bin\python-win\python.exe" -m pip install ^
    --target "%OUT%\bin\python-mac\lib\python3.13\site-packages" ^
    --platform macosx_11_0_x86_64 ^
    --python-version 313 ^
    --only-binary :all: ^
    --upgrade --no-deps ^
    -r "%OUT%\downloads\all_requirements.txt" 2>nul
echo   (Some packages may have been skipped if no Mac wheel exists)

:: Linux (x86_64 glibc)
echo   [2/2] Linux (x86_64)...
"%OUT%\bin\python-win\python.exe" -m pip install ^
    --target "%OUT%\bin\python-linux\lib\python3.13\site-packages" ^
    --platform manylinux2014_x86_64 ^
    --python-version 313 ^
    --only-binary :all: ^
    --upgrade --no-deps ^
    -r "%OUT%\downloads\all_requirements.txt" 2>nul
echo   (Some packages may have been skipped if no Linux wheel exists)

:: ============================================================
:: STEP 5: Build Electron app (Windows)
:: ============================================================
echo.
echo [STEP 5/7] Building Electron app (Windows)...
call npm run build
call npx electron-builder --win --dir --config.directories.output="%OUT%\platforms\win"

:: ============================================================
:: STEP 6: Attempt Linux Electron cross-build
:: ============================================================
echo.
echo [STEP 6/7] Attempting Linux Electron cross-build...
echo   (May fail due to native modules - this is expected)
call npx electron-builder --linux --dir --config.directories.output="%OUT%\platforms\linux" 2>nul
if %errorlevel% neq 0 (
    echo   [WARNING] Linux cross-build failed (native modules like node-pty).
    echo   To build for Linux, run on a Linux machine or use GitHub Actions.
    mkdir "%OUT%\platforms\linux" 2>nul
    echo Build on a Linux machine with: npm run dist > "%OUT%\platforms\linux\BUILD_ON_LINUX.txt"
)

:: ============================================================
:: STEP 7: Assemble universal package
:: ============================================================
echo.
echo [STEP 7/7] Assembling universal package...

:: Copy shared resources
echo   Copying models...
if exist "models" (
    if not exist "%OUT%\models" mkdir "%OUT%\models"
    xcopy /E /I /Q /Y "models" "%OUT%\models"
)

echo   Copying memory...
if exist "memory" (
    if not exist "%OUT%\memory" mkdir "%OUT%\memory"
    xcopy /E /I /Q /Y "memory" "%OUT%\memory"
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
if exist "local-inference\requirements.txt" copy /Y "local-inference\requirements.txt" "%OUT%\local-inference\" >nul
if exist "local-inference\start_server.py" copy /Y "local-inference\start_server.py" "%OUT%\local-inference\" >nul

:: Copy launchers
echo   Copying launchers...
copy /Y "launch.bat" "%OUT%\" >nul
copy /Y "launch.sh" "%OUT%\" >nul
copy /Y "launch-inference.bat" "%OUT%\" >nul
copy /Y "launch-inference.sh" "%OUT%\" >nul
copy /Y "CROSS_PLATFORM_BUILD.txt" "%OUT%\" >nul

:: Copy app settings
if exist "app_settings.json" copy /Y "app_settings.json" "%OUT%\" >nul

:: Cleanup downloads
echo   Cleaning up downloads...
if exist "%OUT%\downloads" rmdir /s /q "%OUT%\downloads"

echo.
echo ============================================================
echo [SUCCESS] Universal build created at: %OUT%\
echo.
echo Verification:
if exist "%OUT%\launch.bat" (echo   [OK] launch.bat) else (echo   [MISSING] launch.bat)
if exist "%OUT%\launch-inference.bat" (echo   [OK] launch-inference.bat) else (echo   [MISSING] launch-inference.bat)
if exist "%OUT%\bin\python-win\python.exe" (echo   [OK] bin\python-win\python.exe) else (echo   [MISSING] bin\python-win\)
if exist "%OUT%\models\*.gguf" (echo   [OK] models\*.gguf) else (echo   [WARN] No .gguf model found)
if exist "%OUT%\mcp-servers\tala-core" (echo   [OK] mcp-servers\tala-core) else (echo   [MISSING] mcp-servers\tala-core)
if exist "%OUT%\memory" (echo   [OK] memory\) else (echo   [MISSING] memory\)
echo.
echo Copy the '%OUT%' folder to your USB drive!
echo ============================================================
pause
