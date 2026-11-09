$ErrorActionPreference = "Stop"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Start-Process powershell -Verb RunAs -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$($MyInvocation.MyCommand.Path)`"") -Wait
  exit
}

$programFiles = if (${env:ProgramFiles(x86)}) { ${env:ProgramFiles(x86)} } else { $env:ProgramFiles }
Unregister-ScheduledTask -TaskName "CncAgent" -Confirm:$false -ErrorAction SilentlyContinue
Get-Process -Name "CncAgent" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Remove-NetFirewallRule -DisplayName "CncAgent Inbound", "CncAgent Outbound" -ErrorAction SilentlyContinue
Remove-Item (Join-Path $programFiles "CncAgent") -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Агент удалён. Программы в памяти стойки не тронуты." -ForegroundColor Green
