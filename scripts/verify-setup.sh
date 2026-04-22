#!/usr/bin/env bash
# ============================================================
# TALA Bootstrap Verification / Health Check — Unix/Mac
# ============================================================
# Usage: bash scripts/verify-setup.sh
# Safe to run from any directory — paths resolve relative to this script.
#
# Exit code:
#   0  = all critical checks passed
#   1  = one or more critical checks failed

# Resolve repo root from this script (scripts/ -> repo root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# --- color helpers ---
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

pass() { echo -e "  ${GREEN}[PASS]${NC} $1"; PASS_COUNT=$((PASS_COUNT+1)); }
fail() { echo -e "  ${RED}[FAIL]${NC} $1"; FAIL_COUNT=$((FAIL_COUNT+1)); }
warn() { echo -e "  ${YELLOW}[WARN]${NC} $1"; WARN_COUNT=$((WARN_COUNT+1)); }

echo -e "${CYAN}=============================================${NC}"
echo -e "${CYAN}   TALA Environment Readiness Check          ${NC}"
echo -e "${CYAN}=============================================${NC}"
echo -e "   Repo root: ${REPO_ROOT}"
echo ""

# -------------------------------------------------------
# 1. Repo root sanity
# -------------------------------------------------------
echo -e "${YELLOW}[1] Repo root${NC}"
if [ -f "$REPO_ROOT/package.json" ]; then
    pass "package.json found at $REPO_ROOT"
else
    fail "package.json not found — repo root may be wrong (got $REPO_ROOT)"
fi

# -------------------------------------------------------
# 2. Node.js
# -------------------------------------------------------
echo -e "${YELLOW}[2] Node.js${NC}"
if command -v node >/dev/null 2>&1; then
    NODE_VER=$(node --version)
    pass "node $NODE_VER"
else
    fail "Node.js not found in PATH — install from https://nodejs.org/"
fi

if command -v npm >/dev/null 2>&1; then
    NPM_VER=$(npm --version)
    pass "npm $NPM_VER"
else
    fail "npm not found in PATH"
fi

# -------------------------------------------------------
# 3. node_modules
# -------------------------------------------------------
echo -e "${YELLOW}[3] Node modules${NC}"
if [ -d "$REPO_ROOT/node_modules" ]; then
    pass "node_modules present"
else
    fail "node_modules not found — run: bash bootstrap.sh"
fi

# -------------------------------------------------------
# 4. Python
# -------------------------------------------------------
echo -e "${YELLOW}[4] Python${NC}"
PYTHON_CMD=""
if command -v python3 >/dev/null 2>&1; then
    PYTHON_CMD="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_CMD="python"
fi

if [ -n "$PYTHON_CMD" ]; then
    PY_VER=$($PYTHON_CMD --version 2>&1)
    if [[ "$PY_VER" == *"Python 3"* ]]; then
        pass "$PY_VER (cmd: $PYTHON_CMD)"
    else
        fail "Python 3 required, found: $PY_VER"
    fi
else
    fail "Python not found in PATH — install from https://python.org/"
fi

# -------------------------------------------------------
# 5. Linux native/runtime prerequisites
# -------------------------------------------------------
if [ "$(uname -s)" = "Linux" ]; then
    echo -e "${YELLOW}[5] Linux native/runtime prerequisites${NC}"

    for TOOL in gcc g++ make pkg-config cmake; do
        if command -v "$TOOL" >/dev/null 2>&1; then
            pass "$TOOL present"
        else
            fail "$TOOL missing - install build-essential/cmake/pkg-config"
        fi
    done

    if command -v pg_config >/dev/null 2>&1; then
        pass "pg_config present (libpq-dev)"
    else
        fail "pg_config missing - install libpq-dev"
    fi

    if command -v ldconfig >/dev/null 2>&1; then
        LINUX_SONAMES=(
            libgtk-3.so.0
            libnss3.so
            libgbm.so.1
            libasound.so.2
            libcups.so.2
            libx11-xcb.so.1
            libxshmfence.so.1
        )
        for SONAME in "${LINUX_SONAMES[@]}"; do
            if ldconfig -p 2>/dev/null | grep -q "$SONAME"; then
                pass "$SONAME available"
            else
                fail "$SONAME missing - install Linux Electron runtime libraries"
            fi
        done
    else
        warn "ldconfig unavailable - skipped shared library checks"
    fi
