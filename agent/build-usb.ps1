# Builds the USB folder agent\usb\CncAgent: agent binaries + Syntec DLLs, installer scripts,
# VC++ 2005 runtime. Needs agent\lib\syntec and agent\redist (run syntec-libs.ps1 once).
param([string]$SimulatorZip = $env:SYNTEC_SIM_ZIP)
$ErrorActionPreference = "Stop"
$agent = $PSScriptRoot
$out = Join-Path $agent "usb\CncAgent"
$dotnet = Join-Path $agent "..\..\laser-erp\agent\.tools\dotnet\dotnet.exe"
if (-not (Test-Path $dotnet)) { $dotnet = "dotnet" }

if (-not (Test-Path (Join-Path $agent "lib\syntec\OCAPI.dll")) -or -not (Test-Path (Join-Path $agent "redist\vcredist2005_x86.exe")) -or
    -not (Test-Path (Join-Path $agent "lib\syntec-10.118\Syntec.OpenCNC.dll"))) {
  & (Join-Path $agent "syntec-libs.ps1") -SimulatorZip $SimulatorZip
}

$bin = Join-Path $agent "publish\CncAgent"
Remove-Item $bin -Recurse -Force -ErrorAction SilentlyContinue
& $dotnet build (Join-Path $agent "CncAgent\CncAgent.csproj") -c Release -o $bin
if ($LASTEXITCODE -ne 0) { throw "Сборка не удалась" }

Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $out "agent"), (Join-Path $out "redist") | Out-Null
Get-ChildItem $bin | Where-Object { $_.Extension -ne ".pdb" -and $_.Name -notin @("cnc-agent.json", "state.json", "outbox.json") -and $_.Name -notlike "*.log" } |
  Copy-Item -Destination (Join-Path $out "agent") -Recurse
Get-ChildItem (Join-Path $agent "redist") -File | Copy-Item -Destination (Join-Path $out "redist")

$bom = New-Object Text.UTF8Encoding($true)
foreach ($name in @("install.ps1", "uninstall.ps1", "set-ip.ps1", "network.ps1", "ИНСТРУКЦИЯ.txt")) {
  $text = [IO.File]::ReadAllText((Join-Path $agent "installer\$name"))
  [IO.File]::WriteAllText((Join-Path $out $name), $text, $bom)
}
foreach ($name in @("cnc-agent.json", "Установить.cmd", "Удалить.cmd", "Настроить-сеть.cmd", "Проверить-стойку.cmd", "Проверить-передачу.cmd", "ERP-TEST.CNC")) {
  Copy-Item (Join-Path $agent "installer\$name") $out
}

Write-Host "Готово: $out"
Get-ChildItem $out -Recurse -File | ForEach-Object { "{0,-40} {1,10}" -f $_.FullName.Substring($out.Length + 1), $_.Length }
