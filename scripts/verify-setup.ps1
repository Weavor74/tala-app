<#
.SYNOPSIS
TALA Bootstrap Verification / Health Check --- Windows PowerShell

.DESCRIPTION
Validates that all prerequisites for running TALA are present.
Produces a PASS/FAIL/WARN summary and exits with code 1 if any
critical check fails.

.NOTES
Usage: pwsh scripts\verify-setup.ps1
Safe to run from any directory --- paths resolve from this script's location.
#>

# Resolve repo root from this script's location (scripts\ -> repo root)
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RepoRoot

$PassCount = 0
$FailCount = 0
$WarnCount = 0

function Pass([string]$msg) {
    Write-Host "  [PASS] $msg" -ForegroundColor Green
    $script:PassCount++
}
function Fail([string]$msg) {
    Write-Host "  [FAIL] $msg" -ForegroundColor Red
    $script:FailCount++
}
function Warn([string]$msg) {
    Write-Host "  [WARN] $msg" -ForegroundColor Yellow
    $script:WarnCount++
}

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "   TALA Environment Readiness Check          " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "   Repo root: $RepoRoot"
Write-Host ""

# -------------------------------------------------------
# 1. Repo root sanity
# -------------------------------------------------------
Write-Host "[1] Repo root" -ForegroundColor Yellow
$PkgJson = Join-Path $RepoRoot "package.json"
if (Test-Path $PkgJson) {
    Pass "package.json found at $RepoRoot"
} else {
    Fail "package.json not found --- repo root may be wrong (got $RepoRoot)"
}

# -------------------------------------------------------
# 2. Node.js
# -------------------------------------------------------
Write-Host "[2] Node.js" -ForegroundColor Yellow
try {
    $nodeVer = node --version 2>&1
    Pass "node $nodeVer"
} catch {
    Fail "Node.js not found in PATH --- install from https://nodejs.org/"
}

try {
    $npmVer = npm --version 2>&1
    Pass "npm $npmVer"
} catch {
    Fail "npm not found in PATH"
}

# -------------------------------------------------------
# 3. node_modules
# -------------------------------------------------------
Write-Host "[3] Node modules" -ForegroundColor Yellow
$NodeModules = Join-Path $RepoRoot "node_modules"
if (Test-Path $NodeModules) {
    Pass "node_modules present"
} else {
    Fail "node_modules not found --- run: .\bootstrap.ps1"
}

# -------------------------------------------------------
# 4. Python
# -------------------------------------------------------
Write-Host "[4] Python" -ForegroundColor Yellow
try {
    $pyVer = python --version 2>&1
    if ($pyVer -match "Python 3") {
        Pass "$pyVer"
    } else {
        Fail "Python 3 required, found: $pyVer"
    }
} catch {
    Fail "Python not found in PATH --- install from https://python.org/"
}

# -------------------------------------------------------
# 5. Python venvs
# -------------------------------------------------------
Write-Host "[5] Python virtual environments" -ForegroundColor Yellow
$PythonModules = @(
    "local-inference",
    "mcp-servers\tala-core",
    "mcp-servers\mem0-core",
    "mcp-servers\astro-engine",
    "mcp-servers\world-engine",
    "mcp-servers\tala-memory-graph"
)
foreach ($Mod in $PythonModules) {
    $ModPath   = Join-Path $RepoRoot $Mod
    $VenvPy    = Join-Path $ModPath "venv\Scripts\python.exe"
    $ReqFile   = Join-Path $ModPath "requirements.txt"

    if (-not (Test-Path $ModPath)) {
        Warn "$Mod --- directory not found (optional)"
    } elseif (-not (Test-Path $ReqFile)) {
        Warn "$Mod --- no requirements.txt"
    } elseif (Test-Path $VenvPy) {
        Pass "$Mod venv ready"
    } else {
        Fail "$Mod venv missing --- run: .\bootstrap.ps1"
    }
}

# -------------------------------------------------------
# 6. llama.cpp / local inference
# -------------------------------------------------------
Write-Host "[6] Local inference (llama.cpp / llama-cpp-python)" -ForegroundColor Yellow