fi
# -------------------------------------------------------
# 5. Python venvs
# -------------------------------------------------------
echo -e "${YELLOW}[6] Python virtual environments${NC}"
PYTHON_MODULES=(
    "local-inference"
    "mcp-servers/tala-core"
    "mcp-servers/mem0-core"
    "mcp-servers/astro-engine"
    "mcp-servers/tala-memory-graph"
    "mcp-servers/world-engine"
)
for MOD in "${PYTHON_MODULES[@]}"; do
    MOD_PATH="$REPO_ROOT/$MOD"
    VENV_PYTHON="$MOD_PATH/venv/bin/python"
    REQ_FILE="$MOD_PATH/requirements.txt"
    if [ ! -d "$MOD_PATH" ]; then
        warn "$MOD — directory not found (optional)"
    elif [ ! -f "$REQ_FILE" ]; then
        warn "$MOD — no requirements.txt"
    elif [ -f "$VENV_PYTHON" ]; then
        pass "$MOD venv ready"
    else
        fail "$MOD venv missing — run: bash bootstrap.sh"
    fi
done

# -------------------------------------------------------
# 6. llama.cpp / local inference
# -------------------------------------------------------
echo -e "${YELLOW}[7] Local inference (llama.cpp / llama-cpp-python)${NC}"

# Check for bundled Python runtimes used by launch-inference.sh
BUNDLED_PYTHON_FOUND=false
for BIN_PYTHON in \
    "bin/python-mac/bin/python3" \
    "bin/python-linux/bin/python3" \
    "bin/python-portable/bin/python3" \
    "local-inference/venv/bin/python"
do
    if [ -f "$REPO_ROOT/$BIN_PYTHON" ]; then
        BUNDLED_PYTHON_FOUND=true
        pass "Inference Python binary: $BIN_PYTHON"
        break
    fi
done
if [ "$BUNDLED_PYTHON_FOUND" = false ]; then
    warn "No bundled Python runtime found for local inference"
    warn "Expected at bin/python-mac|linux/ or local-inference/venv/bin/python"
    warn "Run bootstrap.sh to create the venv, or provision a bundled runtime."
fi

# Check for at least one GGUF model
MODEL=$(ls "$REPO_ROOT/models"/*.gguf 2>/dev/null | head -1)
if [ -n "$MODEL" ]; then
    MODEL_NAME=$(basename "$MODEL")
    pass "GGUF model: $MODEL_NAME"
else
    warn "No .gguf model found in models/ — run bootstrap.sh to download one"
fi

# Check local-inference launch script
if [ -f "$REPO_ROOT/scripts/diagnostics/launch-inference.sh" ]; then
    pass "launch-inference.sh present"
else
    fail "launch-inference.sh not found"
fi

# -------------------------------------------------------
# 7. Key config / source files
# -------------------------------------------------------
echo -e "${YELLOW}[8] Key project files${NC}"
KEY_FILES=(
    "package.json"
    "tsconfig.json"
    "vite.config.ts"
    "electron/main.ts"
)
for F in "${KEY_FILES[@]}"; do
    if [ -f "$REPO_ROOT/$F" ]; then
        pass "$F"
    else
        fail "$F not found"
    fi
done

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
echo ""
echo -e "${CYAN}=============================================${NC}"
echo -e "  Results: ${GREEN}${PASS_COUNT} passed${NC}  ${YELLOW}${WARN_COUNT} warnings${NC}  ${RED}${FAIL_COUNT} failed${NC}"
echo -e "${CYAN}=============================================${NC}"

if [ "$FAIL_COUNT" -gt 0 ]; then
    echo -e "${RED}[FAIL] Environment is NOT ready. Address the failures above.${NC}"
    exit 1
else
    echo -e "${GREEN}[OK] Environment looks ready.${NC}"
    exit 0
fi

