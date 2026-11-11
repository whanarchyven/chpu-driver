# Передача 10.11.2026: первый выезд к станку

После этого выезда в репозиторий положен клиент Syntec 10.118, а меню в README и в ИНСТРУКЦИЯ.txt заменено на F5 Maintain → F2 Set Kernel Server. Повторный заезд идёт по README, раздел «Сейчас у станка».

Что сделали 10 ноября 2026 года на месте и с чем столкнулись. Общая схема проекта — в [HANDOFF.md](HANDOFF.md), порядок внедрения — в [ВНЕДРЕНИЕ.md](ВНЕДРЕНИЕ.md).

## Итог дня

- Сервер очереди (Convex в Docker, веб, панель) поднят на ноутбуке с Windows и отвечает. Функции загружены, ключи `AGENT_TOKEN` и `API_TOKEN` = `cnc-stand-dev`.
- Веб: http://192.168.50.1:5174, панель Convex: http://192.168.50.1:6792, BaseUrl агента: http://192.168.50.1:3221.
- Собранный агент лежит в репозитории: `agent/usb/CncAgent` (коммит `698fcc2`). Раньше эта папка была в `.gitignore`, и на ноутбуке она оказывалась пустой.
- На стойке пока не сделано: смена IP, запуск сервера связи, установка агента, проверки, приёмка с оператором.

## Оборудование и адреса

| Что | Значение |
|---|---|
| Станок | Velber M2130ATC-R12 |
| Стойка | Syntec 60W-E, на экране SYNTEC 60A 7 Axes, WOOD, Windows CE |
| ПО стойки | 10.118.14H (Product/Server/Client), Image 7.68, CPU AM335x-H, серийный F9L05728 |
| Ноутбук | Windows, пользователь `sesa3`, проект в `C:\Users\sesa3\Desktop\chpu-driver\chpu-driver` |
| Роль ноутбука | одновременно сервер очереди и шлюз станка (на нём же ставится агент) |
| Сеть станка | кабель Ethernet напрямую, `192.168.50.0/24`, без шлюза и DNS |
| Ноутбук на кабеле | `192.168.50.1`, маска `255.255.255.0`, шлюз и DNS пустые |
| Стойка | `192.168.50.20` |
| Порты сервера | Convex 3220, HTTP-действия 3221, веб 5174, панель 6792 |
| Порты стойки | 5566–5572 (Core server) |
| Станок в системе | `velber-1` |

Wi-Fi на ноутбуке остаётся для интернета. Общий доступ к интернету (ICS) на кабель станка не включать, шлюз на адаптер станка не ставить.

## Интерфейс стойки (английский, 60W-E WOOD)

Путь из инструкций для симулятора фрезера («Maintain → Network») здесь не подходит. На этой стойке:

- Главные клавиши: F1 Operator Panel, F2 Program, F3 Offset/Setting, F4 Monitor, F5 Maintain, F6 Parameter, F7 Diagnosis, F8 Sys Admin.
- **Сеть: F5 Maintain → F2 Set Kernel Server** — открывается страница «IP Address Parameter».
- Что было на стойке при осмотре:
  - IP Address Setting = «Specify an IP Address» — оставить, DHCP не выбирать;
  - IP Address `192.168.0.91` → поменять на `192.168.50.20`;
  - Subnet Mask `255.255.255.0` — оставить;
  - Default Gateway `192.168.0.92` — стереть;
  - Primary DNS `192.168.0.92` — стереть;
  - PC Name `RUINUO`, Dir Name `CNC`, Shared Folder Path `DiskA\OpenCNC\NcFiles` — не трогать;
  - Net Status: Code 1222, network unreachable — ожидаемо, пока стоит старый адрес.
