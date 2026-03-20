<#
.SYNOPSIS
Stop the Tala local memory stack (Windows PowerShell)

.DESCRIPTION
Stops docker-compose.memory.yml.
Pass -Reset to also remove the persistent volume (wipes all memory data).

.PARAMETER Reset
Remove the persistent volume.

.EXAMPLE
.\scripts\stop-memory.ps1
.\scripts\stop-memory.ps1 -Reset
#>

param(
    [switch]$Reset
)

$ErrorActionPreference = "SilentlyContinue"

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot    = Split-Path -Parent $ScriptDir
$ComposeFile = Join-Path $RepoRoot "docker-compose.memory.yml"

function Log-Info { param($msg) Write-Host "[memory-stop] $msg" -ForegroundColor Cyan }
function Log-Ok   { param($msg) Write-Host "[memory-stop] OK: $msg" -ForegroundColor Green }
function Log-Warn { param($msg) Write-Host "[memory-stop] WARN: $msg" -ForegroundColor Yellow }

$dockerExe = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerExe) {
    Log-Warn "Docker not found — nothing to stop."
    exit 0
}

$composeArgs = $null
& docker compose version 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    $composeArgs = @("compose")
} else {
    $dcExe = Get-Command docker-compose -ErrorAction SilentlyContinue
    if (-not $dcExe) {
        Log-Warn "docker compose / docker-compose not found — nothing to stop."
        exit 0
    }
}

if ($Reset) {
    Log-Info "Stopping memory stack and removing persistent volume..."
    if ($composeArgs) {
        & docker @composeArgs -f $ComposeFile down -v
    } else {
        & docker-compose -f $ComposeFile down -v
    }
    Log-Ok "Memory stack stopped and volume removed."
} else {
    Log-Info "Stopping memory stack (data preserved)..."
    if ($composeArgs) {
        & docker @composeArgs -f $ComposeFile down
    } else {
        & docker-compose -f $ComposeFile down
    }
    Log-Ok "Memory stack stopped."
}
