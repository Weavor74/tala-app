<#
.SYNOPSIS
Tala local memory stack bootstrap (Windows PowerShell)

.DESCRIPTION
Ensures the local PostgreSQL + pgvector memory store is running before
the app starts.

Behavior:
  1. If TALA_DB_CONNECTION_STRING is set, exits successfully — the caller
     has supplied a DB, nothing to provision.
  2. Checks whether the default local DB (localhost:5432) is reachable.
     If yes, exits successfully.
  3. Verifies Docker and docker compose are available.
     If not, logs a warning and exits 0 (degraded mode).
  4. Starts docker-compose.memory.yml.
  5. Waits for the container healthcheck to pass (up to ~60 s).
  6. Exits 0 on success, or exits 0 with a warning on timeout (degraded).

Usage:
  .\scripts\bootstrap-memory.ps1

Environment variables respected:
  TALA_DB_CONNECTION_STRING — if set, skip all local provisioning
  TALA_DB_HOST              — override host for reachability check
  TALA_DB_PORT              — override port for reachability check
#>

$ErrorActionPreference = "SilentlyContinue"

# Resolve repo root from this script's location
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot   = Split-Path -Parent $ScriptDir
$ComposeFile = Join-Path $RepoRoot "docker-compose.memory.yml"
$Probe       = Join-Path $ScriptDir "check-db-reachable.js"

function Log-Info  { param($msg) Write-Host "[memory-bootstrap] $msg" -ForegroundColor Cyan }
function Log-Ok    { param($msg) Write-Host "[memory-bootstrap] OK: $msg" -ForegroundColor Green }
function Log-Warn  { param($msg) Write-Host "[memory-bootstrap] WARN: $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# 1. If TALA_DB_CONNECTION_STRING is set, skip local provisioning
# ---------------------------------------------------------------------------
if ($env:TALA_DB_CONNECTION_STRING) {
    Log-Ok "TALA_DB_CONNECTION_STRING is set — using provided DB, skipping local bootstrap."
    exit 0
}

Log-Info "Starting local memory bootstrap..."

# ---------------------------------------------------------------------------
# 2. Check whether the default local DB is already reachable
# ---------------------------------------------------------------------------
& node $Probe 2>$null
if ($LASTEXITCODE -eq 0) {
    Log-Ok "Local PostgreSQL is already reachable. No provisioning needed."
    exit 0
}

Log-Info "Local PostgreSQL not reachable. Attempting Docker bootstrap..."

# ---------------------------------------------------------------------------
# 3. Verify Docker is available
# ---------------------------------------------------------------------------
$dockerExe = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerExe) {
    Log-Warn "Docker is not installed or not in PATH."
    Log-Warn "Memory store will be unavailable — app will run in degraded mode."
    exit 0
}

# Detect docker compose (plugin vs standalone)
$composeArgs = $null
& docker compose version 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    $composeArgs = @("compose")
} else {
    $dcExe = Get-Command docker-compose -ErrorAction SilentlyContinue
    if ($dcExe) {
        $composeArgs = $null  # will call docker-compose directly
    } else {
        Log-Warn "docker compose / docker-compose not found."
        Log-Warn "Memory store will be unavailable — app will run in degraded mode."
        exit 0
    }
}

& docker info 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Log-Warn "Docker daemon is not running."
    Log-Warn "Memory store will be unavailable — app will run in degraded mode."
    exit 0
}

# ---------------------------------------------------------------------------
# 4. Start the memory stack
# ---------------------------------------------------------------------------
Log-Info "Starting memory stack: $ComposeFile"

if ($composeArgs) {
    & docker @composeArgs -f $ComposeFile up -d --remove-orphans
} else {
    & docker-compose -f $ComposeFile up -d --remove-orphans
}

# ---------------------------------------------------------------------------
# 5. Wait for healthcheck (up to ~60 s)
# ---------------------------------------------------------------------------
Log-Info "Waiting for tala-memory-db to become healthy..."
$MaxWait  = 60
$Elapsed  = 0
$Interval = 3

while ($Elapsed -lt $MaxWait) {
    $status = & docker inspect --format="{{.State.Health.Status}}" tala-memory-db 2>$null
    if (-not $status) { $status = "missing" }

    if ($status -eq "healthy") {
        Log-Ok "tala-memory-db is healthy and ready."
        exit 0
    }

    if ($status -eq "missing") {
        & node $Probe 2>$null
        if ($LASTEXITCODE -eq 0) {
            Log-Ok "PostgreSQL is reachable."
            exit 0
        }
    }

    Start-Sleep -Seconds $Interval
    $Elapsed += $Interval
    Log-Info "Waiting... ($Elapsed/${MaxWait}s, status: $status)"
}

# ---------------------------------------------------------------------------
# 6. Timeout — degraded mode, do not crash the app
# ---------------------------------------------------------------------------
Log-Warn "Memory stack did not become healthy within ${MaxWait}s."
Log-Warn "App will start in degraded mode. Run 'npm run memory:logs' to diagnose."
exit 0
