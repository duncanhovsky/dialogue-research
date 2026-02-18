$ErrorActionPreference = 'SilentlyContinue'

$taskName = 'TelegramCopilotBridgeDaemon'

if (Get-ScheduledTask -TaskName $taskName) {
  Stop-ScheduledTask -TaskName $taskName | Out-Null
  Disable-ScheduledTask -TaskName $taskName | Out-Null
  Write-Output "Scheduled task '$taskName' stopped and disabled."
} else {
  Write-Output "Scheduled task '$taskName' not found."
}

Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'node.exe' -and
    $_.CommandLine -match 'dist\\daemon.js' -and
    $_.CommandLine -match 'telegram-bot'
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
    Write-Output "Stopped daemon process PID=$($_.ProcessId)"
  }
