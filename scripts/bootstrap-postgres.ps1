<#
.SYNOPSIS
PostgreSQL provisioning helper for TALA bootstrap (Windows PowerShell).

.DESCRIPTION
Called by bootstrap.ps1. Idempotently ensures:
  1. PostgreSQL is installed (detects existing install, uses winget or local installer if not).
  2. PostgreSQL Windows service is running.
  3. The 'tala' role/user exists in PostgreSQL.
  4. The 'tala' database exists, owned by the 'tala' role.
  5. The pgvector extension is enabled in the 'tala' database.

Schema creation (tables, indexes) is NOT performed here. Tala's migration
runner handles that on first app startup.

Environment variable overrides (all optional):
  TALA_DB_CONNECTION_STRING   -  if set, skip all local provisioning entirely
  TALA_DB_HOST                -  PostgreSQL host  (default: localhost)
  TALA_DB_PORT                -  PostgreSQL port  (default: 5432)
  TALA_DB_NAME                -  Database name    (default: tala)
  TALA_DB_USER                -  App role name    (default: tala)
  TALA_DB_PASSWORD            -  App role password (default: tala)
  TALA_PG_SUPERPASSWORD       -  postgres superuser password (default: postgres)
  TALA_PG_INSTALLER_PATH      -  full path to an EDB .exe installer (optional;
                                used instead of winget when provided)

Exit codes:
  0  -  Provisioning succeeded (or was already complete).
  1  -  Fatal error that must be resolved before the app can use the DB.
#>

param()

$ErrorActionPreference = "Stop"

# -----------------------------------------------------------------------
# Logging helpers  -  consistent with bootstrap.ps1 style
# -----------------------------------------------------------------------
function PG-Ok { param($msg) Write-Host "      [OK] $msg"    -ForegroundColor Green }
function PG-Info { param($msg) Write-Host "      $msg" }
function PG-Warn { param($msg) Write-Host "      [WARN] $msg"  -ForegroundColor Yellow }
function PG-Fail { param($msg) Write-Host "      [ERROR] $msg" -ForegroundColor Red }

# -----------------------------------------------------------------------
# 0. Skip if caller supplies an external DB connection string
# -----------------------------------------------------------------------
if ($env:TALA_DB_CONNECTION_STRING) {
    PG-Ok "TALA_DB_CONNECTION_STRING is set  -  skipping local PostgreSQL provisioning."
    exit 0
}

# -----------------------------------------------------------------------
# Resolve configuration with env overrides
# -----------------------------------------------------------------------
$DbHost = if ($env:TALA_DB_HOST) { $env:TALA_DB_HOST }          else { "localhost" }
$DbPort = if ($env:TALA_DB_PORT) { $env:TALA_DB_PORT }          else { "5432" }
$DbName = if ($env:TALA_DB_NAME) { $env:TALA_DB_NAME }          else { "tala" }
$DbUser = if ($env:TALA_DB_USER) { $env:TALA_DB_USER }          else { "tala" }
$DbPassword = if ($env:TALA_DB_PASSWORD) { $env:TALA_DB_PASSWORD }      else { "tala" }
$AdminPass = if ($env:TALA_PG_SUPERPASSWORD) { $env:TALA_PG_SUPERPASSWORD } else { "postgres" }
$AdminUser = "postgres"

# Validate identifier-type overrides against a safe pattern (alphanumeric + underscore)
# to prevent shell/SQL injection via env vars before they are embedded in psql commands.
$SafeIdPattern = '^[A-Za-z_][A-Za-z0-9_]{0,62}$'
foreach ($pair in @(
        @{ Name = "TALA_DB_NAME (resolved: '$DbName')"; Value = $DbName },
        @{ Name = "TALA_DB_USER (resolved: '$DbUser')"; Value = $DbUser }
    )) {
    if ($pair.Value -notmatch $SafeIdPattern) {
        PG-Fail "$($pair.Name) is not a valid PostgreSQL identifier."
        PG-Fail "Allowed: letters, digits, underscores; must start with a letter or underscore; max 63 chars."
        exit 1
    }
}

PG-Info "PostgreSQL target: ${DbHost}:${DbPort}  db=$DbName  user=$DbUser"

