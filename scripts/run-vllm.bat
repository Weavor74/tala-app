@echo off
:: ==============================================================
:: TALA vLLM INFERENCE LAUNCHER - Windows
:: ==============================================================
:: Starts the vLLM OpenAI-compatible API server on 127.0.0.1:8000.
:: Safe to run from any directory — paths resolve relative to this script.
::
:: Required:
::   Run scripts\bootstrap-vllm.ps1 first to install vLLM.
::
:: Environment variables:
::   TALA_VLLM_MODEL   - HuggingFace model ID or local model path
::                       Default: checks local-inference\vllm-models\ for a directory,
::                       then falls back to "microsoft/phi-2"
::   TALA_VLLM_PORT    - Port for the API server (default: 8000)
::   TALA_VLLM_HOST    - Bind host (default: 127.0.0.1)
::   TALA_VLLM_DTYPE   - Data type: auto, float16, bfloat16 (default: auto)
::   TALA_VLLM_GPU_MEM - GPU memory utilization fraction 0.0-1.0 (default: 0.9)
::   TALA_VLLM_CPU     - Set to "1" to force CPU-only mode (no GPU)

:: Derive repo root from this script's location (%~dp0 = scripts\)
set "REPO_ROOT=%~dp0.."
pushd "%REPO_ROOT%"
set "REPO_ROOT=%CD%"

:: Defaults
if "%TALA_VLLM_PORT%"==""    set "TALA_VLLM_PORT=8000"
if "%TALA_VLLM_HOST%"==""    set "TALA_VLLM_HOST=127.0.0.1"
if "%TALA_VLLM_DTYPE%"==""   set "TALA_VLLM_DTYPE=auto"
if "%TALA_VLLM_GPU_MEM%"=="" set "TALA_VLLM_GPU_MEM=0.9"

:: Locate Python in the vLLM venv (created by bootstrap-vllm.ps1)
set "PYTHON_EXE=%REPO_ROOT%\local-inference\vllm-venv\Scripts\python.exe"
set "VLLM_ENTRY=%REPO_ROOT%\scripts\vllm-server-entry.py"

if not exist "%PYTHON_EXE%" (
    echo [VLLM] ERROR: vLLM virtual environment not found at:
    echo         %PYTHON_EXE%
    echo [VLLM] Run scripts\bootstrap-vllm.ps1 first to install vLLM.
    popd
    if /I not "%TALA_NONINTERACTIVE%"=="1" pause
    exit /b 1
)

if not exist "%VLLM_ENTRY%" (
    echo [VLLM] ERROR: Tala vLLM launcher entry script not found at:
    echo         %VLLM_ENTRY%
    popd
    if /I not "%TALA_NONINTERACTIVE%"=="1" pause
    exit /b 1
)

:: Resolve model — env var takes precedence, then look for a local model directory
set "MODEL=%TALA_VLLM_MODEL%"

if "%MODEL%"=="" (
    :: Search for a subdirectory in local-inference\vllm-models\
    for /d %%d in ("%REPO_ROOT%\local-inference\vllm-models\*") do (
        if "%MODEL%"=="" set "MODEL=%%d"
    )
)

if "%MODEL%"=="" (
    :: Default small model suitable for CPU or low-VRAM GPU
    set "MODEL=microsoft/phi-2"
    echo [VLLM] WARN: No model configured. Defaulting to %MODEL%.
    echo [VLLM] WARN: Set TALA_VLLM_MODEL to a local path or HuggingFace model ID.
)

echo ============================================================
echo   TALA vLLM Inference Server
echo   Repo:    %REPO_ROOT%
echo   Python:  %PYTHON_EXE%
echo   Model:   %MODEL%
echo   Listen:  %TALA_VLLM_HOST%:%TALA_VLLM_PORT%
echo   Dtype:   %TALA_VLLM_DTYPE%
echo ============================================================
echo.

:: CPU-only mode: disable CUDA device
if "%TALA_VLLM_CPU%"=="1" (
    echo [VLLM] CPU-only mode enabled.
    set "CUDA_VISIBLE_DEVICES="
    "%PYTHON_EXE%" "%VLLM_ENTRY%" ^
        --model "%MODEL%" ^
        --host %TALA_VLLM_HOST% ^
        --port %TALA_VLLM_PORT% ^
        --dtype %TALA_VLLM_DTYPE% ^
        --device cpu
) else (
    "%PYTHON_EXE%" "%VLLM_ENTRY%" ^
        --model "%MODEL%" ^
        --host %TALA_VLLM_HOST% ^
        --port %TALA_VLLM_PORT% ^
        --dtype %TALA_VLLM_DTYPE% ^
        --gpu-memory-utilization %TALA_VLLM_GPU_MEM%
)

popd
if /I not "%TALA_NONINTERACTIVE%"=="1" pause
