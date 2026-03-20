<#
.SYNOPSIS
Bootstrap Script for TALA (The Autonomous Local Agent)

.DESCRIPTION
This script is designed to be downloaded and run on a fresh machine.
It will:
1. Validate that required source files exist in the repository.
2. Validate that package.json declares all required Node.js dependencies.
3. Check for prerequisite software (Python and Node.js).
4. Create all necessary runtime directories (models, data).
5. Download a default, lightweight Llama 3.2 3B Instruct model (Q4_K_M).
6. Install Node.js dependencies (npm ci when package-lock.json exists, otherwise npm install).
7. Create Python virtual environments and install all requirements, prioritizing
   pre-built binary wheels for llama-cpp-python to bypass C++ compilation.

.NOTES
Run this script from a PowerShell terminal: .\bootstrap.ps1
#>

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------
# Resolve repo root relative to this script's location
# so bootstrap works regardless of the caller's CWD.
# ---------------------------------------------------------
$RepoRoot = $PSScriptRoot
Set-Location $RepoRoot

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "      TALA UNIVERSAL BOOTSTRAP SCRIPT        " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "      Repo root: $RepoRoot"
Write-Host ""

# ---------------------------------------------------------
# 0. Validate Required Source Files
# ---------------------------------------------------------
Write-Host "[0/8] Validating Required Repository Source Files..." -ForegroundColor Yellow

$RequiredFiles = @(
    "shared/memory/MemoryRepository.ts",
    "shared/memory/memoryTypes.ts",
    "electron/services/db/PostgresMemoryRepository.ts",
    "electron/services/db/MigrationRunner.ts",
    "electron/services/db/initMemoryStore.ts",
    "package.json"
)

$missingFiles = @()
foreach ($RelPath in $RequiredFiles) {
    $FullPath = Join-Path $RepoRoot $RelPath
    if (-not (Test-Path $FullPath)) {
        $missingFiles += $RelPath
        Write-Host "      [MISSING] $RelPath" -ForegroundColor Red
    } else {
        Write-Host "      [OK]      $RelPath" -ForegroundColor Green
    }
}

if ($missingFiles.Count -gt 0) {
    Write-Host ""
    Write-Host "      [ERROR] $($missingFiles.Count) required source file(s) are missing." -ForegroundColor Red
    Write-Host "      Bootstrap cannot continue without these files." -ForegroundColor Red
    Write-Host "      Please ensure the repository is fully cloned and all source files are present."
    exit 1
}

# ---------------------------------------------------------
# 0b. Validate Required Node.js Dependencies in package.json
# ---------------------------------------------------------
Write-Host "`n[0b/8] Validating package.json Node.js Dependencies..." -ForegroundColor Yellow

$PackageJsonPath = Join-Path $RepoRoot "package.json"
$packageContent  = Get-Content $PackageJsonPath -Raw | ConvertFrom-Json

$RequiredDeps = [ordered]@{
    "pg"        = "dependencies"
    "pgvector"  = "dependencies"
    "@types/pg" = "devDependencies"
}

$missingDeps = @()
foreach ($dep in $RequiredDeps.Keys) {
    $section = $RequiredDeps[$dep]
    $found   = $false
    if ($section -eq "dependencies" -and $packageContent.dependencies.PSObject.Properties[$dep]) {
        $found = $true
    } elseif ($section -eq "devDependencies" -and $packageContent.devDependencies.PSObject.Properties[$dep]) {
        $found = $true
    }
    if ($found) {
        Write-Host "      [OK] $dep ($section)" -ForegroundColor Green
    } else {
        $missingDeps += "$dep (expected in $section)"
        Write-Host "      [MISSING] $dep (expected in $section)" -ForegroundColor Red
    }
}

if ($missingDeps.Count -gt 0) {
    Write-Host ""
    Write-Host "      [ERROR] package.json is missing required dependencies:" -ForegroundColor Red
    foreach ($d in $missingDeps) { Write-Host "        - $d" -ForegroundColor Red }
    Write-Host "      Add them with: npm install pg pgvector && npm install --save-dev @types/pg"
    exit 1
}

