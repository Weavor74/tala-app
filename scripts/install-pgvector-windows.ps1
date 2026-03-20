<#
.SYNOPSIS
Install prebuilt pgvector extension files into an existing PostgreSQL installation on Windows.

.DESCRIPTION
Copies vector.dll, vector.control, and vector--*.sql from a prebuilt pgvector bundle
into the correct PostgreSQL directories (lib\ and share\extension\). No compiler or
build tools are required.

Bundle source resolution order (first valid source wins):
  1. TALA_PGVECTOR_PATH env var   -  a directory containing extracted pgvector files,
                                   or a .zip archive
  2. Repo-local extracted dir     -  installers\pgvector\windows\postgres-<major>\
                                   or installers\pgvector\windows\
  3. Repo-local zip archive       -  installers\pgvector\windows\pgvector-pg<major>-x64.zip
                                   or installers\pgvector\windows\pgvector-windows.zip
  4. Download URL                 -  TALA_PGVECTOR_DOWNLOAD_URL env var (optional;
                                   only attempted when the env var is explicitly set)

Parameters:
  -PsqlExe   Full path to psql.exe; used to derive the PostgreSQL install root.
  -RepoRoot  Root of the Tala repository; used to find local bundle assets.
             Defaults to the parent directory of this script's location (scripts\).

Environment variable overrides (all optional):
  TALA_PGVECTOR_PATH           -  path to bundle dir or zip (source priority 1)
  TALA_PGVECTOR_DOWNLOAD_URL   -  direct download URL for a pgvector Windows zip (source 4)

Exit codes:
  0  -  pgvector files successfully installed (or were already in place).
  1  -  Installation failed; diagnostic messages emitted above.
#>

