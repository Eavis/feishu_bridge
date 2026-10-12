param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$TaskName = 'Feishu Bridge PM2 Watchdog',
  [int]$HealthPort = 59991,
  [switch]$AtLogonOnly
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$watchdog = Join-Path $ProjectRoot 'scripts\windows-watchdog.ps1'
$pm2 = (Get-Command pm2.cmd -ErrorAction Stop).Source
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ProjectRoot "{1}" -Pm2Command "{2}" -HealthPort {3}' -f $watchdog, $ProjectRoot, $pm2, $HealthPort
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments -WorkingDirectory $ProjectRoot
$triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $user),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5))
)
$logonType = 'Interactive'
if (-not $AtLogonOnly) {
  $triggers += New-ScheduledTaskTrigger -AtStartup
  $logonType = 'S4U'
}
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType $logonType -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  $backupDir = Join-Path $ProjectRoot '.bridge\runtime'
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath (Join-Path $backupDir ('watchdog-before-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.xml')) -Encoding UTF8
}
# Registration errors propagate, leaving the prior task in place. Never silently
# downgrade unattended startup to a task that depends on an interactive login.
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed $TaskName for $user (LogonType=$logonType)."
if ($AtLogonOnly) {
  Write-Warning 'This task cannot run before the user logs in after a reboot.'
} else {
  Write-Output 'Boot recovery is configured. Validate it after a planned reboot; S4U cannot use Windows network credentials or encrypted files.'
}