# -----------------------------------------------------------------------
# Helper: find psql.exe  -  checks PATH then common EDB install dirs
# -----------------------------------------------------------------------
function Find-Psql {
    $inPath = Get-Command psql -ErrorAction SilentlyContinue
    if ($inPath) { return $inPath.Source }

    $bases = @(
        "${env:ProgramFiles}\PostgreSQL",
        "${env:ProgramFiles(x86)}\PostgreSQL",
        "C:\Program Files\PostgreSQL",
        "C:\Program Files (x86)\PostgreSQL"
    )
    foreach ($base in $bases) {
        if (-not (Test-Path $base)) { continue }
        $versions = Get-ChildItem -Path $base -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d+' } |
        Sort-Object { [int]($_.Name -replace '[^\d].*', '') } -Descending
        foreach ($ver in $versions) {
            $candidate = Join-Path $ver.FullName "bin\psql.exe"
            if (Test-Path $candidate) { return $candidate }
        }
    }
    return $null
}

# -----------------------------------------------------------------------
# Helper: run psql with explicit password, capture output + exit code
# Uses $Script:PsqlCode for the exit code (PowerShell functions lose
# $LASTEXITCODE on return).
# -----------------------------------------------------------------------
$Script:PsqlCode = 0

function Invoke-Psql {
    param(
        [string]$Sql,
        [string]$Database = "postgres",
        [string]$User = $AdminUser,
        [string]$Pass = $AdminPass
    )
    $old = $env:PGPASSWORD
    $env:PGPASSWORD = $Pass
    $out = & $Script:PsqlExe -h $DbHost -p $DbPort -U $User -d $Database `
        -c $Sql -t -A -X 2>&1
    $Script:PsqlCode = $LASTEXITCODE
    $env:PGPASSWORD = $old
    return $out
}

# -----------------------------------------------------------------------
# 1. Detect PostgreSQL installation
# -----------------------------------------------------------------------
PG-Info "Detecting PostgreSQL..."

$Script:PsqlExe = Find-Psql
$pgService = $null
$pgServices = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue
if ($pgServices) {
    # Prefer an already-running service; fall back to any found service
    $pgService = $pgServices |
    Sort-Object { if ($_.Status -eq 'Running') { 0 } else { 1 } } |
    Select-Object -First 1
    PG-Info "PostgreSQL service found: '$($pgService.Name)' (Status: $($pgService.Status))"
}

$pgInstalled = ($null -ne $Script:PsqlExe) -or ($null -ne $pgService)
if ($pgInstalled) {
    if ($Script:PsqlExe) { PG-Ok "psql found: $($Script:PsqlExe)" }
    else { PG-Info "psql not yet in PATH; service detected." }
}

# -----------------------------------------------------------------------
# 2. Install PostgreSQL if not found
# -----------------------------------------------------------------------
if (-not $pgInstalled) {
    PG-Info "PostgreSQL not detected. Attempting installation..."

    # --- Option A: local installer override ---
    $localInstaller = $env:TALA_PG_INSTALLER_PATH
    if ($localInstaller -and (Test-Path $localInstaller)) {
        PG-Info "Using local installer: $localInstaller"
        $installArgs = @(
            "--mode", "unattended",
            "--superpassword", $AdminPass,
            "--servicename", "postgresql",
            "--servicepassword", "postgres",
            "--serverport", $DbPort
        )
        Start-Process -FilePath $localInstaller -ArgumentList $installArgs -Wait -NoNewWindow
        PG-Ok "Installer completed."

    }
    else {
        # --- Option B: winget ---
        $wingetExe = Get-Command winget -ErrorAction SilentlyContinue
        if (-not $wingetExe) {
            PG-Fail "PostgreSQL is not installed and winget is not available on this machine."
            PG-Fail "To resolve, choose one of:"
            PG-Fail "  1. Install PostgreSQL manually: https://www.postgresql.org/download/windows/"
            PG-Fail "     Then re-run: .\bootstrap.ps1"
            PG-Fail "  2. Set TALA_PG_INSTALLER_PATH to a downloaded EDB .exe installer."
            PG-Fail "  3. Use Docker: npm run memory:up  (requires Docker Desktop)"
            exit 1
        }

        PG-Info "Installing PostgreSQL via winget (this may take a few minutes)..."
        PG-Info "NOTE: Installation may require administrator privileges."
        PG-Info "      If this fails, re-run PowerShell as Administrator and try again."

        # EDB.PostgreSQL.16 is the winget package for PostgreSQL 16 (from EnterpriseDB).
        # We pass --override to set the superuser password and port in unattended mode.
        # NOTE: passing the password via --override embeds it in the command line, which
        # may be visible in process listings during the install. This is a known limitation
        # of the EDB unattended installer on Windows. The password is the local bootstrap
        # superuser password (TALA_PG_SUPERPASSWORD), not the app's own password.
        $overrideArgs = "--mode unattended --superpassword $AdminPass --serverport $DbPort"
        winget install --id EDB.PostgreSQL.16 --silent `
            --accept-source-agreements --accept-package-agreements `
            --override $overrideArgs 2>&1 | ForEach-Object { PG-Info $_ }

        # winget exit 0 = success; -1978335135 (0x8A150021) = already installed (also fine)
        $wec = $LASTEXITCODE
        if ($wec -ne 0 -and $wec -ne -1978335135) {
            PG-Fail "winget install returned exit code $wec."
            PG-Fail "Possible causes: not running as Administrator, no internet, package unavailable."
            PG-Fail "Manual install: https://www.postgresql.org/download/windows/"
            PG-Fail "After installing, re-run: .\bootstrap.ps1"
            exit 1
        }
        PG-Ok "PostgreSQL installed via winget."
    }

    # Refresh PATH for this process so pg_* tools become available
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
    [System.Environment]::GetEnvironmentVariable("Path", "User")

    $Script:PsqlExe = Find-Psql
    if (-not $Script:PsqlExe) {
        PG-Fail "psql.exe not found after installation."
        PG-Fail "The PATH may need to be refreshed. Try:"
        PG-Fail "  1. Close and re-open PowerShell."
        PG-Fail "  2. Re-run: .\bootstrap.ps1"
        exit 1
    }
    PG-Ok "psql available: $($Script:PsqlExe)"

    # Refresh service reference after installation
    $pgServices = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue
    if ($pgServices) {
        $pgService = $pgServices |
        Sort-Object { if ($_.Status -eq 'Running') { 0 } else { 1 } } |
        Select-Object -First 1
    }
}
else {
    PG-Ok "PostgreSQL already installed."
}

# -----------------------------------------------------------------------
# 3. Ensure PostgreSQL service is running
# -----------------------------------------------------------------------
if ($pgService) {
    if ($pgService.Status -ne 'Running') {
        PG-Info "Starting PostgreSQL service '$($pgService.Name)'..."
        try {
            Start-Service -Name $pgService.Name -ErrorAction Stop
            Start-Sleep -Seconds 3
            $pgService.Refresh()
        }
        catch {
            PG-Fail "Could not start service '$($pgService.Name)': $_"
            PG-Fail "Try manually:"
            PG-Fail "  Start-Service '$($pgService.Name)'"
            PG-Fail "  -- or open services.msc and start it from there."
            exit 1
        }
    }

    if ($pgService.Status -eq 'Running') {
        PG-Ok "PostgreSQL service '$($pgService.Name)' is running."
    }
    else {
        PG-Fail "Service '$($pgService.Name)' did not reach Running state (current: $($pgService.Status))."
        exit 1
    }
} else {
    # No Windows service found  -  verify TCP reachability before proceeding
}
else {
    # No Windows service found — verify TCP reachability before proceeding
    PG-Warn "No PostgreSQL Windows service detected."
    PG-Info "Checking TCP reachability at ${DbHost}:${DbPort}..."
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $connect = $tcp.BeginConnect($DbHost, [int]$DbPort, $null, $null)
        $ok = $connect.AsyncWaitHandle.WaitOne(3000)
        $tcp.Close()
        if (-not $ok) { throw "timeout" }
        PG-Ok "PostgreSQL is reachable at ${DbHost}:${DbPort}."
    }
    catch {
        PG-Fail "PostgreSQL is not reachable at ${DbHost}:${DbPort} and no service was found."
        PG-Fail "Ensure PostgreSQL is running, then re-run: .\bootstrap.ps1"
        exit 1
    }
}

# -----------------------------------------------------------------------
# 4. Create tala role if missing
# -----------------------------------------------------------------------
PG-Info "Checking role '$DbUser'..."

$roleOut = Invoke-Psql -Sql "SELECT 1 FROM pg_roles WHERE rolname='$DbUser';"
if ($Script:PsqlCode -ne 0) {
    PG-Fail "Could not query pg_roles (psql exit $($Script:PsqlCode))."
    PG-Fail "Check that the PostgreSQL superuser password is correct."
    PG-Fail "Override with: `$env:TALA_PG_SUPERPASSWORD = 'your-password'  then re-run bootstrap."
    exit 1
}