param(
    [Parameter(Mandatory)]
    [string]$PsqlExe,

    [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = "Stop"

# -----------------------------------------------------------------------
# Logging helpers  -  consistent with bootstrap.ps1 / bootstrap-postgres.ps1
# -----------------------------------------------------------------------
function PGV-Ok   { param($msg) Write-Host "         [OK] $msg"    -ForegroundColor Green  }
function PGV-Info { param($msg) Write-Host "         $msg"                                 }
function PGV-Warn { param($msg) Write-Host "         [WARN] $msg"  -ForegroundColor Yellow }
function PGV-Fail { param($msg) Write-Host "         [ERROR] $msg" -ForegroundColor Red    }

# -----------------------------------------------------------------------
# 1. Derive PostgreSQL install root and major version from psql.exe path
# -----------------------------------------------------------------------
# Expected path structure: <pg_root>\bin\psql.exe
$PgBinDir = Split-Path -Parent $PsqlExe
$PgRoot   = Split-Path -Parent $PgBinDir

if (-not (Test-Path $PgRoot)) {
    PGV-Fail "Could not derive PostgreSQL install root from psql path: $PsqlExe"
    PGV-Fail "Expected path structure: <install_root>\bin\psql.exe"
    exit 1
}

# Detect major version from the version-named install directory
# (e.g., "16" from C:\Program Files\PostgreSQL\16)
$PgMajor = $null
$pgRootLeaf = Split-Path -Leaf $PgRoot
if ($pgRootLeaf -match '^(\d+)') {
    $PgMajor = $Matches[1]
}

# Fallback: ask psql itself
if (-not $PgMajor) {
    try {
        $verLine = & $PsqlExe --version 2>&1 | Select-Object -First 1
        if ($verLine -match 'PostgreSQL\s+(\d+)') {
            $PgMajor = $Matches[1]
        }
    } catch {}
}

if (-not $PgMajor) {
    PGV-Warn "Could not determine PostgreSQL major version; using version-agnostic bundle paths."
    $PgMajor = "unknown"
}

PGV-Info "PostgreSQL root:    $PgRoot"
PGV-Info "PostgreSQL version: $PgMajor"

# -----------------------------------------------------------------------
# 2. Resolve destination directories
# -----------------------------------------------------------------------
$PgLibDir = Join-Path $PgRoot "lib"
$PgExtDir = Join-Path $PgRoot "share\extension"

foreach ($requiredDir in @($PgLibDir, $PgExtDir)) {
    if (-not (Test-Path $requiredDir)) {
        PGV-Fail "Expected PostgreSQL directory not found: $requiredDir"
        PGV-Fail "Verify the PostgreSQL installation at: $PgRoot"
        exit 1
    }
}

PGV-Info "Target lib dir:       $PgLibDir"
PGV-Info "Target extension dir: $PgExtDir"

# -----------------------------------------------------------------------
# 3. Idempotency check  -  skip if pgvector files are already in place
# -----------------------------------------------------------------------
function Test-PgvectorInstalled {
    $dll     = Join-Path $PgLibDir "vector.dll"
    $control = Join-Path $PgExtDir "vector.control"
    return (Test-Path $dll) -and (Test-Path $control)
}

if (Test-PgvectorInstalled) {
    PGV-Ok "pgvector files already present in PostgreSQL installation  -  nothing to do."
    exit 0
}

# -----------------------------------------------------------------------
# 4. Bundle validation helper
#    Returns $true if $Dir (recursively) contains vector.dll, vector.control,
#    and at least one vector--*.sql file.
# -----------------------------------------------------------------------
function Test-BundleDir {
    param([string]$Dir)
    if (-not (Test-Path $Dir -PathType Container)) { return $false }
    $dll     = Get-ChildItem -Path $Dir -Recurse -Filter "vector.dll"    -ErrorAction SilentlyContinue | Select-Object -First 1
    $control = Get-ChildItem -Path $Dir -Recurse -Filter "vector.control" -ErrorAction SilentlyContinue | Select-Object -First 1
    $sql     = Get-ChildItem -Path $Dir -Recurse -Filter "vector--*.sql"  -ErrorAction SilentlyContinue | Select-Object -First 1
    return ($null -ne $dll) -and ($null -ne $control) -and ($null -ne $sql)
}

# -----------------------------------------------------------------------
# 5. Archive extraction helper
#    Extracts a .zip to a new temp directory and returns that path.
#    Returns $null on failure; caller is responsible for cleanup.
# -----------------------------------------------------------------------
function Expand-BundleZip {
    param([string]$ZipPath)
    if (-not (Test-Path $ZipPath)) { return $null }
    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) `
                        ("pgvector-bundle-" + [System.IO.Path]::GetRandomFileName())
    try {
        Expand-Archive -Path $ZipPath -DestinationPath $tmpDir -Force
        PGV-Info "Extracted archive to: $tmpDir"
        return $tmpDir
    } catch {
        PGV-Warn "Failed to extract ${ZipPath}: $_"
        if (Test-Path $tmpDir) { Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue }
        return $null
    }
}

# -----------------------------------------------------------------------
# 6. Bundle source resolution
#    Returns a validated extracted directory path, or $null if no source found.
#    Temporary directories created during this function are returned to the caller;
#    the caller is responsible for cleanup.
# -----------------------------------------------------------------------
function Resolve-BundleDir {

    # --- Source 1: TALA_PGVECTOR_PATH env var ---
    $envPath = $env:TALA_PGVECTOR_PATH
    if ($envPath) {
        PGV-Info "Checking TALA_PGVECTOR_PATH: $envPath"
        if (Test-Path $envPath -PathType Container) {
            if (Test-BundleDir $envPath) {
                PGV-Info "Using TALA_PGVECTOR_PATH directory."
                return $envPath
            } else {
                PGV-Warn "TALA_PGVECTOR_PATH directory does not contain required pgvector files."
                PGV-Warn "  Expected: vector.dll, vector.control, vector--*.sql (anywhere under the directory)"
            }
        } elseif ($envPath -match '\.zip$' -and (Test-Path $envPath)) {
            $tmp = Expand-BundleZip -ZipPath $envPath
            if ($null -ne $tmp) {
                if (Test-BundleDir $tmp) {
                    return $tmp   # caller cleans up
                }
                PGV-Warn "TALA_PGVECTOR_PATH zip does not contain required pgvector files."
                Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
            }
        } else {
            PGV-Warn "TALA_PGVECTOR_PATH is set but path was not found or is not a directory/zip: $envPath"
        }
    }

    # --- Source 2: Repo-local extracted directories ---
    $localDirs = @(
        (Join-Path $RepoRoot "installers\pgvector\windows\postgres-$PgMajor"),
        (Join-Path $RepoRoot "installers\pgvector\windows")
    )
    foreach ($dir in $localDirs) {
        if (Test-BundleDir $dir) {
            PGV-Info "Found local bundle directory: $dir"
            return $dir
        }
    }

    # --- Source 3: Repo-local zip archives ---
    $localZips = @(
        (Join-Path $RepoRoot "installers\pgvector\windows\pgvector-pg${PgMajor}-x64.zip"),
        (Join-Path $RepoRoot "installers\pgvector\windows\pgvector-windows.zip")
    )
    foreach ($zip in $localZips) {
        if (Test-Path $zip) {
            PGV-Info "Found local bundle archive: $zip"
            $tmp = Expand-BundleZip -ZipPath $zip
            if ($null -ne $tmp) {
                if (Test-BundleDir $tmp) {
                    return $tmp   # caller cleans up
                }
                PGV-Warn "Archive $zip does not contain required pgvector files."
                Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
            }
        }
    }

    # --- Source 4: Optional download URL (only when explicitly configured) ---
    $dlUrl = $env:TALA_PGVECTOR_DOWNLOAD_URL
    if ($dlUrl) {
        PGV-Info "Attempting download from TALA_PGVECTOR_DOWNLOAD_URL..."
        PGV-Info "URL: $dlUrl"
        $dlZip = Join-Path ([System.IO.Path]::GetTempPath()) `
                            ("pgvector-download-" + [System.IO.Path]::GetRandomFileName() + ".zip")
        try {
            Invoke-WebRequest -Uri $dlUrl -OutFile $dlZip -UseBasicParsing
            PGV-Info "Download complete."
        } catch {
            PGV-Warn "Download failed: $_"
            if (Test-Path $dlZip) { Remove-Item -Force $dlZip -ErrorAction SilentlyContinue }
            return $null
        }
        $tmp = Expand-BundleZip -ZipPath $dlZip
        Remove-Item -Force $dlZip -ErrorAction SilentlyContinue
        if ($null -ne $tmp) {
            if (Test-BundleDir $tmp) {
                return $tmp   # caller cleans up
            }
            PGV-Warn "Downloaded archive does not contain required pgvector files."
            Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
        }
    }

    return $null
}