# ---------------------------------------------------------
# 1. Environment Checks
# ---------------------------------------------------------
Write-Host "`n[1/8] Checking Prerequisites..." -ForegroundColor Yellow

# Check Node
try {
    $nodeVer = node --version
    Write-Host "      [OK] Node.js found: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "      [ERROR] Node.js is not installed or not in PATH." -ForegroundColor Red
    Write-Host "      Please install Node.js (v18+) from https://nodejs.org/"
    exit 1
}

# Check npm
try {
    $npmVer = npm --version
    Write-Host "      [OK] npm found: $npmVer" -ForegroundColor Green
} catch {
    Write-Host "      [ERROR] npm is not installed or not in PATH." -ForegroundColor Red
    exit 1
}

# Check Python
try {
    $pyVer = python --version 2>&1
    if ($pyVer -notmatch "Python 3") {
        Write-Host "      [ERROR] Python 3 required but found: $pyVer" -ForegroundColor Red
        Write-Host "      Please install Python 3.10+ from https://python.org/"
        exit 1
    }
    Write-Host "      [OK] Python found: $pyVer" -ForegroundColor Green
} catch {
    Write-Host "      [ERROR] Python is not installed or not in PATH." -ForegroundColor Red
    Write-Host "      Please install Python 3.10+ from https://python.org/"
    Write-Host "      IMPORTANT: Ensure 'Add Python to PATH' is checked during installation."
    exit 1
}

# ---------------------------------------------------------
# 2. Create Missing Folders
# ---------------------------------------------------------
Write-Host "`n[2/8] Creating Runtime Directories..." -ForegroundColor Yellow

$Dirs = @("models", "data", "bin\python-win", "memory")
foreach ($Dir in $Dirs) {
    $FullPath = Join-Path $RepoRoot $Dir
    if (-not (Test-Path $FullPath)) {
        New-Item -ItemType Directory -Path $FullPath -Force | Out-Null
        Write-Host "      Created: $Dir"
    } else {
        Write-Host "      Exists: $Dir"
    }
}

# ---------------------------------------------------------
# 3. Download LLM (.gguf)
# ---------------------------------------------------------
Write-Host "`n[3/8] Downloading Default Local LLM..." -ForegroundColor Yellow

$ModelUrl = "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf"
$ModelDest = Join-Path $RepoRoot "models\Llama-3.2-3B-Instruct-Q4_K_M.gguf"

if (-not (Test-Path $ModelDest)) {
    Write-Host "      Downloading Llama 3.2 3B Instruct (Q4_K_M)..."
    Write-Host "      This is a ~2GB file and may take a few minutes depending on your connection."
    Invoke-WebRequest -Uri $ModelUrl -OutFile $ModelDest -UseBasicParsing
    Write-Host "      [OK] Model downloaded successfully." -ForegroundColor Green
} else {
    Write-Host "      [OK] Model already exists. Skipping download." -ForegroundColor Green
}

# ---------------------------------------------------------
# 4. Install Node Libraries
# ---------------------------------------------------------
Write-Host "`n[4/8] Installing Node.js Dependencies..." -ForegroundColor Yellow

