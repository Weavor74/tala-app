#!/usr/bin/env bash
# ==============================================================
# Bootstrap vLLM embedded inference provider for TALA (Linux/macOS)
#
# Installs vLLM and required dependencies into a dedicated Python
# virtual environment at local-inference/vllm-venv/.
#
# Responsibilities:
#   1. Detects a project-local or system Python 3 interpreter.
#   2. Creates a venv at <REPO_ROOT>/local-inference/vllm-venv/.
#   3. Installs vllm, fastapi, and uvicorn (GPU if CUDA/ROCm found).
#   4. Logs all steps with [VLLM] prefix.
#
# Usage:
#   bash scripts/bootstrap-vllm.sh
#
# Environment variables respected:
#   TALA_PYTHON_EXE  - override the Python executable (default: auto-detect)
# ==============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$REPO_ROOT/local-inference/vllm-venv"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { echo -e "${CYAN}[VLLM] $1${NC}"; }
log_ok()   { echo -e "${GREEN}[VLLM] OK: $1${NC}"; }
log_warn() { echo -e "${YELLOW}[VLLM] WARN: $1${NC}"; }
log_err()  { echo -e "${RED}[VLLM] ERROR: $1${NC}"; }

# ---------------------------------------------------------------------------
# 1. Locate Python interpreter
# ---------------------------------------------------------------------------

PYTHON_EXE="${TALA_PYTHON_EXE:-}"

if [ -z "$PYTHON_EXE" ]; then
    LOCAL_PYTHON="$REPO_ROOT/local-inference/venv/bin/python"
    if [ -f "$LOCAL_PYTHON" ]; then
        PYTHON_EXE="$LOCAL_PYTHON"
        log_info "Using project-local Python at: $PYTHON_EXE"
    fi
fi

if [ -z "$PYTHON_EXE" ]; then
    if command -v python3 >/dev/null 2>&1; then
        PYTHON_EXE="python3"
        log_info "Using system python3: $(python3 --version 2>&1)"
    elif command -v python >/dev/null 2>&1; then
        PY_VER=$(python --version 2>&1)
        if [[ "$PY_VER" == *"Python 3"* ]]; then
            PYTHON_EXE="python"
            log_info "Using system python: $PY_VER"
        fi
    fi
fi

if [ -z "$PYTHON_EXE" ]; then
    log_err "No Python 3 interpreter found."
    log_err "Install Python 3.10+ from https://python.org/ or set TALA_PYTHON_EXE."
    exit 1
fi

VENV_PYTHON="$VENV_DIR/bin/python"

# ---------------------------------------------------------------------------
# 2. Create virtual environment
# ---------------------------------------------------------------------------

log_info "Setting up vLLM virtual environment at: $VENV_DIR"

if [ ! -d "$VENV_DIR" ]; then
    log_info "Creating virtual environment..."
    "$PYTHON_EXE" -m venv "$VENV_DIR"
fi

log_info "Upgrading pip..."
"$VENV_PYTHON" -m pip install --upgrade pip --quiet || \
    log_warn "pip upgrade failed; continuing with existing pip."

# ---------------------------------------------------------------------------
# 3. Detect GPU availability (CUDA or ROCm)
# ---------------------------------------------------------------------------

HAS_GPU=false
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name --format=csv,noheader >/dev/null 2>&1; then
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
    log_info "CUDA GPU detected: $GPU_NAME"
    HAS_GPU=true
elif command -v rocm-smi >/dev/null 2>&1 && rocm-smi --showproductname >/dev/null 2>&1; then
    log_info "ROCm GPU detected."
    HAS_GPU=true
fi

# ---------------------------------------------------------------------------
# 4. Install vLLM and required dependencies
# ---------------------------------------------------------------------------

log_info "Installing vLLM..."

if [ "$HAS_GPU" = true ]; then
    log_info "GPU mode: installing vLLM with GPU support."
    "$VENV_PYTHON" -m pip install vllm --quiet
else
    log_warn "No GPU detected. Installing vLLM in CPU-only mode."
    log_warn "CPU inference is significantly slower than GPU."
    export VLLM_CPU_ONLY=1
    "$VENV_PYTHON" -m pip install vllm --quiet
fi

log_info "Installing fastapi and uvicorn..."
"$VENV_PYTHON" -m pip install fastapi uvicorn --quiet

# ---------------------------------------------------------------------------
# 5. Verify installation
# ---------------------------------------------------------------------------

log_info "Verifying vLLM installation..."
"$VENV_PYTHON" -c "import vllm; print('[VLLM] vLLM version:', vllm.__version__)"

log_ok "Installation complete."
echo ""
log_info "To start the vLLM server, run:"
log_info "  bash scripts/run-vllm.sh"
echo ""
log_info "Set TALA_VLLM_MODEL to the HuggingFace model ID or local path before launching."
log_info "Example: TALA_VLLM_MODEL=microsoft/phi-2 bash scripts/run-vllm.sh"