# Check for bundled Python runtimes used by launch-inference.bat
$BundledPythonFound = $false
$BundledPythonPaths = @(
    "local-inference\venv\Scripts\python.exe",
    "bin\python-win\python.exe",
    "bin\python-portable\python.exe",
    "bin\python\python.exe"
)
foreach ($P in $BundledPythonPaths) {
    $FullP = Join-Path $RepoRoot $P
    if (Test-Path $FullP) {
        Pass "Inference Python binary: $P"
        $BundledPythonFound = $true
        break
    }
}
if (-not $BundledPythonFound) {
    Warn "No bundled Python runtime found for local inference"
    Warn "Expected at bin\python-win\ or local-inference\venv\"
    Warn "Run .\bootstrap.ps1 to create the venv, or provision a bundled runtime."
}

# Check for at least one GGUF model
$ModelsDir = Join-Path $RepoRoot "models"
$GgufModel = $null
if (Test-Path $ModelsDir) {
    $GgufModel = Get-ChildItem -Path $ModelsDir -Filter "*.gguf" -ErrorAction SilentlyContinue | Select-Object -First 1
}
if ($GgufModel) {
    Pass "GGUF model: $($GgufModel.Name)"
} else {
    Warn "No .gguf model found in models\ --- run .\bootstrap.ps1 to download one"
}

# Check local-inference launch script
$LaunchBat = Join-Path $RepoRoot "scripts\diagnostics\launch-inference.bat"
if (Test-Path $LaunchBat) {
    Pass "launch-inference.bat present"
} else {
    Fail "launch-inference.bat not found"
}

# -------------------------------------------------------
# 7. Key config / source files
# -------------------------------------------------------
Write-Host "[7] Key project files" -ForegroundColor Yellow
$KeyFiles = @(
    "package.json",
    "tsconfig.json",
    "vite.config.ts",
    "electron\main.ts"
)
foreach ($F in $KeyFiles) {
    $FullF = Join-Path $RepoRoot $F
    if (Test-Path $FullF) {
        Pass $F
    } else {
        Fail "$F not found"
    }
}

# -------------------------------------------------------
# 8. PostgreSQL
# -------------------------------------------------------
Write-Host "[8] PostgreSQL" -ForegroundColor Yellow

