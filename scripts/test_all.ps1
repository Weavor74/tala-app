# Test All Memory Graph Components
Write-Host "--- Running Proof Suite: Memory Graph ---" -ForegroundColor Cyan

$baseDir = "d:\src\client1\tala-app\mcp-servers\tala-memory-graph"

Write-Host "`n[1/3] Running Persistence Tests..." -ForegroundColor Yellow
uv run pytest "$baseDir\tests\test_memory_graph_persistence.py"

Write-Host "`n[2/3] Running Neighborhood Tests..." -ForegroundColor Yellow
uv run pytest "$baseDir\tests\test_memory_graph_neighborhood.py"

Write-Host "`n[3/3] Running Router Identity Tests..." -ForegroundColor Yellow
uv run pytest "$baseDir\tests\test_memory_router_identity.py"

Write-Host "`n--- Proof Suite COMPLETED ---" -ForegroundColor Green
