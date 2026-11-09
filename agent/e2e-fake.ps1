# End-to-end check of server + CncAgent with the fake controller.
#   .\e2e-fake.ps1 -SiteUrl http://127.0.0.1:3211 -Token cnc-stand-dev
param(
    [string]$SiteUrl = "http://127.0.0.1:3221",
    [string]$Token = "cnc-stand-dev",
    [string]$Program = "$PSScriptRoot\..\..\chpu-driver\БРЕНД АРДЕКО\860\Ard_LIC_L_86-1_10mm.cnc",
    [string]$AgentDir = "$PSScriptRoot\publish\CncAgent"
)
$ErrorActionPreference = "Stop"
$headers = @{ Authorization = "Bearer $Token" }
$machineId = "e2e-fake"

function Api([string]$method, [string]$path, $body) {
    $request = @{ Method = $method; Uri = "$SiteUrl$path"; Headers = $headers }
    if ($body) { $request.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress)); $request.ContentType = "application/json" }
    Invoke-RestMethod @request
}

function Job([string]$id) { (Api GET "/api/jobs?all=1").jobs | Where-Object { $_._id -eq $id } }

function WaitFor([string]$what, [scriptblock]$ok, [int]$sec = 60) {
    $until = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $until) {
        $job = Job $script:jobId
        if (& $ok $job) { Write-Host "  ok: $what (статус $($job.status), сделано $($job.qtyDone)/$($job.qtyPlanned))"; return }
        Start-Sleep -Milliseconds 700
    }
    throw "не дождались: $what (статус $($job.status), сделано $($job.qtyDone))"
}

$work = Join-Path $env:TEMP "cnc-e2e"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
Copy-Item $AgentDir $work -Recurse
@{
    BaseUrl = $SiteUrl; Token = $Token; MachineId = $machineId; Link = "fake"
    PollSec = 1; AutoSelectMain = $true; DeliverAhead = 3; FakeLinesPerSec = 400
} | ConvertTo-Json | Set-Content (Join-Path $work "cnc-agent.json") -Encoding ASCII
$control = Join-Path $work "fake-control.txt"
function Operator([string]$command) { Write-Host "  оператор: $command"; Set-Content $control $command -Encoding UTF8 }

foreach ($old in (Api GET "/api/jobs").jobs | Where-Object { $_.machineId -eq $machineId }) {
    Api POST "/api/jobs/cancel" @{ jobId = $old._id } | Out-Null
}

Write-Host "1. Загрузка программы"
$name = [IO.Path]::GetFileName($Program)
$up = Invoke-RestMethod -Method POST -Headers $headers -InFile $Program -ContentType "text/plain" `
    -Uri "$SiteUrl/api/programs?fileName=$([uri]::EscapeDataString($name))&folder=$([uri]::EscapeDataString('e2e'))"
Write-Host "  programId $($up.programId) (дубликат: $($up.duplicate))"

Write-Host "2. Задача на 2 детали"
$script:jobId = (Api POST "/api/jobs" @{ programId = $up.programId; qty = 2; machineId = $machineId; note = "e2e" }).jobId

Write-Host "3. Запуск агента"
$agent = Start-Process (Join-Path $work "CncAgent.exe") -WorkingDirectory $work -PassThru -WindowStyle Hidden
try {
    WaitFor "программа доставлена и выбрана основной" { param($j) $j.status -eq "loaded" }

    Write-Host "4. Цикл с остановкой посередине"
    Operator "start"
    WaitFor "цикл начат" { param($j) $j.status -eq "in_progress" }
    Operator "stop"
    WaitFor "после стопа задача снова загружена, деталей 0" { param($j) $j.status -eq "loaded" -and $j.qtyDone -eq 0 }

    Write-Host "5. Два полных цикла"
    Operator "start"
    WaitFor "первая деталь" { param($j) $j.qtyDone -eq 1 -and $j.status -eq "loaded" } 120
    Operator "start"
    WaitFor "задача выполнена" { param($j) $j.status -eq "done" -and $j.qtyDone -eq 2 } 120

    Write-Host "6. Тревога"
    Operator "alarm E2E тестовая тревога"
    Start-Sleep 4
    $m = (Api GET "/api/machines").machines | Where-Object { $_.machineId -eq $machineId }
    if (-not ($m.alarms -contains "E2E тестовая тревога")) { throw "тревога не дошла до сервера" }
    Write-Host "  ok: тревога видна на сервере, станок online=$($m.online)"
    Operator "clear"

    Write-Host "Прогон пройден"
} finally {
    if (!$agent.HasExited) { Stop-Process $agent -Force }
    Write-Host "Журнал агента:"
    Get-Content (Join-Path $work "cnc-agent.log") -Tail 25 -Encoding UTF8 | ForEach-Object { "  $_" }
}
