# Downloads the Syntec Remote API v4 DLLs (proprietary, not committed) into agent\lib\syntec
# and the Microsoft VC++ 2005 SP1 x86 runtime they need into agent\redist, verifying SHA-256.
# Extracts the 10.118 Remote API client from the Syntec 10.118 PC simulator archive (CNC520.zip)
# into agent\lib\syntec-10.118; v4 cannot upload files to 10.118 firmware.
# Run on a machine with internet; the result goes to the USB stick via build-usb.ps1.
param([string]$SimulatorZip = $env:SYNTEC_SIM_ZIP)
$ErrorActionPreference = 'Stop'
$base = 'https://raw.githubusercontent.com/JMatveichik/Syntec.TestApp/HEAD/Syntec'
$downloads = @(
    @{ Dir = 'lib\syntec'; Name = 'MMICommon32.dll';      Url = "$base/MMICommon32.dll";      Hash = '7FB4718E3789BA121986504B7B440B405F15B291FB0876155032F432A67B1E68' }
    @{ Dir = 'lib\syntec'; Name = 'OCAPI.dll';            Url = "$base/OCAPI.dll";            Hash = 'C5E5ABAF29DA9F9B9FA1832D2CBC6EC6596E1AC8A0363DD420F331572F304E58' }
    @{ Dir = 'lib\syntec'; Name = 'OCKrnl.dll';           Url = "$base/OCKrnl.dll";           Hash = '130DE33F99752CC0FB0D3737A71EA648E2B15D0BA1302D4675DA5F553A955BB5' }
    @{ Dir = 'lib\syntec'; Name = 'OCKrnlDrv.dll';        Url = "$base/OCKrnlDrv.dll";        Hash = 'EDBD02B0864628A52D81518D6265CDCEBAEE807E898374AB516ED58547241359' }
    @{ Dir = 'lib\syntec'; Name = 'OCUser.dll';           Url = "$base/OCUser.dll";           Hash = 'A40D876E07924B783EDC3F36B2C84A1094E76FD5AAF8386C5C5198650BB17495' }
    @{ Dir = 'lib\syntec'; Name = 'Syntec.OpenCNC.dll';   Url = "$base/Syntec.OpenCNC.dll";   Hash = '95993534285FD258B2FA1FE5C58065EE653BC9CD7ED70F4DA8C9FEE7392F6374' }
    @{ Dir = 'lib\syntec'; Name = 'Syntec.RemoteCNC.dll'; Url = "$base/Syntec.RemoteCNC.dll"; Hash = 'D6EA5AD7AB31F9875792354DB62667976520DE8192F05F25FB78465A55CB9069' }
    @{ Dir = 'lib\syntec'; Name = 'Syntec.RemoteObj.dll'; Url = "$base/Syntec.RemoteObj.dll"; Hash = '3C09498D15967A5598F2A30294CD32E9A93C95646225885EC401BEF99B6CEFDB' }
    @{ Dir = 'redist'; Name = 'vcredist2005_x86.exe'
       Url = 'https://download.microsoft.com/download/8/B/4/8B42259F-5D70-43F4-AC2E-4B208FD8D66A/vcredist_x86.EXE'
       Hash = '8648C5FC29C44B9112FE52F9A33F80E7FC42D10F3B5B42B2121542A13E44ADFD' }
)
foreach ($d in $downloads) {
    $dir = Join-Path $PSScriptRoot $d.Dir
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $path = Join-Path $dir $d.Name
    if (-not (Test-Path $path)) { & curl.exe -sSL -m 300 -o $path $d.Url; if ($LASTEXITCODE -ne 0) { throw "download $($d.Name) failed" } }
    $hash = (Get-FileHash $path -Algorithm SHA256).Hash
    if ($hash -ne $d.Hash) { Remove-Item $path; throw "$($d.Name) hash mismatch: $hash" }
    Write-Host "ok $($d.Dir)\$($d.Name)"
}

$modern = @{
    'Syntec.OpenCNC.dll' = '091F5C5609E6ED7D43FA7BB9CF2634B99464AE89B1844770B635F48F46C29FB0'
    'OCApi.dll'          = '774F707CE310BE48890B317265EA371300DB103CFE93C16A38796874A34A13EA'
    'OCKrnl.dll'         = '763FE97A14CA71C164CE2B31B0529A44308F1B39E103DC58DE64975D658BF531'
    'OCKrnlDrv.dll'      = '7137CB3929431C1458A028604133134A595A98FAA2B53B7FF20DC5488D15E1D3'
    'SyntecFS.dll'       = 'CB0233D0C375F838C8DC97B1B57C76D35309E3131E6098A2D5349D1B570CBBD3'
    'Modbus.dll'         = '12551E1901AE06ED6978E7A33BE40833E4A74DB84481FD3EA51D3D068695C418'
}
$dir = Join-Path $PSScriptRoot 'lib\syntec-10.118'
$missing = @($modern.Keys | Where-Object { -not (Test-Path (Join-Path $dir $_)) })
if ($missing.Count -gt 0) {
    if (-not $SimulatorZip -or -not (Test-Path $SimulatorZip)) {
        Write-Warning "нет lib\syntec-10.118 и не указан архив симулятора (-SimulatorZip ...\CNC520.zip): агент будет работать на v4, передача файлов на ПО 10.118 не пойдёт"
        return
    }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $SimulatorZip))
    try {
        foreach ($name in $missing) {
            $entry = $zip.Entries | Where-Object { $_.FullName -ieq "CNC520/DiskC/OpenCNC/Bin/$name" } | Select-Object -First 1
            if (-not $entry) { throw "в архиве нет OpenCNC/Bin/$name" }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $dir $name), $true)
        }
    } finally { $zip.Dispose() }
}
foreach ($name in $modern.Keys) {
    $path = Join-Path $dir $name
    $hash = (Get-FileHash $path -Algorithm SHA256).Hash
    if ($hash -ne $modern[$name]) { Remove-Item $path; throw "$name hash mismatch: $hash" }
    Write-Host "ok lib\syntec-10.118\$name"
}
