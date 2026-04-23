#!/usr/bin/env bash
# ===========================================================================
# setup-mcp-venvs.sh — Tala MCP server Python environment setup (Linux / macOS)
# ===========================================================================
#
# Creates or refreshes the Python virtual environment for each MCP server
# that ships with a requirements.txt.  Idempotent — safe to re-run.
#
# This script restores the Python environments required by the optional
# subsystems listed below.  All subsystems remain optional: Tala will start
# in degraded mode if a venv is missing, but will run fully when all venvs
# are present.
#
# Subsystem → MCP server mapping:
#   Astro Engine      → mcp-servers/astro-engine
#   mem0 memory layer → mcp-servers/mem0-core       (also needs Ollama — see advisory)
#   RAG / retrieval   → mcp-servers/tala-core
#   Memory graph      → mcp-servers/tala-memory-graph (also needs PostgreSQL)
#   Local inference   → local-inference              (llama.cpp — optional)
#
# External dependencies NOT handled by this script:
#   Ollama (required by mem0-core):
#     Install: https://ollama.com/download
#     Then:    ollama pull nomic-embed-text:latest
#              ollama pull huihui_ai/qwen3-abliterated:8b
#
#   PostgreSQL (required by tala-memory-graph, canonical memory, notebooks):
#     Run:     bash scripts/bootstrap-memory.sh
#
# Usage:
#   bash scripts/setup-mcp-venvs.sh
#
# Exit code:
#   0 — all venvs created/refreshed successfully (or skipped with warnings)
#   1 — one or more venvs failed to install
#
# Environment variables:
#   PYTHON_CMD — override the Python executable
#   TALA_ALLOW_SYSTEM_PYTHON=1 — permit fallback to system python when no local runtime exists
# ===========================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Color helpers
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[setup-venvs]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[setup-venvs] OK:${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[setup-venvs] WARN:${NC} $*"; }
log_error() { echo -e "${RED}[setup-venvs] ERROR:${NC} $*"; }

echo ""
echo -e "${CYAN}====================================================${NC}"
echo -e "${CYAN}   Tala MCP Server venv Setup (Linux / macOS)       ${NC}"
echo -e "${CYAN}====================================================${NC}"
echo ""

# ---------------------------------------------------------------------------
# Locate Python 3
# ---------------------------------------------------------------------------
if [ -n "${PYTHON_CMD:-}" ]; then
    log_info "Using PYTHON_CMD override: $PYTHON_CMD"
else
    PLATFORM="$(uname -s)"
    LOCAL_CANDIDATES=(
        "$REPO_ROOT/bin/python-linux/bin/python3"
        "$REPO_ROOT/bin/python-mac/bin/python3"
        "$REPO_ROOT/bin/python-portable/python"
    )
    if [ "$PLATFORM" = "Darwin" ]; then
        LOCAL_CANDIDATES=(
            "$REPO_ROOT/bin/python-mac/bin/python3"
            "$REPO_ROOT/bin/python-portable/python"
            "$REPO_ROOT/bin/python-linux/bin/python3"
        )
    fi

    for candidate in "${LOCAL_CANDIDATES[@]}"; do
        if [ -f "$candidate" ]; then
            PYTHON_CMD="$candidate"
            log_info "Using project-local Python: $PYTHON_CMD"
            break
        fi
    done

    if [ -z "${PYTHON_CMD:-}" ] && [ "${TALA_ALLOW_SYSTEM_PYTHON:-0}" = "1" ]; then
        if command -v python3 >/dev/null 2>&1; then
            PYTHON_CMD="python3"
            log_warn "Using system python3 because TALA_ALLOW_SYSTEM_PYTHON=1"
        elif command -v python >/dev/null 2>&1 && python --version 2>&1 | grep -q "Python 3"; then
            PYTHON_CMD="python"
            log_warn "Using system python because TALA_ALLOW_SYSTEM_PYTHON=1"
        fi
    fi
fi

if [ -z "${PYTHON_CMD:-}" ]; then
    log_error "No project-local Python interpreter found."
    log_error "Expected one of:"
    log_error "  - bin/python-linux/bin/python3"
    log_error "  - bin/python-mac/bin/python3"
    log_error "  - bin/python-portable/python"
    log_error "Set PYTHON_CMD to a local interpreter, or set TALA_ALLOW_SYSTEM_PYTHON=1 to opt into system Python."
    exit 1
fi

if ! "$PYTHON_CMD" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >/dev/null 2>&1; then
    log_error "Python 3.10+ required. Selected interpreter: $PYTHON_CMD"
    exit 1
fi

PY_VER=$("$PYTHON_CMD" --version 2>&1)
log_info "Python: $PY_VER (cmd: $PYTHON_CMD)"
echo ""

# ---------------------------------------------------------------------------
# MCP module list (relative to repo root)
# Only directories with a requirements.txt are processed.
# ---------------------------------------------------------------------------
MCP_MODULES=(
    "mcp-servers/tala-core"
    "mcp-servers/astro-engine"
    "mcp-servers/mem0-core"
    "mcp-servers/tala-memory-graph"
    "local-inference"
)

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

for MOD in "${MCP_MODULES[@]}"; do
    MOD_PATH="$REPO_ROOT/$MOD"
    VENV_PATH="$MOD_PATH/venv"
    REQ_FILE="$MOD_PATH/requirements.txt"

    echo -e "${YELLOW}[$MOD]${NC}"

    if [ ! -d "$MOD_PATH" ]; then
        log_warn "$MOD — directory not found, skipping."
        SKIP_COUNT=$((SKIP_COUNT + 1))
        echo ""
        continue
    fi

    if [ ! -f "$REQ_FILE" ]; then
        log_warn "$MOD — no requirements.txt found, skipping."
        SKIP_COUNT=$((SKIP_COUNT + 1))
        echo ""
        continue
    fi

    if [ ! -d "$VENV_PATH" ]; then
        log_info "  Creating venv at $VENV_PATH"
        if ! "$PYTHON_CMD" -m venv "$VENV_PATH"; then
            log_error "  Failed to create venv for $MOD"
            FAIL_COUNT=$((FAIL_COUNT + 1))
            echo ""
            continue
        fi
    else
        log_info "  Venv already exists — refreshing dependencies"
    fi

    VENV_PYTHON="$VENV_PATH/bin/python"

    # Upgrade pip quietly (non-fatal — old pip still works)
    "$VENV_PYTHON" -m pip install --quiet --upgrade pip 2>/dev/null || true

    if "$VENV_PYTHON" -m pip install --quiet -r "$REQ_FILE"; then
        log_ok "$MOD venv ready"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        log_error "  pip install failed for $MOD — check output above"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi

    echo ""
done

# ---------------------------------------------------------------------------
# Advisory: external dependencies not managed by this script
# ---------------------------------------------------------------------------
echo -e "${CYAN}====================================================${NC}"
echo -e "${CYAN}   External dependency advisories                   ${NC}"
echo -e "${CYAN}====================================================${NC}"
echo ""
log_info "mem0-core requires Ollama with two models:"
log_info "  Install: https://ollama.com/download"
log_info "  Then run:"
log_info "    ollama pull nomic-embed-text:latest           # text embedder for semantic memory search"
log_info "    ollama pull huihui_ai/qwen3-abliterated:8b    # LLM used by mem0 to extract and reason about memories (~8 GB RAM)"
echo ""
log_info "tala-memory-graph and notebook persistence require PostgreSQL:"
log_info "  Run:  bash scripts/bootstrap-memory.sh"
echo ""

# Optional: report current Ollama status
if command -v ollama >/dev/null 2>&1; then
    log_ok "Ollama is installed: $(ollama --version 2>/dev/null || echo 'version unknown')"
    if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
        log_ok "Ollama daemon is reachable at http://localhost:11434"
    else
        log_warn "Ollama is installed but daemon does not appear to be running."
        log_warn "Start with: ollama serve"
    fi
else
    log_warn "Ollama not found in PATH — required by mem0-core."
fi

echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo -e "${CYAN}====================================================${NC}"
log_info "  Results: ${PASS_COUNT} ready   ${SKIP_COUNT} skipped   ${FAIL_COUNT} failed"
echo -e "${CYAN}====================================================${NC}"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
    log_error "One or more venvs failed to install. Review the output above."
    exit 1
fi

log_ok "MCP venv setup complete. Run 'bash scripts/verify-setup.sh' to confirm."
exit 0
