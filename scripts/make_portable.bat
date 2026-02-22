@echo off
setlocal EnableDelayedExpansion

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
    echo resources\python-3.13-embed-amd64.zip
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
echo [STEP 1/6] Extracting Python 3.13 embeddable...
powershell -Command "Expand-Archive -Path 'resources\python-3.13-embed-amd64.zip' -DestinationPath 'bin\python-portable' -Force"

:: Enable site-packages
echo [STEP 2/6] Enabling site-packages...
cd bin\python-portable
for %%f in (python*._pth) do (
    echo import site >> %%f
)
cd ..\..

:: Download and install pip
echo [STEP 3/6] Installing pip...
powershell -Command "Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile 'bin\python-portable\get-pip.py'"
bin\python-portable\python.exe bin\python-portable\get-pip.py

:: Install local-inference dependencies
echo [STEP 4/6] Installing Local Inference dependencies...
bin\python-portable\python.exe -m pip install -r local-inference\requirements.txt

:: Install MCP server dependencies
echo [STEP 5/6] Installing MCP Server dependencies...
for %%D in (mcp-servers\tala-core mcp-servers\mem0-core mcp-servers\astro-engine) do (
    if exist "%%D\requirements.txt" (
        echo   Installing %%D...
        bin\python-portable\python.exe -m pip install -r %%D\requirements.txt
    )
)

:: Update launch script
echo [STEP 6/6] Updating launch scripts...
call scripts\update_portable_paths.bat

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
