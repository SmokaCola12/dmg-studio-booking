<#
Registers (or updates) a Windows Task Scheduler job that runs the backup every day at 04:30.

  powershell -ExecutionPolicy Bypass -File deploy\schedule-backup.ps1            show the plan, ask, then register
  powershell -ExecutionPolicy Bypass -File deploy\schedule-backup.ps1 -WhatIf    show the plan only, change nothing
  powershell -ExecutionPolicy Bypass -File deploy\schedule-backup.ps1 -Remove    remove the job (asks first)

Options:
  -Time 04:30             another time of day (24-hour HH:mm, this PC's clock)
  -WhetherLoggedOnOrNot   also run when nobody is logged on to Windows. Needs PowerShell started with
                          "Run as administrator". Without it the job only runs while this user is logged on.

Running it again is safe: the existing job is replaced, never duplicated. Nothing is registered until you type YES.
#>
param(
  [string]$Time = '04:30',
  [switch]$WhetherLoggedOnOrNot,
  [switch]$Remove,
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'

$taskName = 'DMG Studio Backup'
$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'backup.ps1'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if ($Remove) {
  if (-not $existing) {
    Write-Host "There is no scheduled task named '$taskName'. Nothing to remove."
    exit 0
  }
  Write-Host "This will REMOVE the scheduled task '$taskName'. Existing backups are not touched."
  if ($WhatIf) { Write-Host 'WhatIf: nothing was changed.'; exit 0 }
  if ((Read-Host 'Type YES to remove it') -cne 'YES') { Write-Host 'Cancelled. Nothing was changed.'; exit 0 }
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Removed '$taskName'."
  exit 0
}

if ($Time -notmatch '^([01]\d|2[0-3]):[0-5]\d$') {
  Write-Host '-Time must look like 04:30 (24-hour HH:mm). Nothing was changed.'
  exit 1
}
if (-not (Test-Path -LiteralPath $script)) {
  Write-Host "Cannot find $script. Nothing was changed."
  exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js was not found on PATH. Install it first. Nothing was changed.'
  exit 1
}

$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`""

Write-Host ''
Write-Host 'DMG Studio: daily backup job'
Write-Host '----------------------------'
Write-Host "Task name : $taskName $(if ($existing) { '(already exists: it will be REPLACED)' } else { '(new)' })"
Write-Host "Runs      : every day at $Time, this PC's clock"
Write-Host "Command   : powershell.exe $arguments"
Write-Host "Folder    : $repo"
Write-Host "Runs as   : $user $(if ($WhetherLoggedOnOrNot) { '(whether logged on or not)' } else { '(only while this user is logged on to Windows)' })"
Write-Host 'If missed : runs as soon as the PC is on again; stops after 1 hour; never two at once'
Write-Host 'Backups go to BACKUP_DIR from .env (default: the backups folder in the project).'
Write-Host 'Each run adds a line to backup.log in that folder. Check it now and then.'
Write-Host ''

if ($WhatIf) {
  Write-Host 'WhatIf: nothing was registered.'
  exit 0
}
if ((Read-Host 'Type YES to register this task') -cne 'YES') {
  Write-Host 'Cancelled. Nothing was changed.'
  exit 0
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($Time, 'HH:mm', [cultureinfo]::InvariantCulture))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$logon = if ($WhetherLoggedOnOrNot) { 'S4U' } else { 'Interactive' }
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType $logon -RunLevel Limited

try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Backs up the DMG Studio booking database, gallery photos and payment receipts.' -Force | Out-Null
} catch {
  Write-Host "Could not register the task: $($_.Exception.Message)"
  if ($WhetherLoggedOnOrNot) { Write-Host 'With -WhetherLoggedOnOrNot, start PowerShell with "Run as administrator" and try again.' }
  exit 1
}

Write-Host "Registered '$taskName'."
Write-Host "Try it now :  Start-ScheduledTask -TaskName '$taskName'"
Write-Host "Last result:  (Get-ScheduledTaskInfo -TaskName '$taskName').LastTaskResult   (0 means the backup worked)"