# Skip checks when caller supplies an external connection string
if ($env:TALA_DB_CONNECTION_STRING) {
    Pass "TALA_DB_CONNECTION_STRING is set --- external DB in use, skipping local checks"
} else {
    $DbHost = if ($env:TALA_DB_HOST) { $env:TALA_DB_HOST } else { "localhost" }
    $DbPort = if ($env:TALA_DB_PORT) { $env:TALA_DB_PORT } else { "5432" }
    $DbName = if ($env:TALA_DB_NAME) { $env:TALA_DB_NAME } else { "tala" }
    $DbUser = if ($env:TALA_DB_USER) { $env:TALA_DB_USER } else { "tala" }
    $DbPass = if ($env:TALA_DB_PASSWORD)      { $env:TALA_DB_PASSWORD }      else { "tala" }
    $AdminP = if ($env:TALA_PG_SUPERPASSWORD) { $env:TALA_PG_SUPERPASSWORD } else { "postgres" }

    # Validate identifier overrides before embedding in psql commands
    $SafeIdPattern = '^[A-Za-z_][A-Za-z0-9_]{0,62}$'
    if ($DbName -notmatch $SafeIdPattern) { Fail "TALA_DB_NAME '$DbName' is not a valid PostgreSQL identifier"; $DbName = "tala" }
    if ($DbUser -notmatch $SafeIdPattern) { Fail "TALA_DB_USER '$DbUser' is not a valid PostgreSQL identifier"; $DbUser = "tala" }

    # --- psql binary ---
    $PsqlExe = $null
    $inPath  = Get-Command psql -ErrorAction SilentlyContinue
    if ($inPath) {
        $PsqlExe = $inPath.Source
        Pass "psql in PATH: $PsqlExe"
    } else {
        $bases = @("${env:ProgramFiles}\PostgreSQL", "C:\Program Files\PostgreSQL")
        foreach ($base in $bases) {
            if (-not (Test-Path $base)) { continue }
            $versions = Get-ChildItem -Path $base -Directory -ErrorAction SilentlyContinue |
                        Where-Object { $_.Name -match '^\d+' } |
                        Sort-Object   { [int]($_.Name -replace '[^\d].*', '') } -Descending
            foreach ($ver in $versions) {
                $cand = Join-Path $ver.FullName "bin\psql.exe"
                if (Test-Path $cand) { $PsqlExe = $cand; break }
            }
            if ($PsqlExe) { break }
        }
        if ($PsqlExe) { Pass "psql found: $PsqlExe" }
        else           { Fail  "psql not found --- run: .\bootstrap.ps1" }
    }

    # --- Windows service ---
    $pgSvc = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pgSvc) {
        if ($pgSvc.Status -eq 'Running') { Pass  "PostgreSQL service '$($pgSvc.Name)' is Running" }
        else                              { Fail  "PostgreSQL service '$($pgSvc.Name)' is $($pgSvc.Status) --- run: Start-Service '$($pgSvc.Name)'" }
    } else {
        Warn "No PostgreSQL Windows service detected (may be a portable install)"
    }

    # --- TCP reachability ---
    try {
        $tcp     = New-Object System.Net.Sockets.TcpClient
        $conn    = $tcp.BeginConnect($DbHost, [int]$DbPort, $null, $null)
        $reached = $conn.AsyncWaitHandle.WaitOne(3000)
        $tcp.Close()
        if ($reached) { Pass  "PostgreSQL reachable at ${DbHost}:${DbPort}" }
        else           { Fail  "PostgreSQL not reachable at ${DbHost}:${DbPort} --- ensure service is running" }
    } catch {
        Fail "PostgreSQL TCP check failed: $_"
        $reached = $false
    }

    # --- DB / role / pgvector checks (only if psql is available and DB is reachable) ---
    if ($PsqlExe -and $reached) {
        # tala role
        $env:PGPASSWORD = $AdminP
        $roleOut = & $PsqlExe -h $DbHost -p $DbPort -U postgres -d postgres `
                               -c "SELECT 1 FROM pg_roles WHERE rolname='$DbUser';" `
                               -t -A -X 2>&1
        $roleCode = $LASTEXITCODE
        $env:PGPASSWORD = $null

        if ($roleCode -eq 0 -and ($roleOut -join "").Trim() -eq "1") {
            Pass "PostgreSQL role '$DbUser' exists"
        } elseif ($roleCode -ne 0) {
            Warn "Could not query pg_roles (psql exit $roleCode) --- check superuser password (TALA_PG_SUPERPASSWORD)"
        } else {
            Fail "PostgreSQL role '$DbUser' not found --- run: .\bootstrap.ps1"
        }

        # tala database
        $env:PGPASSWORD = $AdminP
        $dbOut = & $PsqlExe -h $DbHost -p $DbPort -U postgres -d postgres `
                             -c "SELECT 1 FROM pg_database WHERE datname='$DbName';" `
                             -t -A -X 2>&1
        $dbCode = $LASTEXITCODE
        $env:PGPASSWORD = $null

        if ($dbCode -eq 0 -and ($dbOut -join "").Trim() -eq "1") {
            Pass "PostgreSQL database '$DbName' exists"
        } elseif ($dbCode -ne 0) {
            Warn "Could not query pg_database (psql exit $dbCode)"
        } else {
            Fail "PostgreSQL database '$DbName' not found --- run: .\bootstrap.ps1"
        }

        # pgvector
        $env:PGPASSWORD = $DbPass
        $vecOut = & $PsqlExe -h $DbHost -p $DbPort -U $DbUser -d $DbName `
                              -c "SELECT extname FROM pg_extension WHERE extname='vector';" `
                              -t -A -X 2>&1
        $vecCode = $LASTEXITCODE
        $env:PGPASSWORD = $null

        $vecName = ($vecOut -join '').Trim()
        if ($vecCode -eq 0 -and $vecName -eq 'vector') {
            Pass "pgvector extension enabled in '$DbName'"
        } elseif ($vecCode -ne 0) {
            Warn "Could not query pg_extension in '$DbName' (psql exit $vecCode)"
        } else {
            Warn "pgvector extension not yet enabled in '$DbName' - run: .\bootstrap.ps1"
        }
    }
}

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  Results: $PassCount passed  $WarnCount warnings  $FailCount failed"
Write-Host "=============================================" -ForegroundColor Cyan

if ($FailCount -gt 0) {
    Write-Host "[FAIL] Environment is NOT ready. Address the failures above." -ForegroundColor Red
    exit 1
} else {
    Write-Host "[OK] Environment looks ready." -ForegroundColor Green
    exit 0
}