if (($roleOut -join "").Trim() -eq "1") {
    PG-Ok "Role '$DbUser' already exists."
}
else {
    PG-Info "Creating role '$DbUser'..."
    # NOTE: psql -c does not support parameterized queries, so the password is embedded
    # directly in the SQL string. PostgreSQL logs DDL statements (CREATE ROLE) at log_min_
    # duration_statement and log_connections levels, which may capture it. For a local
    # development bootstrap this is acceptable; do not use production credentials here.
    $createRole = Invoke-Psql -Sql "CREATE ROLE $DbUser WITH LOGIN PASSWORD '$DbPassword' CREATEDB;"
    if ($Script:PsqlCode -ne 0) {
        # Re-check in case of a benign race
        $recheck = Invoke-Psql -Sql "SELECT 1 FROM pg_roles WHERE rolname='$DbUser';"
        if (($recheck -join "").Trim() -ne "1") {
            PG-Fail "Failed to create role '$DbUser'."
            PG-Fail "Manual fix:"
            PG-Fail "  psql -U postgres -c `"CREATE ROLE $DbUser WITH LOGIN PASSWORD '$DbPassword' CREATEDB;`""
            exit 1
        }
    }
    PG-Ok "Role '$DbUser' created."
}

# -----------------------------------------------------------------------
# 5. Create tala database if missing
# -----------------------------------------------------------------------
PG-Info "Checking database '$DbName'..."

$dbOut = Invoke-Psql -Sql "SELECT 1 FROM pg_database WHERE datname='$DbName';"
if ($Script:PsqlCode -ne 0) {
    PG-Fail "Could not query pg_database (psql exit $($Script:PsqlCode))."
    exit 1
}

if (($dbOut -join "").Trim() -eq "1") {
    PG-Ok "Database '$DbName' already exists."
}
else {
    PG-Info "Creating database '$DbName' owned by '$DbUser'..."
    $createDb = Invoke-Psql -Sql "CREATE DATABASE $DbName OWNER $DbUser;"
    if ($Script:PsqlCode -ne 0) {
        $recheck = Invoke-Psql -Sql "SELECT 1 FROM pg_database WHERE datname='$DbName';"
        if (($recheck -join "").Trim() -ne "1") {
            PG-Fail "Failed to create database '$DbName'."
            PG-Fail "Manual fix:"
            PG-Fail "  psql -U postgres -c `"CREATE DATABASE $DbName OWNER $DbUser;`""
            exit 1
        }
    }
    PG-Ok "Database '$DbName' created, owned by '$DbUser'."
}

