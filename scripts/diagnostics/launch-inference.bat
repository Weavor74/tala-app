@echo off
:: ============================================================
:: TALA INFERENCE LAUNCHER - Windows
:: ============================================================
:: Canonical local launcher for dev/diagnostics.
:: Active local doctrine: ollama + embedded_vllm.

set "REPO_ROOT=%~dp0..\.."
pushd "%REPO_ROOT%"
set "REPO_ROOT=%CD%"

set "VLLM_PORT=%TALA_VLLM_PORT%"
if "%VLLM_PORT%"=="" set "VLLM_PORT=8000"

echo.
echo [INFO] Tala local inference launcher (provider=embedded_vllm)
echo [INFO] Repo root: %REPO_ROOT%
echo [INFO] Target port: %VLLM_PORT%
echo.

netstat -ano | findstr :%VLLM_PORT% >nul
if %ERRORLEVEL% equ 0 (
    echo [INFO] Embedded vLLM already reachable on port %VLLM_PORT%.
    echo [INFO] Entering standby loop so dev process topology remains stable.
    :idle_loop
    ping 127.0.0.1 -n 60 >nul
    goto idle_loop
)

set "VLLM_LAUNCHER=scripts\run-vllm.bat"
if not exist "%VLLM_LAUNCHER%" (
    echo [ERROR] Embedded vLLM launcher not found: %VLLM_LAUNCHER%
    popd
    exit /b 1
)

echo [INFO] Starting embedded vLLM via %VLLM_LAUNCHER% ...
call "%VLLM_LAUNCHER%"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo [ERROR] Embedded vLLM launcher exited with code %EXIT_CODE%.
    popd
    exit /b %EXIT_CODE%
)

popd
