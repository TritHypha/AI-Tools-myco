# run-review.ps1 - run `myco run-all` inside WSL and (optionally) toast on FAIL.
# Runs in the foreground of the visible scheduled task window; nothing is hidden.
# Exit code is run-all's: 0 PASS, 1 WARN, 2 FAIL.
param(
  [Parameter(Mandatory = $true)][string]$RepoWsl,     # WSL path of the myco checkout, e.g. /mnt/c/Users/me/GitHub/myco
  [Parameter(Mandatory = $true)][string]$ConfigWsl,   # WSL path of the repos config JSON
  [string]$NodeWsl = '~/.nvm/versions/node/v24.18.0/bin/node',
  [switch]$Toast
)
$ErrorActionPreference = 'Stop'
Write-Host "myco run-all  $(Get-Date -Format s)  repo=$RepoWsl  config=$ConfigWsl"
$cmd = "cd '$RepoWsl' && $NodeWsl --experimental-strip-types --no-warnings src/cli.ts run-all --config '$ConfigWsl'"
& wsl.exe -e bash -lc $cmd
$code = $LASTEXITCODE
Write-Host "myco run-all exit code $code (0 PASS, 1 WARN, 2 FAIL)"
if ($Toast -and $code -ge 2) {
  $title = 'myco review: FAIL'
  $body = "run-all exited $code. See the status.md in the config's out folder."
  if (Get-Module -ListAvailable -Name BurntToast) {
    Import-Module BurntToast
    New-BurntToastNotification -Text $title, $body
  } else {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual></toast>")
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
  }
}
exit $code
