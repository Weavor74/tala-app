<#
.SYNOPSIS
Bootstrap vLLM embedded inference provider for TALA (Windows PowerShell)

.DESCRIPTION
Installs vLLM and its required dependencies into a dedicated Python virtual
environment at local-inference\vllm-venv\.

Responsibilities:
  1. Detects a project-local or system Python 3 interpreter.
  2. Creates a virtual environment at <REPO_ROOT>\local-inference\vllm-venv\.
  3. Installs vllm, fastapi, and uvicorn (GPU if CUDA available, CPU otherwise).
  4. Logs all steps with [VLLM] prefix.

Usage:
  .\scripts\bootstrap-vllm.ps1

Environment variables respected:
  TALA_PYTHON_EXE  - override the Python executable (default: auto-detect)
#>

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot   = Split-Path -Parent $ScriptDir
$VenvDir    = Join-Path $RepoRoot "local-inference\vllm-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

function Log-Info { param($msg) Write-Host "[VLLM] $msg" -ForegroundColor Cyan }
function Log-Ok   { param($msg) Write-Host "[VLLM] OK: $msg" -ForegroundColor Green }
function Log-Warn { param($msg) Write-Host "[VLLM] WARN: $msg" -ForegroundColor Yellow }
function Log-Err  { param($msg) Write-Host "[VLLM] ERROR: $msg" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# 1. Locate Python interpreter
# ---------------------------------------------------------------------------

# Prefer explicitly specified Python, then project-local venv, then system Python
$PythonExe = $env:TALA_PYTHON_EXE

if (-not $PythonExe) {
    $LocalPython = Join-Path $RepoRoot "local-inference\venv\Scripts\python.exe"
    if (Test-Path $LocalPython) {
        $PythonExe = $LocalPython
        Log-Info "Using project-local Python at: $PythonExe"
    }
}

if (-not $PythonExe) {
    try {
        $ver = python --version 2>&1
        if ($ver -match "Python 3") {
            $PythonExe = "python"
            Log-Info "Using system Python: $ver"
        }
    } catch { }
}

if (-not $PythonExe) {
    try {
        $ver = python3 --version 2>&1
        if ($ver -match "Python 3") {
            $PythonExe = "python3"
            Log-Info "Using system python3: $ver"
        }
    } catch { }
}

if (-not $PythonExe) {
    Log-Err "No Python 3 interpreter found."
    Log-Err "Install Python 3.10+ from https://python.org/ or set TALA_PYTHON_EXE."
    exit 1
}

# ---------------------------------------------------------------------------
# 2. Create virtual environment
# ---------------------------------------------------------------------------

Log-Info "Setting up vLLM virtual environment at: $VenvDir"

if (-not (Test-Path $VenvDir)) {
    Log-Info "Creating virtual environment..."
    & $PythonExe -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) {
        Log-Err "Failed to create virtual environment."
        exit 1
    }
}

# Upgrade pip inside the venv
Log-Info "Upgrading pip..."
& $VenvPython -m pip install --upgrade pip --quiet
if ($LASTEXITCODE -ne 0) {
    Log-Warn "pip upgrade failed; continuing with existing pip."
}

# ---------------------------------------------------------------------------
# 3. Detect GPU / CUDA availability
# ---------------------------------------------------------------------------

$HasCuda = $false
try {
    $nvidiaSmi = & nvidia-smi --query-gpu=name --format=csv,noheader 2>&1
    if ($LASTEXITCODE -eq 0 -and $nvidiaSmi -match "\S") {
        $HasCuda = $true
        Log-Info "CUDA GPU detected: $($nvidiaSmi.Split([Environment]::NewLine)[0].Trim())"
    }
} catch { }

# ---------------------------------------------------------------------------
# 4. Install vLLM and required dependencies
# ---------------------------------------------------------------------------

Log-Info "Installing vLLM..."

if ($HasCuda) {
    Log-Info "GPU mode: installing vLLM with CUDA support."
    & $VenvPython -m pip install vllm --quiet
} else {
    Log-Warn "No CUDA GPU detected. Installing vLLM in CPU-only mode."
    Log-Warn "CPU inference is significantly slower than GPU."
    # vLLM CPU mode requires installing with the cpu extra or using env var
    $env:VLLM_CPU_ONLY = "1"
    & $VenvPython -m pip install vllm --quiet
}

if ($LASTEXITCODE -ne 0) {
    Log-Err "vLLM installation failed."
    Log-Err "If the error is GPU-related, try setting TALA_PYTHON_EXE to a CPU-only Python environment."
    exit 1
}

# Ensure fastapi and uvicorn are present (vLLM depends on them but pin them for safety)
Log-Info "Installing fastapi and uvicorn..."
& $VenvPython -m pip install fastapi uvicorn --quiet
if ($LASTEXITCODE -ne 0) {
    Log-Err "Failed to install fastapi/uvicorn."
    exit 1
}

# ---------------------------------------------------------------------------
# 5. Verify installation
# ---------------------------------------------------------------------------

Log-Info "Verifying vLLM installation..."
& $VenvPython -c "import vllm; print('[VLLM] vLLM version:', vllm.__version__)" 2>&1
if ($LASTEXITCODE -ne 0) {
    Log-Err "vLLM import verification failed."
    exit 1
}

Log-Ok "Installation complete."
Log-Info ""
Log-Info "To start the vLLM server, run:"
Log-Info "  scripts\run-vllm.bat"
Log-Info ""
Log-Info "Set TALA_VLLM_MODEL to the HuggingFace model ID or local path before launching."
Log-Info "Example: set TALA_VLLM_MODEL=microsoft/phi-2 && scripts\run-vllm.bat"
