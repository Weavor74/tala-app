<#
.SYNOPSIS
Tala local memory stack bootstrap (Windows PowerShell)

.DESCRIPTION
Pre-flight check for the Tala canonical memory store.
The app manages its own native PostgreSQL runtime via DatabaseBootstrapCoordinator.
Docker is NOT used by this script - the canonical memory path is native-first.

Behavior:
  1. If TALA_DB_CONNECTION_STRING is set, exits 0 - caller has supplied a DB.
  2. Checks whether a local PostgreSQL instance is already reachable.
     If yes, exits 0 - DB is already running.
  3. Checks whether native runtime binary assets are present.
     If yes, exits 0 - the app will start the runtime automatically on launch.
  4. No viable path found - exits 0 with a degraded-mode warning and
     actionable guidance. The app will continue without canonical memory.

Usage:
  .\scripts\bootstrap-memory.ps1

Environment variables respected:
  TALA_DB_CONNECTION_STRING - if set, skip all local provisioning
  TALA_DB_HOST              - override host for reachability check
  TALA_DB_PORT              - override port for reachability check
#>

$ErrorActionPreference = "SilentlyContinue"

# Resolve repo root from this script's location
$ScriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot     = Split-Path -Parent $ScriptDir
$Probe        = Join-Path $ScriptDir "check-db-reachable.js"

# Native runtime binary path (mirrors LocalDatabaseRuntime: APP_ROOT\runtime\postgres\bin\postgres.exe)
$NativeBinary = Join-Path $RepoRoot "runtime\postgres\bin\postgres.exe"

function Log-Info { param($msg) Write-Host "[memory-bootstrap] $msg" -ForegroundColor Cyan }
function Log-Ok   { param($msg) Write-Host "[memory-bootstrap] OK: $msg" -ForegroundColor Green }
function Log-Warn { param($msg) Write-Host "[memory-bootstrap] WARN: $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# 1. If TALA_DB_CONNECTION_STRING is set, skip local provisioning
# ---------------------------------------------------------------------------
if ($env:TALA_DB_CONNECTION_STRING) {
    Log-Ok "TALA_DB_CONNECTION_STRING is set - using provided DB, skipping local bootstrap."
    exit 0
}

Log-Info "Checking local memory availability..."

# ---------------------------------------------------------------------------
# 2. Check whether a local PostgreSQL instance is already reachable
# ---------------------------------------------------------------------------
& node $Probe 2>$null
if ($LASTEXITCODE -eq 0) {
    Log-Ok "Local PostgreSQL is already reachable. No provisioning needed."
    exit 0
}

# ---------------------------------------------------------------------------
# 3. Check whether native runtime binary assets are present.
#    If they are, the app will start PostgreSQL automatically on launch.
# ---------------------------------------------------------------------------
if (Test-Path $NativeBinary) {
    Log-Ok "Native PostgreSQL runtime assets found at: $NativeBinary"
    Log-Info "The app will start the native runtime automatically on launch."
    exit 0
}

# ---------------------------------------------------------------------------
# 4. No viable path - degraded mode. The app will continue without memory.
# ---------------------------------------------------------------------------
Log-Warn "No running PostgreSQL instance found and no native runtime assets present."
Log-Warn "App will start in degraded mode - canonical memory will be unavailable."
Log-Warn ""
Log-Warn "To resolve, choose one of the following:"
Log-Warn "  a) Set TALA_DB_CONNECTION_STRING to connect to an existing PostgreSQL instance."
Log-Warn "  b) Install PostgreSQL and set TALA_DB_HOST / TALA_DB_PORT / TALA_DB_USER / TALA_DB_PASSWORD."
Log-Warn "  c) Place native PostgreSQL runtime assets at: $NativeBinary"
Log-Warn "     See docs/architecture/memory_bootstrap.md for details."
exit 0
