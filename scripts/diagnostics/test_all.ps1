# Test All Memory Graph Components
# Paths resolve relative to this script's location (scripts\diagnostics\).
# Repo root is two levels up.
Write-Host "--- Running Proof Suite: Memory Graph ---" -ForegroundColor Cyan

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$baseDir  = Join-Path $RepoRoot "mcp-servers\tala-memory-graph"

if (-not (Test-Path $baseDir)) {
    Write-Host "[ERROR] mcp-servers\tala-memory-graph not found at: $baseDir" -ForegroundColor Red
    exit 1
}

Write-Host "`n[1/3] Running Persistence Tests..." -ForegroundColor Yellow
uv run pytest "$baseDir\tests\test_memory_graph_persistence.py"

Write-Host "`n[2/3] Running Neighborhood Tests..." -ForegroundColor Yellow
uv run pytest "$baseDir\tests\test_memory_graph_neighborhood.py"

Write-Host "`n[3/3] Running Router Identity Tests..." -ForegroundColor Yellow
uv run pytest "$baseDir\tests\test_memory_router_identity.py"

Write-Host "`n--- Proof Suite COMPLETED ---" -ForegroundColor Green