- Сохранить: **Save Setting**.
- Затем на той же странице **F5 Set Kernel Server**: Start server while boot = Yes, Timeout не трогать, **F1 Start Server**. Перезагрузить стойку.
- Не открывать: Wifi Module Setting, Syntec EagleEye, F3 CloudAgent (он только с 10.118.44H). Не запускать красную подсказку «Can't find SB Restore Files! Please execute the Syntec Backup Function!».
- О программе: F5 Maintain → Next → F8 About → F1 About.
- Список файлов: F2 Program → F8 File Manager. ENTER на файле назначает его исполняемым — просто для просмотра не нажимать.
- Счётчик деталей: F4 Monitor → F4 Param. Set (Part count, Total Acum Par, Required part). Total Acum Par не обнулять.
- M-код счётчика — параметр 3804 (F3 Offset/Setting → F4 User Param). Если 30, счёт идёт по M30. Не менять.
- Режим переключается ключом на пульте, на фото уже Auto + Ready.
- На стойке была выбрана рабочая программа `BSTORM_LIC_L_960-3_10MM.CNC`. Start на ней не нажимать.
- Кнопки на пульте: Ready, Auto, Start (пуск цикла), B-Stop, RESET, Alarm. Для приёмки нужны Start и RESET. STOP только ставит на паузу, шпиндель продолжает крутиться.

## Проблемы с запуском сервера и решения

### 1. `npm ci` падал с `EIDLETIMEOUT`

При первой сборке образа веба `RUN npm ci` через 479 с упал на `registry.npmjs.org`. Предупреждение `EBADENGINE` (convex@1.49.0 хочет Node ≥ 22, в образе Node 20) не фатально.

Причина: интернет нужен во время первой сборки, а адаптер станка без шлюза. Решение: держать Wi-Fi включённым и повторить запуск. Со второго раза прошло, дальше слой берётся из кэша.

### 2. Backend `exited (255)`: `exec ./run_backend.sh: exec format error`

Проверили: ноутбук AMD64, образы convex и alpine amd64, `bash` внутри образа запускается (`uname -m` = `x86_64`). Docker Desktop на Windows не смог выполнить скрипт входа образа напрямую; у скрипта шебанг `#! /bin/bash` с пробелом.

Попутно: при ручной правке `server/docker-compose.yml` на ноутбуке `entrypoint` попал не в тот сервис («mapping key "entrypoint" already defined», затем `stat /bin/bash: no such file or directory` у firewall на Alpine — там нет bash). Откатили: `git checkout -- server/docker-compose.yml`.

### 3. Backend `exited (0)` после `bash ./run_backend.sh` (коммит `3f9f1bb`)

Контейнер завершался за 0,6 с: образ Ubuntu оставляет `CMD ["bash"]`, и подмена точки входа не помогала.

### 4. Запуск бинарника напрямую (коммит `3a3c0ea`)

В `server/docker-compose.yml` для backend:

```yaml
entrypoint: ["/bin/bash", "-c"]
command:
  - 'mkdir -p /convex/data/tmp /convex/data/storage && exec ./convex-local-backend --instance-name "$$INSTANCE_NAME" ...'
```

У firewall точка входа осталась `["sh", "-c"]`.

Сначала в логах было `/bin/bash: line 1: /convex/convex-local-backend: Success` — это bash так сообщает, что ELF не запустился. Вероятная причина — антивирус повредил слой образа при скачивании. Пользователь выключил антивирус, при следующем запуске backend стал Healthy.

Если повторится: `docker compose ... down`, `docker rmi ghcr.io/convex/convex-backend:latest`, `docker pull --platform linux/amd64 ghcr.io/convex/convex-backend:latest`. Проверка: `od -An -tx1 -N 4 ./convex-local-backend` внутри образа должен показать `7f 45 4c 46`. Если не помогло — перезагрузить Windows.

### 5. Пустой адрес веба в выводе: `http:// :5174`

`Запустить-сервер.cmd` печатал `http://%IP%:%WEB_PORT%`. В cmd запись `%IP%:...` разбирается как замена подстроки, и IP пропадает. Так же мог испортиться и `server\.env` при создании (`http://%IP%:3220`). BaseUrl печатался правильно, потому что лежал целиком в одной переменной.

Исправлено в `698fcc2`: включено отложенное раскрытие (`!VAR!`), `.env` пишется через PowerShell из `$env:CNC_HOST`. Если в `.env` адрес без IP, скрипт его чинит. Сервер при этом работал, проблема была только в выводе.

