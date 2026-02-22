#!/bin/bash
echo "Starting Local Inference Engine (Llama.cpp Server)..."

# Set the current directory to the script's location
cd "$(dirname "$0")"

# Set N_CTX environment variable for context window size
export N_CTX=16384

# Use portable Python if available, otherwise fall back to venv
if [ -f "bin/python-portable/bin/python3" ]; then
    PYTHON_EXE="bin/python-portable/bin/python3"
elif [ -f "local-inference/venv/bin/python" ]; then
    PYTHON_EXE="local-inference/venv/bin/python"
else
    echo "[ERROR] No Python found. Run scripts/make_portable.sh or scripts/setup_usb.sh"
    exit 1
fi

# Start the llama-cpp-python server
echo "Using Python: $PYTHON_EXE"
"$PYTHON_EXE" -m llama_cpp.server \
    --model "models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf" \
    --host 127.0.0.1 \
    --port 8000 \
    --n_ctx $N_CTX \
    --n_gpu_layers 0 \
    --verbose True
