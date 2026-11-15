<#
.SYNOPSIS
    AERON Ground Station - Uninstall AERON Bridge Controller Service for Windows
.DESCRIPTION
    Stops any running controller instance and removes the startup shortcut
    and runner scripts from the current user account.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"

Write-Host "==================================================================" -ForegroundColor Yellow
Write-Host "   AERON GROUND CONTROL STATION — CONTROLLER SERVICE UNINSTALLER " -ForegroundColor Yellow
Write-Host "==================================================================" -ForegroundColor Yellow

# 1. Stop any running controller instance
Write-Host "`n[1/3] Terminating active Bridge Controller processes..." -ForegroundColor Yellow

# Try graceful stop via API if possible
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -TimeoutSec 1 -ErrorAction SilentlyContinue
    if ($health -and $health.pid) {
        Write-Host "  Stopping running controller process (PID: $($health.pid))..."
        Stop-Process -Id $health.pid -Force -ErrorAction SilentlyContinue
    }
} catch {}

# Fallback: terminate any python process running aeron_bridge_controller.py
$procs = Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%aeron_bridge_controller.py%'" -ErrorAction SilentlyContinue
if ($procs) {
    foreach ($p in $procs) {
        Write-Host "  Stopping controller process (PID: $($p.ProcessId))..."
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
Write-Host "  OK: Active controller processes stopped." -ForegroundColor Green

# 2. Remove Startup shortcut
Write-Host "`n[2/3] Removing Windows Startup shortcut..." -ForegroundColor Yellow
$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder "AERON-Bridge-Controller.lnk"

if (Test-Path $shortcutPath) {
    Remove-Item $shortcutPath -Force -ErrorAction SilentlyContinue
    Write-Host "  OK: Removed shortcut $shortcutPath" -ForegroundColor Green
} else {
    Write-Host "  OK: No startup shortcut found." -ForegroundColor DarkGray
}

# 3. Clean up user runner files
Write-Host "`n[3/3] Cleaning up runner scripts..." -ForegroundColor Yellow
$userConfigDir = Join-Path $env:USERPROFILE ".aeron"
$vbsPath = Join-Path $userConfigDir "run-aeron-bridge-controller.vbs"

if (Test-Path $vbsPath) {
    Remove-Item $vbsPath -Force -ErrorAction SilentlyContinue
    Write-Host "  OK: Removed $vbsPath" -ForegroundColor Green
}

Write-Host "`n==================================================================" -ForegroundColor Green
Write-Host "   UNINSTALL COMPLETE — AERON BRIDGE CONTROLLER REMOVED           " -ForegroundColor Green
Write-Host "==================================================================`n"