$PackageJson = Join-Path $RepoRoot "package.json"
if (Test-Path $PackageJson) {
    $LockFile = Join-Path $RepoRoot "package-lock.json"
    if (Test-Path $LockFile) {
        Write-Host "      package-lock.json found  -  running npm ci for deterministic install."
        # --ignore-scripts prevents arbitrary postinstall scripts from running during bootstrap.
        # Note: node-pty requires native build tools (node-gyp) to run its install script;
        # if needed, run: npm rebuild node-pty  after initial installation.
        npm ci --ignore-scripts
    } else {
        Write-Host "      No package-lock.json  -  running npm install."
        npm install --ignore-scripts
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "      [ERROR] npm dependency installation failed." -ForegroundColor Red
        exit 1
    }
    Write-Host "      [OK] Node packages installed." -ForegroundColor Green
} else {
    Write-Host "      [ERROR] package.json not found at $RepoRoot" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------
# 5. Setup Python Virtual Envs & MCP Servers
# ---------------------------------------------------------
Write-Host "`n[5/8] Building Python Virtual Environments..." -ForegroundColor Yellow

# Function to build a venv and install requirements
# $ModulePath is relative to $RepoRoot
function Build-Venv {
    param([string]$ModulePath)

    $FullPath = Join-Path $RepoRoot $ModulePath
    $ReqFile  = Join-Path $FullPath "requirements.txt"
    $VenvDir  = Join-Path $FullPath "venv"
    $PythonExe = Join-Path $VenvDir "Scripts\python.exe"

    if (-not (Test-Path $ReqFile)) {
        Write-Host "      [SKIP] $ModulePath -- no requirements.txt"
        return
    }

    Write-Host "      -> Setting up $ModulePath..."

    # Create Venv if absent
    if (-not (Test-Path $VenvDir)) {
        python -m venv $VenvDir
        if ($LASTEXITCODE -ne 0) {
            Write-Host "         [ERROR] Failed to create venv at $VenvDir" -ForegroundColor Red
            return
        }
    }

    # Upgrade pip
    & $PythonExe -m pip install --upgrade pip --quiet

    # Install dependencies. For local-inference, we use an extra-index-url to grab prebuilt wheels
    # for llama-cpp-python so we don't compile C++ from scratch.
    if ($ModulePath -like "*local-inference*") {
        Write-Host "         Fetching pre-built wheels for llama-cpp-python..."
        & $PythonExe -m pip install -r $ReqFile --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu --quiet
    } else {
        & $PythonExe -m pip install -r $ReqFile --quiet
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Host "         [ERROR] pip install failed for $ModulePath" -ForegroundColor Red
        return
    }

    Write-Host "         [OK] Installed." -ForegroundColor Green
}

# Run for inference and core agents
$PythonModules = @(
    "local-inference",
    "mcp-servers\tala-core",
    "mcp-servers\mem0-core",
    "mcp-servers\astro-engine",
    "mcp-servers\world-engine",
    "mcp-servers\tala-memory-graph"
)

foreach ($Mod in $PythonModules) {
    $FullPath = Join-Path $RepoRoot $Mod
    if (Test-Path $FullPath) {
        Build-Venv -ModulePath $Mod
    }
}

# ---------------------------------------------------------
# 6. Provision PostgreSQL (install/start/create DB + pgvector)
# ---------------------------------------------------------
Write-Host "`n[6/8] Provisioning PostgreSQL..." -ForegroundColor Yellow

$PgHelper = Join-Path $RepoRoot "scripts\bootstrap-postgres.ps1"
if (Test-Path $PgHelper) {
    & $PgHelper
    if ($LASTEXITCODE -ne 0) {
        Write-Host "      [ERROR] PostgreSQL provisioning failed. See errors above." -ForegroundColor Red
        Write-Host "      Resolve the issue, then re-run: .\bootstrap.ps1"
        exit 1
    }
} else {
    Write-Host "      [WARN] scripts\bootstrap-postgres.ps1 not found  -  skipping PostgreSQL provisioning." -ForegroundColor Yellow
}

Write-Host "`n=============================================" -ForegroundColor Cyan
Write-Host "   BOOTSTRAP COMPLETE!                       " -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host 'You can now start TALA by running:'
Write-Host '  npm run dev'
Write-Host ''
Write-Host 'PostgreSQL + Tala DB provisioning:'
Write-Host "  The 'tala' database and 'tala' user were created (or already existed)."
Write-Host '  Schema (tables/indexes) will be created by Tala''s migration runner on first startup.'
Write-Host ''
Write-Host 'To verify the full environment, run:'
Write-Host '  scripts\verify-setup.ps1'
Write-Host ''