# register-task.ps1 - register a VISIBLE Windows scheduled task that runs
# run-review.ps1 every 3 hours as the current user (interactive logon: the console
# window is shown, never hidden). Re-running replaces the task. Remove with:
#   Unregister-ScheduledTask -TaskName 'myco review' -Confirm:$false
param(
  [Parameter(Mandatory = $true)][string]$RepoWsl,
  [Parameter(Mandatory = $true)][string]$ConfigWsl,
  [string]$NodeWsl = '~/.nvm/versions/node/v24.18.0/bin/node',
  [string]$TaskName = 'myco review',
  [int]$EveryHours = 3,
  [switch]$Toast
)
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'run-review.ps1'
$argList = "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$runner`" -RepoWsl `"$RepoWsl`" -ConfigWsl `"$ConfigWsl`" -NodeWsl `"$NodeWsl`""
if ($Toast) { $argList += ' -Toast' }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argList
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours $EveryHours)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description "myco run-all + check every $EveryHours h (visible window; exit 0 PASS / 1 WARN / 2 FAIL)" -Force | Out-Null
Get-ScheduledTask -TaskName $TaskName | Format-List TaskName, State
Write-Host "Registered '$TaskName': every $EveryHours h, first run $((Get-Date).AddMinutes(5).ToString('s')). Window stays open (-NoExit) so the result is visible."
