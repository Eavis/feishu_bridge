param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$Pm2Command = 'pm2.cmd',
  [int]$HealthPort = 59991
)

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $ProjectRoot '.bridge\logs'
$logFile = Join-Path $logDir 'watchdog.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-WatchdogLog([string]$Message) {
  if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 1048576) {
    Move-Item -Force -LiteralPath $logFile -Destination "$logFile.1"
  }
  Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format o) $Message"
}

function Get-BridgePid {
  $raw = & $Pm2Command pid feishu-bridge 2>$null | Out-String
  $matchesFound = [regex]::Matches($raw, '(?m)^[1-9]\d*\s*$')
  if ($matchesFound.Count -gt 1) { throw 'multiple feishu-bridge instances; refusing to restart an ambiguous target' }
  if ($matchesFound.Count -eq 1) { return [int]$matchesFound[0].Value.Trim() }
  return 0
}

function Test-BridgeHealth([int]$ExpectedPid) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$HealthPort/health" -TimeoutSec 10
    return ($ExpectedPid -gt 0 -and $health.ok -eq $true -and [int]$health.pid -eq $ExpectedPid -and $health.ws.state -eq 'connected')
  } catch {
    return $false
  }
}

function Restore-Bridge {
  $ecosystem = Join-Path $ProjectRoot 'ecosystem.config.cjs'
  if (-not (Test-Path -LiteralPath $ecosystem)) { throw "missing ecosystem config: $ecosystem" }
  # resurrect skips a stopped/errored entry if its name is already registered.
  # startOrRestart handles both that case and a missing/empty PM2 dump, and
  # --only prevents restoring unrelated applications from the user's PM2 dump.
  & $Pm2Command startOrRestart $ecosystem --only feishu-bridge 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "pm2 startOrRestart failed (exit $LASTEXITCODE)" }
  Start-Sleep -Seconds 15
  $restoredPid = Get-BridgePid
  if (-not (Test-BridgeHealth $restoredPid)) { throw 'bridge remained unhealthy after recovery' }
  & $Pm2Command save 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "bridge is running, but pm2 save failed (exit $LASTEXITCODE)" }
}

try {
  $pidBefore = Get-BridgePid
  if ($pidBefore -le 0) {
    Write-WatchdogLog 'bridge process missing/stopped; restoring from ecosystem config'
    Restore-Bridge
  } elseif (-not (Test-BridgeHealth $pidBefore)) {
    # Avoid racing the bridge's intentional hourly recycle or a normal SDK
    # reconnect. A persistent failure across the grace period is actionable.
    Start-Sleep -Seconds 20
    if (-not (Test-BridgeHealth (Get-BridgePid))) {
      Write-WatchdogLog 'health probe failed twice; restoring feishu-bridge'
      Restore-Bridge
    }
  }

  Write-WatchdogLog "healthy pid=$(Get-BridgePid)"
  exit 0
} catch {
  Write-WatchdogLog "FAILED: $($_.Exception.Message)"
  exit 1
}
