<#
.SYNOPSIS
Tala MCP server Python environment setup (Windows PowerShell)

.DESCRIPTION
Creates or refreshes the Python virtual environment for each MCP server
that ships with a requirements.txt.  Idempotent — safe to re-run.

This script restores the Python environments required by the optional
subsystems listed below.  All subsystems remain optional: Tala will start
in degraded mode if a venv is missing, but will run fully when all venvs
are present.

Subsystem → MCP server mapping:
  Astro Engine      → mcp-servers\astro-engine
  mem0 memory layer → mcp-servers\mem0-core       (also needs Ollama — see advisory)
  RAG / retrieval   → mcp-servers\tala-core
  Memory graph      → mcp-servers\tala-memory-graph (also needs PostgreSQL)
  Local inference   → local-inference              (llama.cpp — optional)

External dependencies NOT handled by this script:
  Ollama (required by mem0-core):
    Install: https://ollama.com/download
    Then:    ollama pull nomic-embed-text:latest
             ollama pull huihui_ai/qwen3-abliterated:8b

  PostgreSQL (required by tala-memory-graph, canonical memory, notebooks):
    Run:     .\scripts\bootstrap-memory.ps1

.NOTES
Usage: pwsh scripts\setup-mcp-venvs.ps1
Safe to run from any directory — paths resolve from this script's location.

Exit code:
  0 — all venvs created/refreshed successfully (or skipped with warnings)
  1 — one or more venvs failed to install
#>

param(
    # Override the Python executable (default: auto-detected python/python3)
    [string]$PythonCmd = ""
)

# Resolve repo root from this script's location
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot  = Split-Path -Parent $ScriptDir

function Log-Info  { param($msg) Write-Host "[setup-venvs] $msg"        -ForegroundColor Cyan }
function Log-Ok    { param($msg) Write-Host "[setup-venvs] OK: $msg"    -ForegroundColor Green }
function Log-Warn  { param($msg) Write-Host "[setup-venvs] WARN: $msg"  -ForegroundColor Yellow }
function Log-Error { param($msg) Write-Host "[setup-venvs] ERROR: $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "   Tala MCP Server venv Setup (Windows)            " -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------------------
# Locate Python 3
# ---------------------------------------------------------------------------
if (-not $PythonCmd) {
    $candidates = @("python", "python3", "py")
    foreach ($cand in $candidates) {
        if (-not (Get-Command $cand -ErrorAction SilentlyContinue)) { continue }
        $ver = & $cand --version 2>&1
        if ($LASTEXITCODE -eq 0 -and ($ver -match "Python 3")) {
            $PythonCmd = $cand
            break
        }
    }
}

if (-not $PythonCmd) {
    Log-Error "Python 3 not found in PATH. Install Python 3 and re-run."
    exit 1
}

$pyVer = & $PythonCmd --version 2>&1
Log-Info "Python: $pyVer (cmd: $PythonCmd)"
Write-Host ""

# ---------------------------------------------------------------------------
# MCP module list (relative to repo root)
# Only directories with a requirements.txt are processed.
# ---------------------------------------------------------------------------
$McpModules = @(
    "mcp-servers\tala-core",
    "mcp-servers\astro-engine",
    "mcp-servers\mem0-core",
    "mcp-servers\tala-memory-graph",
    "local-inference"
)

$PassCount = 0
$FailCount = 0
$SkipCount = 0

foreach ($Mod in $McpModules) {
    $ModPath  = Join-Path $RepoRoot $Mod
    $VenvPath = Join-Path $ModPath  "venv"
    $ReqFile  = Join-Path $ModPath  "requirements.txt"

    Write-Host "[$Mod]" -ForegroundColor Yellow

    if (-not (Test-Path $ModPath)) {
        Log-Warn "$Mod — directory not found, skipping."
        $SkipCount++
        Write-Host ""
        continue
    }

    if (-not (Test-Path $ReqFile)) {
        Log-Warn "$Mod — no requirements.txt found, skipping."
        $SkipCount++
        Write-Host ""
        continue
    }

    $VenvPython = Join-Path $VenvPath "Scripts\python.exe"

    if (-not (Test-Path $VenvPath)) {
        Log-Info "  Creating venv at $VenvPath"
        & $PythonCmd -m venv $VenvPath 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Log-Error "  Failed to create venv for $Mod"
            $FailCount++
            Write-Host ""
            continue
        }
    } else {
        Log-Info "  Venv already exists — refreshing dependencies"
    }

    $VenvPip = Join-Path $VenvPath "Scripts\pip.exe"

    # Upgrade pip quietly (non-fatal — old pip still works)
    & $VenvPip install --quiet --upgrade pip 2>&1 | Out-Null

    & $VenvPip install --quiet -r $ReqFile 2>&1
    if ($LASTEXITCODE -eq 0) {
        Log-Ok "$Mod venv ready"
        $PassCount++
    } else {
        Log-Error "  pip install failed for $Mod — check output above"
        $FailCount++
    }

    Write-Host ""
}

# ---------------------------------------------------------------------------
# Advisory: external dependencies not managed by this script
# ---------------------------------------------------------------------------
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "   External dependency advisories                   " -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host ""
Log-Info "mem0-core requires Ollama with two models:"
Log-Info "  Install: https://ollama.com/download"
Log-Info "  Then run:"
Log-Info "    ollama pull nomic-embed-text:latest           # text embedder for semantic memory search"
Log-Info "    ollama pull huihui_ai/qwen3-abliterated:8b    # LLM used by mem0 to extract and reason about memories (~8 GB RAM)"
Write-Host ""
Log-Info "tala-memory-graph and notebook persistence require PostgreSQL:"
Log-Info "  Run:  .\scripts\bootstrap-memory.ps1"
Write-Host ""

# Optional: report current Ollama status
$ollamaExe = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollamaExe) {
    $ollamaVer = & ollama --version 2>&1
    Log-Ok "Ollama is installed: $ollamaVer"

    # Quick HTTP probe to check if the daemon is running
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" `
                                      -TimeoutSec 3 `
                                      -UseBasicParsing `
                                      -ErrorAction Stop 2>$null
        Log-Ok "Ollama daemon is reachable at http://localhost:11434"
    } catch {
        Log-Warn "Ollama is installed but daemon does not appear to be running."
        Log-Warn "Start with: ollama serve"
    }
} else {
    Log-Warn "Ollama not found in PATH — required by mem0-core."
}

Write-Host ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host "====================================================" -ForegroundColor Cyan
Log-Info "  Results: $PassCount ready   $SkipCount skipped   $FailCount failed"
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host ""

if ($FailCount -gt 0) {
    Log-Error "One or more venvs failed to install. Review the output above."
    exit 1
}

Log-Ok "MCP venv setup complete. Run 'pwsh scripts\verify-setup.ps1' to confirm."
exit 0
