#!/bin/bash
# ============================================================
# TALA INFERENCE LAUNCHER - macOS / Linux
# ============================================================
# Usage: ./launch-inference.sh

cd "$(dirname "$0")"

export N_CTX=16384

# Detect platform and set Python path
if [[ "$OSTYPE" == "darwin"* ]]; then
    PYTHON_EXE="bin/python-mac/bin/python3"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    PYTHON_EXE="bin/python-linux/bin/python3"
else
    echo "[ERROR] Unsupported platform: $OSTYPE"
    exit 1
fi

# Fallback paths
if [ ! -f "$PYTHON_EXE" ]; then
    if [ -f "bin/python-portable/bin/python3" ]; then
        PYTHON_EXE="bin/python-portable/bin/python3"
    else
        echo "[ERROR] No Python runtime found."
        echo "Expected at: $PYTHON_EXE"
        exit 1
    fi
fi

# Find model file
MODEL=$(ls models/*.gguf 2>/dev/null | head -1)

if [ -z "$MODEL" ]; then
    echo "[ERROR] No .gguf model found in models/ directory."
    exit 1
fi

echo "============================================================"
echo "  TALA Local Inference Engine"
echo "  Python:  $PYTHON_EXE"
echo "  Model:   $MODEL"
echo "  Context: $N_CTX tokens"
echo "============================================================"
echo ""

chmod +x "$PYTHON_EXE"
"$PYTHON_EXE" -m llama_cpp.server \
    --model "$MODEL" \
    --host 127.0.0.1 \
    --port 8000 \
    --n_ctx $N_CTX \
    --n_gpu_layers 0 \
    --verbose True
