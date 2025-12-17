<#
.SYNOPSIS
    Builds the Electron app for Windows and Linux (via WSL) and collects artifacts.
#>

$ErrorActionPreference = "Stop"

# --- Configuration ---
$ProjectRoot = Get-Location
$DistDir = Join-Path $ProjectRoot "dist"
$OutputFolder = "built files"
$OutputDir = Join-Path $ProjectRoot $OutputFolder
$LinuxScript = "./linuxbuild.sh"

Write-Host ">>> Starting Global Build Process..." -ForegroundColor Cyan

# --- 1. Windows Build ---
Write-Host "`n[1/4] Building for Windows..." -ForegroundColor Yellow
try {
    # This runs electron-builder based on package.json config
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "Windows build command failed." }
}
catch {
    Write-Error "Windows build failed. Exiting."
    exit 1
}

# --- 2. Linux Build (WSL) ---
Write-Host "`n[2/4] Building for Linux (via WSL)..." -ForegroundColor Yellow

# Ensure linuxbuild.sh has Unix line endings (LF) or WSL might complain
Write-Host "   - Normalizing line endings for linuxbuild.sh..."
wsl -e sed -i 's/\r$//' $LinuxScript

try {
    # Run the bash script inside WSL
    wsl -e bash $LinuxScript
    if ($LASTEXITCODE -ne 0) { throw "Linux build script failed." }
}
catch {
    Write-Error "Linux build failed. Exiting."
    exit 1
}

# --- 3. Prepare Output Directory ---
Write-Host "`n[3/4] Preparing output directory..." -ForegroundColor Yellow
if (-not (Test-Path -Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
    Write-Host "   - Created '$OutputFolder' directory."
} else {
    Write-Host "   - '$OutputFolder' directory already exists."
}

# --- 4. Move Artifacts ---
Write-Host "`n[4/4] Moving artifacts..." -ForegroundColor Yellow

# Check if dist directory exists before searching
if (Test-Path -Path $DistDir) {
    # Find .exe and .deb files in the dist folder
    $Artifacts = Get-ChildItem -Path $DistDir -Include *.exe, *.deb, *.AppImage -Recurse

    if ($Artifacts.Count -eq 0) {
        Write-Warning "No .exe or .deb files found in '$DistDir'. Check build logs."
    }

    foreach ($File in $Artifacts) {
        $DestPath = Join-Path $OutputDir $File.Name
        try {
            Move-Item -Path $File.FullName -Destination $DestPath -Force
            Write-Host "   - Moved: $($File.Name)" -ForegroundColor Gray
        }
        catch {
            Write-Error "   - Failed to move $($File.Name): $($_.Exception.Message)"
        }
    }
} else {
    Write-Warning "Dist directory not found. Build likely failed silently."
}

Write-Host "`n[OK] Build Process Complete!" -ForegroundColor Green
Write-Host "Files are located in: $OutputDir"