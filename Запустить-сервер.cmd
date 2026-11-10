@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
where docker >nul 2>&1 || (echo Docker не найден. Установите Docker Desktop и запустите его. & pause & exit /b 1)

rem Address other computers use to reach this one. Override with SERVER_IP.
rem Do not write http://%%IP%%:port in this file: cmd treats %%VAR%%:text as a
rem search-and-replace and the address disappears.
set "IP=%SERVER_IP%"
if not defined IP for /f "delims=" %%A in ('powershell -NoProfile -Command "$c = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1; if (-not $c) { $c = Get-NetIPConfiguration | Where-Object { $_.IPv4Address -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Docker|Loopback' } | Select-Object -First 1 }; if ($c) { $c.IPv4Address[0].IPAddress }"') do set "IP=%%A"
if not defined IP set "IP=127.0.0.1"
set "CNC_HOST=%IP%"

if not exist "server\.env" (
  powershell -NoProfile -Command "$h=$env:CNC_HOST; $s=[guid]::NewGuid().Guid.Replace('-','')+[guid]::NewGuid().Guid.Replace('-',''); $s=$s.Substring(0,64); @('PORT=3220','SITE_PROXY_PORT=3221','WEB_PORT=5174','DASHBOARD_PORT=6792',('CONVEX_CLOUD_ORIGIN=http://'+$h+':3220'),('CONVEX_SITE_ORIGIN=http://'+$h+':3221'),'INSTANCE_NAME=cnc-erp',('INSTANCE_SECRET='+$s),'AGENT_TOKEN=cnc-stand-dev','API_TOKEN=cnc-stand-dev') | Set-Content -Encoding ascii 'server\.env'"
  echo Создан server\.env
)

powershell -NoProfile -Command "$h=$env:CNC_HOST; $p='server\.env'; $lines=Get-Content $p; $bad=$false; foreach($l in $lines){ if($l -match '^CONVEX_(CLOUD|SITE)_ORIGIN=http://(\d+\.\d+\.\d+\.\d+):'){ } else { if($l -match '^CONVEX_(CLOUD|SITE)_ORIGIN='){ $bad=$true } } }; if($bad){ $lines = $lines | ForEach-Object { if($_ -match '^CONVEX_CLOUD_ORIGIN='){ 'CONVEX_CLOUD_ORIGIN=http://'+$h+':3220' } elseif($_ -match '^CONVEX_SITE_ORIGIN='){ 'CONVEX_SITE_ORIGIN=http://'+$h+':3221' } else { $_ } }; Set-Content -Encoding ascii $p $lines; Write-Host 'Исправлен адрес в server\.env' }"

for /f "usebackq tokens=1,* delims==" %%A in ("server\.env") do set "%%A=%%B"

for /f "tokens=3 delims=/" %%A in ("!CONVEX_SITE_ORIGIN!") do set "ORIGIN_TAIL=%%A"
for /f "tokens=1 delims=:" %%A in ("!ORIGIN_TAIL!") do set "WEB_HOST=%%A"
if not defined WEB_HOST set "WEB_HOST=!CNC_HOST!"

echo Запускаю сервер...
docker compose -f "%~dp0server\docker-compose.yml" --env-file "%~dp0server\.env" up -d --build || (pause & exit /b 1)

rem Open the ports in the Windows firewall (asks for administrator rights once).
netsh advfirewall firewall show rule name="CNC ERP server" >nul 2>&1 || (
  powershell -NoProfile -Command "Start-Process -Verb RunAs -Wait netsh -ArgumentList 'advfirewall firewall add rule name=\"CNC ERP server\" dir=in action=allow protocol=TCP localport=%PORT%,%SITE_PROXY_PORT%,%WEB_PORT%,%DASHBOARD_PORT%'"
)

echo Жду готовности Convex...
set "READY="
for /l %%I in (1,1,60) do (
  curl -fs http://127.0.0.1:%PORT%/version >nul 2>&1 && set "READY=1" && goto ready
  timeout /t 2 /nobreak >nul
)
:ready
if not defined READY (echo Convex не ответил за две минуты. & pause & exit /b 1)

set "ADMIN_KEY="
for /f "delims=" %%K in ('docker run --rm -e INSTANCE_NAME^=%INSTANCE_NAME% -e INSTANCE_SECRET^=%INSTANCE_SECRET% --entrypoint /convex/generate_admin_key.sh ghcr.io/convex/convex-backend:latest') do set "ADMIN_KEY=%%K"

echo Загружаю функции...
call npx convex deploy --yes --admin-key "%ADMIN_KEY%" --url "http://127.0.0.1:%PORT%" --env-file NUL || (pause & exit /b 1)
if not defined API_TOKEN set "API_TOKEN=%AGENT_TOKEN%"
call npx convex env set AGENT_TOKEN "%AGENT_TOKEN%" --admin-key "%ADMIN_KEY%" --url "http://127.0.0.1:%PORT%"
call npx convex env set API_TOKEN "%API_TOKEN%" --admin-key "%ADMIN_KEY%" --url "http://127.0.0.1:%PORT%"

echo.
echo Готово.
echo   Веб:            http://!WEB_HOST!:!WEB_PORT!
echo   BaseUrl агента: !CONVEX_SITE_ORIGIN!
echo   Ключ агента:    !AGENT_TOKEN!
echo   Ключ API:       !API_TOKEN!
echo   Панель Convex:  http://!WEB_HOST!:!DASHBOARD_PORT!
echo Остановка: docker compose -f "%~dp0server\docker-compose.yml" down
pause
