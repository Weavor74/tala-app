@echo off
set "VENV_DIR=.\local-inference\venv"
set "MODEL_PATH=.\models\Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf"
set "HOST=127.0.0.1"
set "PORT=8000"
:: Set context size as environment variable to ensure it is picked up
set "N_CTX=16384"

echo Starting Local Inference Engine (Llama.cpp Server)...

:: Set the current directory to the script's location
cd /d "%~dp0"

:: Use portable Python if available, otherwise fall back to venv
set "PYTHON_EXE=bin\python-portable\python.exe"
if not exist "%PYTHON_EXE%" (
    set "PYTHON_EXE=local-inference\venv\Scripts\python.exe"
)

:: Start the llama-cpp-python server
echo Using Python: %PYTHON_EXE%
"%PYTHON_EXE%" -m llama_cpp.server ^
    --model "models\Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf" ^
    --host 127.0.0.1 ^
    --port 8000 ^
    --n_ctx %N_CTX% ^
    --n_gpu_layers 0 ^
    --verbose True

pause
