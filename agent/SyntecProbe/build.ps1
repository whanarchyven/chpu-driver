# Builds SyntecProbe.exe (x86, .NET Framework 4.x) next to the Syntec Remote API DLLs.
# The DLLs are proprietary and are not stored in git; see ..\syntec-libs.ps1.
param([string]$Libs = (Join-Path $PSScriptRoot '..\lib\syntec'), [string]$Out = (Join-Path $PSScriptRoot 'bin'))
$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
New-Item -ItemType Directory -Path $Out -Force | Out-Null
Copy-Item (Join-Path $Libs '*.dll') $Out -Force
& $csc /nologo /target:exe /platform:x86 /optimize+ "/out:$(Join-Path $Out 'SyntecProbe.exe')" "/reference:$(Join-Path $Out 'Syntec.RemoteCNC.dll')" (Join-Path $PSScriptRoot 'Probe.cs')
if ($LASTEXITCODE -ne 0) { throw "csc exit $LASTEXITCODE" }
Copy-Item (Join-Path $PSScriptRoot 'SyntecProbe.exe.config') $Out -Force
Write-Host "built $(Join-Path $Out 'SyntecProbe.exe')"