# -----------------------------------------------------------------------
# 6. Verify / enable pgvector
# -----------------------------------------------------------------------
PG-Info "Enabling pgvector extension in '$DbName'..."

# Helper: attempt CREATE EXTENSION IF NOT EXISTS vector as the app user.
# Stores output in $Script:VecErrText; returns $true on success.
$Script:VecErrText = ""
function Try-EnableVectorExtension {
    if (-not $Script:PsqlExe) { return $false }
    $old = $env:PGPASSWORD
    $env:PGPASSWORD = $DbPassword
    $out = & $Script:PsqlExe -h $DbHost -p $DbPort -U $DbUser -d $DbName `
        -c "CREATE EXTENSION IF NOT EXISTS vector;" -t -A -X 2>&1
    $code = $LASTEXITCODE
    $env:PGPASSWORD = $old
    $Script:VecErrText = ($out -join " ")
    return ($code -eq 0)
}

# Quick probe: already enabled? (avoids DDL noise if already present)
# Treat a probe failure as "not yet enabled"  -  Try-EnableVectorExtension will
# expose the real error if the extension truly cannot be created.
$extProbeAlreadyEnabled = $false
$extProbe = Invoke-Psql -Sql "SELECT 1 FROM pg_extension WHERE extname = 'vector';" `
    -Database $DbName -User $DbUser -Pass $DbPassword
if ($Script:PsqlCode -eq 0 -and ($extProbe -join "").Trim() -eq "1") {
    $extProbeAlreadyEnabled = $true
}

if ($extProbeAlreadyEnabled) {
    PG-Ok "pgvector extension already enabled in '$DbName'."
}
elseif (Try-EnableVectorExtension) {
    PG-Ok "pgvector extension is enabled in database '$DbName'."
}
else {
    $errText = $Script:VecErrText
    $filesMissing = $errText -match "control file" -or
    $errText -match "No such file" -or
    $errText -match "could not open"

    if ($filesMissing -and $Script:PsqlExe) {
        # --- Attempt automatic installation via helper script ---
        PG-Info "pgvector extension files missing  -  attempting automatic installation..."
        PG-Info "pgvector extension files missing - attempting automatic installation..."
        $pgvHelper = Join-Path $PSScriptRoot "install-pgvector-windows.ps1"

        if (-not (Test-Path $pgvHelper)) {
            PG-Warn "install-pgvector-windows.ps1 not found at: $pgvHelper"
            PG-Warn "Cannot attempt automatic pgvector installation."
        }
        else {
            & $pgvHelper -PsqlExe $Script:PsqlExe -RepoRoot (Split-Path $PSScriptRoot -Parent)
            $installCode = $LASTEXITCODE

            if ($installCode -eq 0) {
                # Files are now in place  -  retry enabling the extension
                PG-Info "pgvector files installed  -  retrying CREATE EXTENSION..."
                # Files are now in place - retry enabling the extension
                PG-Info "pgvector files installed - retrying CREATE EXTENSION..."
                if (Try-EnableVectorExtension) {
                    PG-Ok "pgvector extension is enabled in database '$DbName'."
                }
                else {
                    PG-Warn "CREATE EXTENSION still failed after bundle installation."
                    PG-Warn "Error: $($Script:VecErrText)"
                    PG-Warn "This may require a PostgreSQL service restart to load the new library."
                    PG-Warn "Try:"
                    PG-Warn "  Restart-Service -Name postgresql*  (as Administrator)"
                    PG-Warn "  Then re-run: .\bootstrap.ps1"
                    PG-Warn "Memory store will run in degraded mode until pgvector is available."
                }
            }
            else {
                # Helper reported failure; it already printed detailed diagnostics
                PG-Warn "Automatic pgvector installation did not complete."
                PG-Warn ""
                PG-Warn "To install pgvector manually, place a prebuilt bundle in:"
                PG-Warn "  installers\pgvector\windows\postgres-<version>\"
                PG-Warn "Required files: vector.dll, vector.control, vector--*.sql"
                PG-Warn "(Download from https://github.com/pgvector/pgvector/releases)"
                PG-Warn ""
                PG-Warn "Or use the Docker stack which includes pgvector:"
                PG-Warn "  npm run memory:up"
                PG-Warn ""
                PG-Warn "After resolving, re-run: .\bootstrap.ps1"
                PG-Warn "Memory store will run in degraded mode until pgvector is available."
            }
        }
    }
    else {
        PG-Warn "pgvector extension could not be enabled: $errText"
        PG-Warn "Memory store may run in degraded mode."
    }
    # Not fatal  -  the app handles degraded mode gracefully.
    # Not fatal - the app handles degraded mode gracefully.
}

# -----------------------------------------------------------------------
# 7. Summary
# -----------------------------------------------------------------------
Write-Host ""
PG-Ok "PostgreSQL provisioning complete."
PG-Info "  Host:      ${DbHost}:${DbPort}"
PG-Info "  Database:  $DbName"
PG-Info "  App user:  $DbUser"
PG-Info "  Schema creation is deferred to Tala's migration runner on first app startup."
Write-Host ""
