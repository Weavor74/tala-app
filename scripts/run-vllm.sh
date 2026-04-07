#!/usr/bin/env bash
# ==============================================================
# TALA vLLM INFERENCE LAUNCHER - Linux/macOS
# ==============================================================
# Starts the vLLM OpenAI-compatible API server on 127.0.0.1:8000.
# Safe to run from any directory — paths resolve relative to this script.
#
# Required:
#   Run bash scripts/bootstrap-vllm.sh first to install vLLM.
#
# Environment variables:
#   TALA_VLLM_MODEL   - HuggingFace model ID or local model path
#                       Default: checks local-inference/vllm-models/ for a directory,
#                       then falls back to "microsoft/phi-2"
#   TALA_VLLM_PORT    - Port for the API server (default: 8000)
#   TALA_VLLM_HOST    - Bind host (default: 127.0.0.1)
#   TALA_VLLM_DTYPE   - Data type: auto, float16, bfloat16 (default: auto)
#   TALA_VLLM_GPU_MEM - GPU memory utilization fraction 0.0-1.0 (default: 0.9)
#   TALA_VLLM_CPU     - Set to "1" to force CPU-only mode (no GPU)
# ==============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

# Defaults
TALA_VLLM_PORT="${TALA_VLLM_PORT:-8000}"
TALA_VLLM_HOST="${TALA_VLLM_HOST:-127.0.0.1}"
TALA_VLLM_DTYPE="${TALA_VLLM_DTYPE:-auto}"
TALA_VLLM_GPU_MEM="${TALA_VLLM_GPU_MEM:-0.9}"

# Locate Python in the vLLM venv
PYTHON_EXE="$REPO_ROOT/local-inference/vllm-venv/bin/python"

if [ ! -f "$PYTHON_EXE" ]; then
    echo -e "${RED}[VLLM] ERROR: vLLM virtual environment not found at:${NC}"
    echo "       $PYTHON_EXE"
    echo -e "${RED}[VLLM] Run bash scripts/bootstrap-vllm.sh first to install vLLM.${NC}"
    exit 1
fi

# Resolve model — env var takes precedence, then look for a local model directory
MODEL="${TALA_VLLM_MODEL:-}"

if [ -z "$MODEL" ]; then
    # Search for the first subdirectory in local-inference/vllm-models/
    MODELS_DIR="$REPO_ROOT/local-inference/vllm-models"
    if [ -d "$MODELS_DIR" ]; then
        for d in "$MODELS_DIR"/*/; do
            if [ -d "$d" ]; then
                MODEL="$d"
                break
            fi
        done
    fi
fi

if [ -z "$MODEL" ]; then
    MODEL="microsoft/phi-2"
    echo -e "${YELLOW}[VLLM] WARN: No model configured. Defaulting to $MODEL.${NC}"
    echo -e "${YELLOW}[VLLM] WARN: Set TALA_VLLM_MODEL to a local path or HuggingFace model ID.${NC}"
fi

echo "============================================================"
echo "  TALA vLLM Inference Server"
echo "  Repo:    $REPO_ROOT"
echo "  Python:  $PYTHON_EXE"
echo "  Model:   $MODEL"
echo "  Listen:  $TALA_VLLM_HOST:$TALA_VLLM_PORT"
echo "  Dtype:   $TALA_VLLM_DTYPE"
echo "============================================================"
echo ""

if [ "${TALA_VLLM_CPU:-0}" = "1" ]; then
    echo -e "${CYAN}[VLLM] CPU-only mode enabled.${NC}"
    export CUDA_VISIBLE_DEVICES=""
    "$PYTHON_EXE" -m vllm.entrypoints.openai.api_server \
        --model "$MODEL" \
        --host "$TALA_VLLM_HOST" \
        --port "$TALA_VLLM_PORT" \
        --dtype "$TALA_VLLM_DTYPE" \
        --device cpu
else
    "$PYTHON_EXE" -m vllm.entrypoints.openai.api_server \
        --model "$MODEL" \
        --host "$TALA_VLLM_HOST" \
        --port "$TALA_VLLM_PORT" \
        --dtype "$TALA_VLLM_DTYPE" \
        --gpu-memory-utilization "$TALA_VLLM_GPU_MEM"
fi
