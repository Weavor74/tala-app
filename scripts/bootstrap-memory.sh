#!/usr/bin/env bash
# ===========================================================================
# bootstrap-memory.sh — Tala local memory stack bootstrap (Linux / macOS)
# ===========================================================================
#
# Ensures the local PostgreSQL + pgvector memory store is running before
# the app starts.
#
# Behavior:
#   1. If TALA_DB_CONNECTION_STRING is set, exits 0 immediately — the caller
#      has supplied a DB, nothing to provision.
#   2. Checks whether the default local DB (localhost:5432) is reachable.
#      If yes, exits 0 — DB is already running.
#   3. Verifies Docker and docker compose are available.
#      If not, logs a warning and exits 0 (degraded mode — app will continue
#      without memory).
#   4. Starts docker-compose.memory.yml.
#   5. Waits for the container healthcheck to pass (up to ~60 s).
#   6. Exits 0 on success, or exits 0 with a warning on timeout (degraded).
#
# Usage:
#   bash scripts/bootstrap-memory.sh
#
# Environment variables respected:
#   TALA_DB_CONNECTION_STRING — if set, skip all local provisioning
#   TALA_DB_HOST              — override host for reachability check
#   TALA_DB_PORT              — override port for reachability check
# ===========================================================================

set -euo pipefail

# Resolve repo root from this script's location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.memory.yml"

# Color helpers
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[memory-bootstrap]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[memory-bootstrap] OK:${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[memory-bootstrap] WARN:${NC} $*"; }
log_error() { echo -e "${RED}[memory-bootstrap] ERROR:${NC} $*"; }

# ---------------------------------------------------------------------------
# 1. If TALA_DB_CONNECTION_STRING is set, skip local provisioning
# ---------------------------------------------------------------------------
if [ -n "${TALA_DB_CONNECTION_STRING:-}" ]; then
  log_ok "TALA_DB_CONNECTION_STRING is set — using provided DB, skipping local bootstrap."
  exit 0
fi

log_info "Starting local memory bootstrap..."

# ---------------------------------------------------------------------------
# 2. Check whether the default local DB is already reachable
# ---------------------------------------------------------------------------
PROBE="$SCRIPT_DIR/check-db-reachable.js"
if node "$PROBE" 2>/dev/null; then
  log_ok "Local PostgreSQL is already reachable. No provisioning needed."
  exit 0
fi

log_info "Local PostgreSQL not reachable. Attempting Docker bootstrap..."

# ---------------------------------------------------------------------------
# 3. Verify Docker is available
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log_warn "Docker is not installed or not in PATH."
  log_warn "Memory store will be unavailable — app will run in degraded mode."
  exit 0
fi

# Detect docker compose invocation (plugin vs standalone)
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  log_warn "docker compose / docker-compose not found."
  log_warn "Memory store will be unavailable — app will run in degraded mode."
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  log_warn "Docker daemon is not running."
  log_warn "Memory store will be unavailable — app will run in degraded mode."
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. Start the memory stack
# ---------------------------------------------------------------------------
log_info "Starting memory stack: $COMPOSE_FILE"
$COMPOSE_CMD -f "$COMPOSE_FILE" up -d --remove-orphans

# ---------------------------------------------------------------------------
# 5. Wait for healthcheck (up to ~60 s)
# ---------------------------------------------------------------------------
log_info "Waiting for tala-memory-db to become healthy..."
MAX_WAIT=60
ELAPSED=0
INTERVAL=3

while [ $ELAPSED -lt $MAX_WAIT ]; do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' tala-memory-db 2>/dev/null || echo "missing")

  if [ "$STATUS" = "healthy" ]; then
    log_ok "tala-memory-db is healthy and ready."
    exit 0
  fi

  if [ "$STATUS" = "missing" ]; then
    # Container hasn't started yet — also check plain TCP
    if node "$PROBE" 2>/dev/null; then
      log_ok "PostgreSQL is reachable."
      exit 0
    fi
  fi

  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
  log_info "Waiting... ($ELAPSED/${MAX_WAIT}s, status: $STATUS)"
done

# ---------------------------------------------------------------------------
# 6. Timeout — degraded mode, do not crash the app
# ---------------------------------------------------------------------------
log_warn "Memory stack did not become healthy within ${MAX_WAIT}s."
log_warn "App will start in degraded mode. Run 'npm run memory:logs' to diagnose."
exit 0
