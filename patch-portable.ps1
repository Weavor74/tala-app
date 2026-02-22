# patch-portable.ps1
# Use this script to update an existing portable folder since 'npm run dist' is failing.

param(
    [Parameter(Mandatory=$true)]
    [string]$PortableFolderPath
)

if (-not (Test-Path $PortableFolderPath)) {
    Write-Error "Portable folder path not found: $PortableFolderPath"
    exit 1
}

$ResourcesPath = Join-Path $PortableFolderPath "resources/app"

if (-not (Test-Path $ResourcesPath)) {
    Write-Error "Could not find 'resources/app' in the portable folder. Ensure this is an unpacked (portable) build."
    exit 1
}

Write-Host "Patching Tala at: $PortableFolderPath..."

# Copy Updated Frontend
Write-Host "Updating dist/..."
Copy-Item -Path "dist/*" -Destination (Join-Path $ResourcesPath "dist") -Recurse -Force

# Copy Updated Electron Logic
Write-Host "Updating dist-electron/..."
Copy-Item -Path "dist-electron/*" -Destination (Join-Path $ResourcesPath "dist-electron") -Recurse -Force

Write-Host "Patch Complete! You can now run Tala.exe from the portable folder." -ForegroundColor Green
