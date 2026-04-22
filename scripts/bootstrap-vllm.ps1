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
  TALA_ALLOW_SYSTEM_PYTHON=1 - permit fallback to system python when no local runtime exists
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
    $localCandidates = @(
        (Join-Path $RepoRoot "local-inference\venv\Scripts\python.exe"),
        (Join-Path $RepoRoot "bin\python-win\python.exe"),
        (Join-Path $RepoRoot "bin\python-portable\python.exe")
    )

    foreach ($candidate in $localCandidates) {
        if (Test-Path $candidate) {
            $PythonExe = $candidate
            Log-Info "Using project-local Python at: $PythonExe"
            break
        }
    }
}

if (-not $PythonExe) {
    if ($env:TALA_ALLOW_SYSTEM_PYTHON -eq "1") {
        try {
            $ver = python --version 2>&1
            if ($ver -match "Python 3") {
                $PythonExe = "python"
                Log-Warn "Using system Python because TALA_ALLOW_SYSTEM_PYTHON=1: $ver"
            }
        } catch { }

        if (-not $PythonExe) {
            try {
                $ver = python3 --version 2>&1
                if ($ver -match "Python 3") {
                    $PythonExe = "python3"
                    Log-Warn "Using system python3 because TALA_ALLOW_SYSTEM_PYTHON=1: $ver"
                }
            } catch { }
        }
    }
}

if (-not $PythonExe) {
    Log-Err "No project-local Python interpreter found for vLLM bootstrap."
    Log-Err "Expected one of:"
    Log-Err "  - local-inference\venv\Scripts\python.exe"
    Log-Err "  - bin\python-win\python.exe"
    Log-Err "  - bin\python-portable\python.exe"
    Log-Err "Set TALA_PYTHON_EXE to a local interpreter, or set TALA_ALLOW_SYSTEM_PYTHON=1 to opt into system Python."
    exit 1
}

& $PythonExe -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Log-Err "Python 3.10+ is required for vLLM bootstrap. Selected interpreter: $PythonExe"
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

if ($IsWindows) {
    Log-Info "Validating Windows embedded_vllm launcher compatibility (uvloop-free Tala path)..."
    & $VenvPython -c @"
import importlib.util
import pathlib
import sys

entrypoint_spec = importlib.util.find_spec('vllm.entrypoints.openai.api_server')
if entrypoint_spec is None or entrypoint_spec.origin is None:
    print('[VLLM] WARN: OpenAI API entrypoint not found in installed vLLM build.')
    raise SystemExit(0)

entrypoint_path = pathlib.Path(entrypoint_spec.origin)
source = entrypoint_path.read_text(encoding='utf-8', errors='ignore')
requires_uvloop = 'import uvloop' in source
has_uvloop = importlib.util.find_spec('uvloop') is not None

if requires_uvloop and not has_uvloop:
    print('[VLLM] WARN: This vLLM build hard-requires uvloop in the API entrypoint.')
    print('[VLLM] WARN: Tala Windows launcher does not require uvloop; embedded_vllm may remain unavailable on this host.')
    print('[VLLM] WARN: Use ollama or install a Windows-compatible vLLM build for embedded fallback.')
"@
}

Log-Ok "Installation complete."
Log-Info ""
Log-Info "To start the vLLM server, run:"
Log-Info "  scripts\run-vllm.bat"
Log-Info ""
Log-Info "Set TALA_VLLM_MODEL to the HuggingFace model ID or local path before launching."
Log-Info "Example: set TALA_VLLM_MODEL=microsoft/phi-2 && scripts\run-vllm.bat"
