#!/usr/bin/env bash
# ===========================================================================
# stop-memory.sh — Stop the Tala local memory stack (Linux / macOS)
# ===========================================================================
#
# Usage:
#   bash scripts/stop-memory.sh
#
# Optional flag:
#   --reset   Remove the persistent volume (wipes all memory data)
# ===========================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.memory.yml"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_info() { echo -e "${CYAN}[memory-stop]${NC} $*"; }
log_ok()   { echo -e "${GREEN}[memory-stop] OK:${NC} $*"; }
log_warn() { echo -e "${YELLOW}[memory-stop] WARN:${NC} $*"; }

RESET_VOLUME=false
for arg in "$@"; do
  case "$arg" in
    --reset) RESET_VOLUME=true ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  log_warn "Docker not found — nothing to stop."
  exit 0
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  log_warn "docker compose / docker-compose not found — nothing to stop."
  exit 0
fi

if [ "$RESET_VOLUME" = true ]; then
  log_info "Stopping memory stack and removing persistent volume..."
  $COMPOSE_CMD -f "$COMPOSE_FILE" down -v
  log_ok "Memory stack stopped and volume removed."
else
  log_info "Stopping memory stack (data preserved)..."
  $COMPOSE_CMD -f "$COMPOSE_FILE" down
  log_ok "Memory stack stopped."
fi
