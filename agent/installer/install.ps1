param(
  [string]$ServerIp,
  [string]$CncIp,
  [string]$BaseUrl,
  [string]$Token,
  [string]$MachineId,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$programFiles = if (${env:ProgramFiles(x86)}) { ${env:ProgramFiles(x86)} } else { $env:ProgramFiles }
$installDir = Join-Path $programFiles "CncAgent"
$taskName = "CncAgent"

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  $forward = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$($MyInvocation.MyCommand.Path)`"")
  if ($ServerIp) { $forward += @("-ServerIp", $ServerIp) }
  if ($CncIp) { $forward += @("-CncIp", $CncIp) }
  if ($BaseUrl) { $forward += @("-BaseUrl", "`"$BaseUrl`"") }
  if ($Token) { $forward += @("-Token", "`"$Token`"") }
  if ($MachineId) { $forward += @("-MachineId", "`"$MachineId`"") }
  if ($Quiet) { $forward += "-Quiet" }
  Start-Process powershell -Verb RunAs -ArgumentList $forward -Wait
  exit
}
. (Join-Path $here "network.ps1")

function Ask([string]$label, [string]$default) {
  if ($Quiet) { return $default }
  $answer = Read-Host "$label [$default]"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer.Trim()
}

function Read-Json([string]$path) {
  $result = @{}
  if (-not (Test-Path $path)) { return $result }
  $parsed = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($p in $parsed.PSObject.Properties) { $result[$p.Name] = $p.Value }
  return $result
}

Write-Host ""
Write-Host "Установка агента фрезерного станка (Syntec)" -ForegroundColor Cyan
Write-Host ""

Write-Host "Шаг 1. Компоненты Windows" -ForegroundColor Cyan
$release = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" -ErrorAction SilentlyContinue).Release
if (-not $release -or $release -lt 528040) {
  $ndp = Get-ChildItem (Join-Path $here "redist") -Filter "ndp48*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $ndp) { throw "Нужен .NET Framework 4.8. Положите автономный установщик ndp48-x86-x64-allos-enu.exe в папку redist на флешке и запустите снова." }
  Write-Host "Ставлю .NET Framework 4.8 (несколько минут)..."
  $p = Start-Process $ndp.FullName -ArgumentList "/q /norestart" -Wait -PassThru
  if ($p.ExitCode -eq 3010) { Write-Host "После установки нужна перезагрузка. Перезагрузите компьютер и запустите установку ещё раз." -ForegroundColor Yellow; exit }
  if ($p.ExitCode -ne 0) { throw ".NET Framework 4.8 не установился (код $($p.ExitCode))" }
}
Write-Host ".NET Framework 4.8 есть" -ForegroundColor Green

$vc80 = Get-ChildItem "$env:windir\WinSxS" -Directory -Filter "x86_microsoft.vc80.crt_1fc8b3b9a1e18e3b_*" -ErrorAction SilentlyContinue
if (-not $vc80) {
  $vc = Join-Path $here "redist\vcredist2005_x86.exe"
  if (-not (Test-Path $vc)) { throw "Нужен Microsoft Visual C++ 2005 SP1 (x86): файл redist\vcredist2005_x86.exe не найден на флешке." }
  Write-Host "Ставлю Microsoft Visual C++ 2005 SP1 (x86)..."
  $p = Start-Process $vc -ArgumentList "/q" -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "Visual C++ 2005 не установился (код $($p.ExitCode))" }
}
Write-Host "Visual C++ 2005 (x86) есть" -ForegroundColor Green

$configPath = Join-Path $installDir "cnc-agent.json"
$settings = Read-Json (Join-Path $here "cnc-agent.json")
foreach ($entry in (Read-Json $configPath).GetEnumerator()) { $settings[$entry.Key] = $entry.Value }
if (-not $settings.MachineId) { $settings.MachineId = "velber-1" }
if (-not $settings.Link) { $settings.Link = "syntec" }

Write-Host ""
Write-Host "Шаг 2. Сеть станков (без интернета)" -ForegroundColor Cyan
$defaultServer = "192.168.50.1"
$knownUrl = if ($BaseUrl) { $BaseUrl } else { $settings.BaseUrl }
if ($knownUrl) { try { $defaultServer = ([Uri]$knownUrl).Host } catch {} }
if (-not $ServerIp) { $ServerIp = Ask "IP-адрес сервера очереди" $defaultServer }
if (-not (Test-Ipv4 $ServerIp)) { throw "Неверный IP-адрес сервера: $ServerIp" }

$near = Find-AddressNear $ServerIp
if ($near) {
  Write-Host ("Адрес этого компьютера в сети станков: {0} (адаптер {1})" -f $near.IPAddress, $near.InterfaceAlias) -ForegroundColor Green
} else {
  Write-Host "У компьютера нет адреса в сети сервера $ServerIp — зададим его сейчас." -ForegroundColor Yellow
  $adapter = if ($Quiet) { Get-WiredAdapters | Where-Object Status -eq "Up" | Select-Object -First 1 } else { Select-WiredAdapter }
  if (-not $adapter) { throw "Не найден подключённый проводной адаптер" }
  $myIp = Ask "IP-адрес этого компьютера" (Find-FreeAddress $ServerIp 2 19)
  if (-not (Test-Ipv4 $myIp)) { throw "Неверный IP-адрес: $myIp" }
  Set-StaticAddress $adapter $myIp 24
}

$defaultCnc = if ($settings.CncIp) { $settings.CncIp } else { (($ServerIp.Split(".")[0..2]) -join ".") + ".20" }
if (-not $CncIp) { $CncIp = Ask "IP-адрес стойки ЧПУ (как задан на стойке в настройках сети)" $defaultCnc }
if (-not (Test-Ipv4 $CncIp)) { throw "Неверный IP-адрес стойки: $CncIp" }
if (Test-Connection -ComputerName $CncIp -Count 2 -Quiet -ErrorAction SilentlyContinue) {
  Write-Host "Стойка $CncIp отвечает на ping" -ForegroundColor Green
} else {
  Write-Host "Стойка $CncIp не отвечает на ping: проверьте кабель и адрес на стойке." -ForegroundColor Yellow
}
if (Test-TcpPort $CncIp 5566) {
  Write-Host "Remote API стойки открыт (порт 5566)" -ForegroundColor Green
} else {
  Write-Host "Порт 5566 стойки закрыт: на стойке включите сервер Remote API (Core server) — см. ИНСТРУКЦИЯ.txt. Агент будет подключаться сам, когда он заработает." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Шаг 3. Агент" -ForegroundColor Cyan
if (-not $BaseUrl -or ([Uri]$BaseUrl).Host -ne $ServerIp) { $BaseUrl = "http://${ServerIp}:3221" }
if (-not $Token) { $Token = Ask "Ключ агента" "$($settings.Token)" }
if (-not $MachineId) { $MachineId = Ask "Имя станка (латиницей, так он будет виден в вебе)" $settings.MachineId }
$BaseUrl = $BaseUrl.TrimEnd("/")
if (-not $Token -or -not $MachineId) { throw "Ключ агента и имя станка обязательны" }

Get-Process -Name "CncAgent" -ErrorAction SilentlyContinue | Stop-Process -Force
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
foreach ($old in @("MMICommon32.dll", "OCAPI.dll", "OCKrnl.dll", "OCKrnlDrv.dll", "OCUser.dll", "Syntec.OpenCNC.dll", "Syntec.RemoteCNC.dll", "Syntec.RemoteObj.dll")) {
  Remove-Item (Join-Path $installDir $old) -Force -ErrorAction SilentlyContinue
}
Get-ChildItem (Join-Path $here "agent") | Where-Object Name -ne "cnc-agent.json" | Copy-Item -Destination $installDir -Recurse -Force

$settings.BaseUrl = $BaseUrl
$settings.Token = $Token
$settings.MachineId = $MachineId
$settings.CncIp = $CncIp
$ordered = [ordered]@{}
foreach ($key in ($settings.Keys | Sort-Object)) { $ordered[$key] = $settings[$key] }
[IO.File]::WriteAllText($configPath, ($ordered | ConvertTo-Json -Depth 3), (New-Object Text.UTF8Encoding($false)))

$exe = Join-Path $installDir "CncAgent.exe"
foreach ($direction in "Inbound", "Outbound") {
  $name = "CncAgent $direction"
  Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
  New-NetFirewallRule -DisplayName $name -Direction $direction -Action Allow -Program $exe -Profile Any | Out-Null
}

Write-Host "Проверяю связь с сервером..."
try {
  $probe = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Headers @{ Authorization = "Bearer $Token" } -Uri "$BaseUrl/agent/jobs?machineId=$([Uri]::EscapeDataString($MachineId))"
  Write-Host "Сервер отвечает ($($probe.StatusCode))" -ForegroundColor Green
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  if ($status -eq 401) { Write-Host "Сервер отклонил ключ агента. Проверьте ключ." -ForegroundColor Red }
  else { Write-Host "Сервер недоступен: $($_.Exception.Message). Агент будет подключаться сам." -ForegroundColor Yellow }
}

Write-Host "Проверяю стойку (до 40 секунд)..."
& $exe --check $configPath | ForEach-Object { Write-Host "  $_" }

$action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $installDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$taskSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $taskSettings -Description "Агент очереди фрезерного станка (Syntec)" | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 5

Write-Host ""
if (Get-Process -Name "CncAgent" -ErrorAction SilentlyContinue) {
  Write-Host "Готово. Агент работает в фоне и запускается сам при включении компьютера (вход в Windows не нужен)." -ForegroundColor Green
} else {
  Write-Host "Агент установлен, но не запустился. Журнал: $installDir\cnc-agent.log" -ForegroundColor Red
}
Write-Host "Станок: $MachineId, стойка $CncIp"
Write-Host "Сервер: $BaseUrl"
Write-Host "Папка агента и журнал: $installDir"
