@echo off
setlocal EnableDelayedExpansion

:: Derive repo root from this script's location (%~dp0 = scripts\diagnostics\)
:: Two levels up: scripts\diagnostics\ -> scripts\ -> repo root
cd /d "%~dp0..\.."
echo [INFO] Repo root: %CD%

echo ============================================================
echo      TALA - FULLY PORTABLE BUILD CREATOR
echo ============================================================
echo.
echo This script creates a ZERO-INSTALLATION portable build.
echo Target machines will NOT need Python or Node.js installed.
echo.
echo PREREQUISITES:
echo 1. Download Python 3.13 Embeddable (64-bit) from:
echo    https://www.python.org/ftp/python/3.13.3/python-3.13.3-embed-amd64.zip
echo 2. Save it as: resources\python-3.13-embed-amd64.zip
echo.
pause

:: Check for Python embeddable package
if not exist "resources\python-3.13-embed-amd64.zip" (
    echo [ERROR] Python embeddable package not found!
    echo Please download it from the link above and save to:
    echo %CD%\resources\python-3.13-embed-amd64.zip
    pause
    exit /b 1
)

:: Create directories
if not exist "resources\" mkdir resources
if exist "bin\python-portable\" (
    echo [INFO] Removing old portable python...
    rmdir /s /q "bin\python-portable"
)
mkdir "bin\python-portable"

:: Extract Python
echo [STEP 1/5] Extracting Python 3.13 embeddable...
powershell -Command "Expand-Archive -Path 'resources\python-3.13-embed-amd64.zip' -DestinationPath 'bin\python-portable' -Force"

:: Enable site-packages
echo [STEP 2/5] Enabling site-packages...
pushd bin\python-portable
for %%f in (python*._pth) do (
    echo import site >> %%f
)
popd

:: Download and install pip
echo [STEP 3/5] Installing pip...
powershell -Command "Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile 'bin\python-portable\get-pip.py'"
bin\python-portable\python.exe bin\python-portable\get-pip.py

:: Install local-inference dependencies
echo [STEP 4/5] Installing Local Inference dependencies...
if exist "local-inference\requirements.txt" (
    bin\python-portable\python.exe -m pip install -r local-inference\requirements.txt
) else (
    echo [SKIP] local-inference\requirements.txt not found
)

:: Install MCP server dependencies
echo [STEP 5/5] Installing MCP Server dependencies...
for %%D in (mcp-servers\tala-core mcp-servers\mem0-core mcp-servers\astro-engine) do (
    if exist "%%D\requirements.txt" (
        echo   Installing %%D...
        bin\python-portable\python.exe -m pip install -r %%D\requirements.txt
    )
)

echo.
echo ============================================================
echo [SUCCESS] Portable Build Created!
echo.
echo Next Steps:
echo 1. Run: npm run dist
echo 2. Copy dist\win-unpacked to USB
echo 3. Test on a clean machine (no Python/Node installed)
echo ============================================================
pause