### 6. Пустая папка `agent\usb\CncAgent`

Папки `agent/usb`, `agent/lib/syntec`, `agent/lib/syntec-10.118` и `agent/redist` были в `.gitignore`, а собрать агент на ноутбуке было нечем.

Решение (`698fcc2`):

- библиотеки Syntec v4 скачаны из `JMatveichik/Syntec.TestApp` и проверены по SHA-256 из `agent/syntec-libs.ps1`;
- `vcredist2005_x86.exe` скачан с microsoft.com, хэш совпал;
- `CncAgent.exe` (net48, x86) собран .NET SDK 8 на Маке через `Microsoft.NETFramework.ReferenceAssemblies`;
- папка флешки собрана так же, как в `build-usb.ps1`: ps1 и txt сохранены в UTF-8 с BOM;
- из `.gitignore` убраны `agent/lib/*`, `agent/redist` и `agent/usb`. Не коммитятся `agent/publish`, `bin`/`obj` и `server/.env`.

Для ноутбука собран и передан полный архив проекта (`git archive`).

## Открытый вопрос: клиент Syntec 10.118

Прошивка стойки — 10.118. Клиент v4 читает статус, но загрузка файла на 10.118 падает с `SocketError -16` (проверено ещё на симуляторе). Нужные библиотеки (`Syntec.OpenCNC.dll`, `OCApi.dll`, `OCKrnl.dll`, `OCKrnlDrv.dll`, `SyntecFS.dll`, `Modbus.dll`, хэши в `agent/syntec-libs.ps1`) берутся только из архива симулятора `CNC520.zip`, путь внутри `CNC520/DiskC/OpenCNC/Bin/`.

Архива нет в репозитории и на Маке. Раньше он лежал в `D:\VMs\cnc-stand\dl\CNC520.zip`. В открытом доступе таких версий не нашли. Сайты «скачать DLL» не использовать: файлы там других версий и с другими хэшами.

Когда архив найдётся:

```powershell
powershell -File agent\syntec-libs.ps1 -SimulatorZip D:\путь\CNC520.zip
powershell -File agent\build-usb.ps1
```

После этого закоммитить `agent/lib/syntec-10.118` и обновлённую `agent/usb/CncAgent`. При `SyntecLib: auto` агент сам выберет 10.118.

## Что осталось сделать на месте

1. На ноутбуке: адаптер станка `192.168.50.1`, маска `255.255.255.0`, шлюз и DNS пустые. Wi-Fi не отключать.
2. Открыть http://192.168.50.1:5174.
3. На стойке сменить IP на `192.168.50.20`, стереть шлюз и DNS, Save Setting. Затем Set Kernel Server → Start server while boot = Yes → Start Server, перезагрузить стойку.
4. `ping 192.168.50.20` с ноутбука.
5. `agent\usb\CncAgent\Установить.cmd` от администратора. Ответы: сервер `192.168.50.1`, стойка `192.168.50.20`, ключ `cnc-stand-dev`, станок `velber-1`. Адрес ноутбука выставить вручную заранее: установщик подбирает свободный `.2–.19`, а здесь ноутбук ещё и сервер.
6. `Проверить-стойку.cmd`, затем `Проверить-передачу.cmd`. Файл `ERP-TEST.CNC` содержит только комментарий и `M30`, оси не двигает и главную программу не меняет. Если `SocketError -16` — см. открытый вопрос про клиент 10.118.
7. В вебе поставить в очередь ERP-TEST. Приёмка с оператором: Start, RESET посреди программы, снова Start до M30. Проверить счётчик деталей и статусы `loaded → in_progress → done`.
8. Ещё не проверено на реальной стойке, только на симуляторе: старт, M30, счётчик деталей, остановка посреди программы, выдёргивание кабеля, меню и пароль Core server.

## Коммиты дня

- `3f9f1bb` fix: запускать Convex через bash на Windows Docker
- `3a3c0ea` fix: запускать бинарник Convex напрямую на Windows Docker
- `698fcc2` fix: показывать адрес веба и положить агент в репозиторий
