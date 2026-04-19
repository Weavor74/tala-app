#!/bin/bash
set -euo pipefail

# ============================================================
# TALA INFERENCE LAUNCHER - macOS / Linux
# ============================================================
# Canonical local launcher for dev/diagnostics.
# Active local doctrine: ollama + embedded_vllm.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

VLLM_PORT="${TALA_VLLM_PORT:-8000}"

echo
echo "[INFO] Tala local inference launcher (provider=embedded_vllm)"
echo "[INFO] Repo root: $REPO_ROOT"
echo "[INFO] Target port: $VLLM_PORT"
echo

if nc -z 127.0.0.1 "$VLLM_PORT" >/dev/null 2>&1; then
    echo "[INFO] Embedded vLLM already reachable on port $VLLM_PORT."
    echo "[INFO] Entering standby loop so dev process topology remains stable."
    while true; do
        sleep 60
    done
fi

VLLM_LAUNCHER="scripts/run-vllm.sh"
if [[ ! -f "$VLLM_LAUNCHER" ]]; then
    echo "[ERROR] Embedded vLLM launcher not found: $VLLM_LAUNCHER"
    exit 1
fi

echo "[INFO] Starting embedded vLLM via $VLLM_LAUNCHER ..."
exec bash "$VLLM_LAUNCHER"
