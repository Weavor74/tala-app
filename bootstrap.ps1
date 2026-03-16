<#
.SYNOPSIS
Bootstrap Script for TALA (The Autonomous Local Agent)

.DESCRIPTION
This script is designed to be downloaded and run on a fresh machine.
It will:
1. Check for prerequisite software (Python and Node.js).
2. Create all necessary runtime directories (models, data).
3. Download a default, lightweight Llama 3.2 3B Instruct model (Q4_K_M).
4. Install all Node.js frontend and framework dependencies.
5. Create Python virtual environments and install all requirements, prioritizing
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
# 1. Environment Checks
# ---------------------------------------------------------
Write-Host "[1/5] Checking Prerequisites..." -ForegroundColor Yellow

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
Write-Host "`n[2/5] Creating Runtime Directories..." -ForegroundColor Yellow

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
Write-Host "`n[3/5] Downloading Default Local LLM..." -ForegroundColor Yellow

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
Write-Host "`n[4/5] Installing Node.js Dependencies..." -ForegroundColor Yellow

$PackageJson = Join-Path $RepoRoot "package.json"
if (Test-Path $PackageJson) {
    Write-Host "      Running npm install in: $RepoRoot"
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "      [ERROR] npm install failed." -ForegroundColor Red
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
Write-Host "`n[5/5] Building Python Virtual Environments..." -ForegroundColor Yellow

# Function to build a venv and install requirements
# $ModulePath is relative to $RepoRoot
function Build-Venv {
    param([string]$ModulePath)

    $FullPath = Join-Path $RepoRoot $ModulePath
    $ReqFile  = Join-Path $FullPath "requirements.txt"
    $VenvDir  = Join-Path $FullPath "venv"
    $PythonExe = Join-Path $VenvDir "Scripts\python.exe"

    if (-not (Test-Path $ReqFile)) {
        Write-Host "      [SKIP] $ModulePath — no requirements.txt"
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
    "mcp-servers\world-engine"
)

foreach ($Mod in $PythonModules) {
    $FullPath = Join-Path $RepoRoot $Mod
    if (Test-Path $FullPath) {
        Build-Venv -ModulePath $Mod
    }
}

Write-Host "`n=============================================" -ForegroundColor Cyan
Write-Host "   BOOTSTRAP COMPLETE!                       " -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "You can now start TALA by running:"
Write-Host "  > npm run dev"
Write-Host ""
Write-Host "To verify the environment is ready, run:"
Write-Host "  > pwsh scripts\verify-setup.ps1"
Write-Host ""
