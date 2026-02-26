@echo off
:: ============================================================
:: TALA INFERENCE LAUNCHER - Windows
:: ============================================================
:: Double-click this file to start the AI Brain on Windows.

cd /d "%~dp0"

:: 1. Check if Ollama is already running (Port 11434)
netstat -ano | findstr :11434 >nul
if %ERRORLEVEL% equ 0 (
    echo.
    echo [INFO] Ollama detected on port 11434. 
    echo [INFO] Skipping local llama_cpp instance to avoid conflicts.
    echo [INFO] Entering standby mode to keep the process tree alive...
    echo.
    :: Loop indefinitely so `concurrently` does not terminate the other services
    :idle_loop
    ping 127.0.0.1 -n 60 >nul
    goto idle_loop
)

set "N_CTX=16384"
set "PYTHON_EXE=bin\python-win\python.exe"

if not exist "%PYTHON_EXE%" (
    :: Fallback to other possible locations
    if exist "bin\python-portable\python.exe" (
        set "PYTHON_EXE=bin\python-portable\python.exe"
    ) else if exist "bin\python\python.exe" (
        set "PYTHON_EXE=bin\python\python.exe"
    ) else (
        echo [ERROR] No Python runtime found.
        echo Expected at: bin\python-win\python.exe
        pause
        exit /b 1
    )
)

:: Find model file
set "MODEL="
for %%f in (models\*.gguf) do set "MODEL=%%f"

if "%MODEL%"=="" (
    echo [ERROR] No .gguf model found in models\ directory.
    pause
    exit /b 1
)

echo ============================================================
echo   TALA Local Inference Engine
echo   Python: %PYTHON_EXE%
echo   Model:  %MODEL%
echo   Context: %N_CTX% tokens
echo ============================================================
echo.

"%PYTHON_EXE%" -m llama_cpp.server ^
    --model "%MODEL%" ^
    --host 127.0.0.1 ^
    --port 8080 ^
    --n_ctx %N_CTX% ^
    --n_gpu_layers 0 ^
    --verbose True

pause