# -----------------------------------------------------------------------
# 7. File installation helper
#    Copies bundle files to the PostgreSQL lib\ and share\extension\ directories.
#    Returns $true on success.
# -----------------------------------------------------------------------
function Install-BundleFiles {
    param([string]$BundleDir)
    PGV-Info "Installing pgvector files from bundle..."

    $dllFiles  = @(Get-ChildItem -Path $BundleDir -Recurse -Filter "vector.dll"    -ErrorAction SilentlyContinue)
    $extFiles  = @(
        Get-ChildItem -Path $BundleDir -Recurse -Filter "vector.control" -ErrorAction SilentlyContinue
        Get-ChildItem -Path $BundleDir -Recurse -Filter "vector--*.sql"  -ErrorAction SilentlyContinue
    )

    $errors = 0

    foreach ($f in $dllFiles) {
        $dest = Join-Path $PgLibDir $f.Name
        try {
            Copy-Item -Path $f.FullName -Destination $dest -Force
            PGV-Info "  Copied: $($f.Name)  ->  $PgLibDir"
        } catch {
            PGV-Fail "  Failed to copy $($f.Name): $_"
            $errors++
        }
    }

    foreach ($f in $extFiles) {
        $dest = Join-Path $PgExtDir $f.Name
        try {
            Copy-Item -Path $f.FullName -Destination $dest -Force
            PGV-Info "  Copied: $($f.Name)  ->  $PgExtDir"
        } catch {
            PGV-Fail "  Failed to copy $($f.Name): $_"
            $errors++
        }
    }

    return ($errors -eq 0)
}

