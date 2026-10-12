$ErrorActionPreference = 'Stop'
$watchdog = Join-Path $PSScriptRoot 'windows-watchdog.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('feishu-watchdog-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$runner = Join-Path $root 'runner.ps1'
$fakePm2 = Join-Path $root 'fake-pm2.ps1'
@'
$file = Join-Path $PSScriptRoot 'state.json'
$state = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
Add-Content -LiteralPath (Join-Path $PSScriptRoot 'calls.txt') -Value ($args -join ' ')
$global:LASTEXITCODE = 0
switch ($args[0]) {
  'pid' { Write-Output $state.bridgePid; if ($state.duplicate) { Write-Output 43 } }
  'startOrRestart' {
    if ($state.startFails) { $global:LASTEXITCODE = 3; return }
    $state.bridgePid = 42
    $state.healthy = -not $state.remainsUnhealthy
    $state | ConvertTo-Json | Set-Content -LiteralPath $file
  }
  'save' { if ($state.saveFails) { $global:LASTEXITCODE = 4 } }
  default { throw "unexpected PM2 command: $($args[0])" }
}
'@ | Set-Content -LiteralPath $fakePm2 -Encoding UTF8
@'
param([string]$Watchdog, [string]$CaseRoot, [string]$FakePm2)
function Start-Sleep {
  param([int]$Seconds)
  $file = Join-Path $CaseRoot 'state.json'
  $state = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  if ($state.transient -and $Seconds -eq 20) {
    $state.healthy = $true
    $state | ConvertTo-Json | Set-Content -LiteralPath $file
  }
}
function Invoke-RestMethod {
  param([string]$Uri, [int]$TimeoutSec)
  $state = Get-Content -LiteralPath (Join-Path $CaseRoot 'state.json') -Raw | ConvertFrom-Json
  $responsePid = $state.bridgePid
  if ($state.wrongPid) { $responsePid = 99 }
  return @{ ok = $state.healthy; pid = $responsePid; ws = @{ state = 'connected' } }
}
& $Watchdog -ProjectRoot $CaseRoot -Pm2Command $FakePm2
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath $runner -Encoding UTF8

$cases = @(
  @{ name='healthy'; bridgePid=42; healthy=$true; expected=0; restores=0 },
  @{ name='missing-or-stopped'; bridgePid=0; healthy=$false; expected=0; restores=1 },
  @{ name='unhealthy'; bridgePid=42; healthy=$false; expected=0; restores=1 },
  @{ name='transient-reconnect'; bridgePid=42; healthy=$false; transient=$true; expected=0; restores=0 },
  @{ name='start-fails'; bridgePid=0; healthy=$false; startFails=$true; expected=1; restores=1 },
  @{ name='recovery-still-unhealthy'; bridgePid=0; healthy=$false; remainsUnhealthy=$true; expected=1; restores=1 },
  @{ name='duplicate'; bridgePid=42; healthy=$true; duplicate=$true; expected=1; restores=0 },
  @{ name='wrong-health-pid'; bridgePid=42; healthy=$true; wrongPid=$true; expected=1; restores=1 },
  @{ name='save-fails'; bridgePid=0; healthy=$false; saveFails=$true; expected=1; restores=1 }
)

try {
  foreach ($case in $cases) {
    $caseRoot = Join-Path $root $case.name
    New-Item -ItemType Directory -Path $caseRoot | Out-Null
    Copy-Item -LiteralPath $fakePm2 -Destination (Join-Path $caseRoot 'fake-pm2.ps1')
    $case | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $caseRoot 'state.json')
    '{}' | Set-Content -LiteralPath (Join-Path $caseRoot 'ecosystem.config.cjs')
    & powershell.exe -NoProfile -NonInteractive -File $runner -Watchdog $watchdog -CaseRoot $caseRoot -FakePm2 (Join-Path $caseRoot 'fake-pm2.ps1')
    $result = $LASTEXITCODE
    $calls = @(Get-Content -LiteralPath (Join-Path $caseRoot 'calls.txt'))
    $restores = @($calls | Where-Object { $_ -like 'startOrRestart *' })
    if ($result -ne $case.expected -or $restores.Count -ne $case.restores) {
      throw "$($case.name) failed: exit=$result, restores=$($restores.Count)"
    }
    if ($restores.Count -and $restores[0] -notlike '*--only feishu-bridge') {
      throw 'recovery must target only feishu-bridge'
    }
    Write-Output "PASS $($case.name)"
  }
} finally {
  $resolvedRoot = [IO.Path]::GetFullPath($root)
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if ($resolvedRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedRoot) -like 'feishu-watchdog-test-*') {
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
  }
}
