@echo off
setlocal EnableDelayedExpansion

:: Ensure we are running from the Project Root
:: Derive repo root from this script's location (%~dp0 = scripts\diagnostics\)
:: Two levels up: scripts\diagnostics\ -> scripts\ -> repo root
cd /d "%~dp0..\.."

echo ===================================================
echo      Tala USB Environment Setup Script
echo ===================================================
echo.
echo This script rebuilds the Python Virtual Environments
echo for the Local Inference Engine and MCP Servers.
echo.
echo PREREQUISITES:
echo 1. Python 3.10+ installed and in PATH.
echo 2. Internet access (for first-time setup only).
echo.
pause

:: Check for Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python not found in PATH.
    echo Please install Python 3.10+ and try again.
    pause
    exit /b 1
)

echo [INFO] Python found. Proceeding...

:: ===========================================
:: 1. Local Inference Engine (Llama)
:: ===========================================
if exist "local-inference\requirements.txt" (
    echo.
    echo [SETUP] Setting up Local Inference Engine...
    if exist "local-inference\venv" (
        echo [INFO] Removing old venv...
        rmdir /s /q "local-inference\venv"
    )
    echo [INFO] Creating venv...
    python -m venv local-inference\venv
    echo [INFO] Installing dependencies (this may take time)...
    local-inference\venv\Scripts\python.exe -m pip install -r local-inference\requirements.txt
)

:: ===========================================
:: 2. MCP Servers
:: ===========================================
for %%D in (mcp-servers\tala-core mcp-servers\mem0-core mcp-servers\astro-engine) do (
    if exist "%%D\requirements.txt" (
        echo.
        echo [SETUP] Setting up %%D...
        if exist "%%D\venv" (
             echo [INFO] Removing old venv...
             rmdir /s /q "%%D\venv"
        )
        echo [INFO] Creating venv...
        python -m venv %%D\venv
        echo [INFO] Installing dependencies...
        %%D\venv\Scripts\python.exe -m pip install -r %%D\requirements.txt
    )
)

echo.
echo ===================================================
echo [SUCCESS] Environment Setup Complete!
echo You can now run Tala.exe or start_local_inference.bat
echo ===================================================
pause