# -----------------------------------------------------------------------
# 8. Main installation flow
# -----------------------------------------------------------------------
PGV-Info "Searching for pgvector bundle (PG $PgMajor)..."

$bundleDir    = Resolve-BundleDir
$isTempBundle = $false

if (-not $bundleDir) {
    PGV-Fail "No pgvector bundle found. Searched:"
    PGV-Fail "  [env]  TALA_PGVECTOR_PATH"
    PGV-Fail ("  [dir]  " + $RepoRoot + "\installers\pgvector\windows\postgres-" + $PgMajor + "\")
    PGV-Fail ("  [dir]  " + $RepoRoot + "\installers\pgvector\windows\")
    PGV-Fail "  [zip]  $RepoRoot\installers\pgvector\windows\pgvector-pg${PgMajor}-x64.zip"
    PGV-Fail "  [zip]  $RepoRoot\installers\pgvector\windows\pgvector-windows.zip"
    PGV-Fail "  [env]  TALA_PGVECTOR_DOWNLOAD_URL"
    PGV-Fail ""
    PGV-Fail "To supply a bundle, choose one of:"
    PGV-Fail "  1. Download a prebuilt pgvector Windows bundle for PostgreSQL ${PgMajor}:"
    PGV-Fail "       https://github.com/pgvector/pgvector/releases"
    PGV-Fail "     Extract and place files in:"
    PGV-Fail ("       installers\pgvector\windows\postgres-" + $PgMajor + "\")
    PGV-Fail "     Expected files: vector.dll, vector.control, vector--*.sql"
    PGV-Fail "  2. Set TALA_PGVECTOR_PATH to the extracted directory or .zip file."
    PGV-Fail "  3. Set TALA_PGVECTOR_DOWNLOAD_URL to a direct .zip download URL."
    PGV-Fail "  4. Use the Docker stack (already includes pgvector):"
    PGV-Fail "       npm run memory:up"
    PGV-Fail ""
    PGV-Fail "After supplying the bundle, re-run: .\bootstrap.ps1"
    exit 1
}

# Track whether the bundleDir is a temp directory we should clean up afterward
$isTempBundle = $bundleDir.StartsWith([System.IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)

try {
    $ok = Install-BundleFiles -BundleDir $bundleDir
    if (-not $ok) {
        PGV-Fail "One or more files could not be copied."
        PGV-Fail "Check that you have write permissions on the PostgreSQL installation directory:"
        PGV-Fail "  $PgRoot"
        PGV-Fail "Try re-running bootstrap as Administrator:"
        PGV-Fail "  Right-click PowerShell -> 'Run as Administrator' -> .\bootstrap.ps1"
        exit 1
    }
} finally {
    if ($isTempBundle -and (Test-Path $bundleDir)) {
        Remove-Item -Recurse -Force $bundleDir -ErrorAction SilentlyContinue
    }
}

# Verify files landed correctly
if (-not (Test-PgvectorInstalled)) {
    PGV-Fail "pgvector files were not found in place after the copy step."
    PGV-Fail "Expected:"
    PGV-Fail "  $PgLibDir\vector.dll"
    PGV-Fail "  $PgExtDir\vector.control"
    exit 1
}

PGV-Ok "pgvector files installed successfully."
PGV-Info ("  vector.dll     -> " + $PgLibDir + "\")
PGV-Info ("  vector.control -> " + $PgExtDir + "\")
exit 0
