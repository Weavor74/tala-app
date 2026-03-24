#!/usr/bin/env bash
# ===========================================================================
# bootstrap-memory.sh — Tala local memory stack bootstrap (Linux / macOS)
# ===========================================================================
#
# Pre-flight check for the Tala canonical memory store.
# The app manages its own native PostgreSQL runtime via DatabaseBootstrapCoordinator.
# Docker is NOT used by this script — the canonical memory path is native-first.
#
# Behavior:
#   1. If TALA_DB_CONNECTION_STRING is set, exits 0 — caller has supplied a DB.
#   2. Checks whether a local PostgreSQL instance is already reachable.
#      If yes, exits 0 — DB is already running.
#   3. Checks whether native runtime binary assets are present.
#      If yes, exits 0 — the app will start the runtime automatically on launch.
#   4. No viable path found — exits 0 with a degraded-mode warning and
#      actionable guidance. The app will continue without canonical memory.
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

# Native runtime binary path (mirrors LocalDatabaseRuntime: APP_ROOT/runtime/postgres/bin/postgres)
NATIVE_BINARY="$REPO_ROOT/runtime/postgres/bin/postgres"

# Color helpers
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_info() { echo -e "${CYAN}[memory-bootstrap]${NC} $*"; }
log_ok()   { echo -e "${GREEN}[memory-bootstrap] OK:${NC} $*"; }
log_warn() { echo -e "${YELLOW}[memory-bootstrap] WARN:${NC} $*"; }

# ---------------------------------------------------------------------------
# 1. If TALA_DB_CONNECTION_STRING is set, skip local provisioning
# ---------------------------------------------------------------------------
if [ -n "${TALA_DB_CONNECTION_STRING:-}" ]; then
  log_ok "TALA_DB_CONNECTION_STRING is set — using provided DB, skipping local bootstrap."
  exit 0
fi

log_info "Checking local memory availability..."

# ---------------------------------------------------------------------------
# 2. Check whether a local PostgreSQL instance is already reachable
# ---------------------------------------------------------------------------
PROBE="$SCRIPT_DIR/check-db-reachable.js"
if node "$PROBE" 2>/dev/null; then
  log_ok "Local PostgreSQL is already reachable. No provisioning needed."
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Check whether native runtime binary assets are present.
#    If they are, the app will start PostgreSQL automatically on launch.
# ---------------------------------------------------------------------------
if [ -f "$NATIVE_BINARY" ]; then
  log_ok "Native PostgreSQL runtime assets found at: $NATIVE_BINARY"
  log_info "The app will start the native runtime automatically on launch."
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. No viable path — degraded mode. The app will continue without memory.
# ---------------------------------------------------------------------------
log_warn "No running PostgreSQL instance found and no native runtime assets present."
log_warn "App will start in degraded mode — canonical memory will be unavailable."
log_warn ""
log_warn "To resolve, choose one of the following:"
log_warn "  a) Set TALA_DB_CONNECTION_STRING to connect to an existing PostgreSQL instance."
log_warn "  b) Install PostgreSQL and set TALA_DB_HOST / TALA_DB_PORT / TALA_DB_USER / TALA_DB_PASSWORD."
log_warn "  c) Place native PostgreSQL runtime assets at: $NATIVE_BINARY"
log_warn "     See docs/architecture/memory_bootstrap.md for details."
exit 0
