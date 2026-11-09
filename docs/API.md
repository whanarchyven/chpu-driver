# HTTP-контракт очереди ЧПУ

Базовый адрес — порт сайта Convex, тот, что `Запустить-сервер.cmd` печатает как `BaseUrl агента`. По умолчанию `http://<ip-сервера>:3221`.

| Контур | Префикс | Ключ | Кто вызывает |
|---|---|---|---|
| Приложение | `/api` | `API_TOKEN` | ERP, скрипт, другое приложение |
| Станок | `/agent` | `AGENT_TOKEN` | агент на шлюзе станка |

Оба ключа задаёт `Запустить-сервер.cmd` (на стенде оба `cnc-stand-dev`). Если `API_TOKEN` на сервере не задан, `/api` принимает `AGENT_TOKEN`.

## Общие правила

На каждый запрос — заголовок `Authorization: Bearer <ключ>`. Тела запросов — JSON в UTF-8 (`Content-Type: application/json`), кроме загрузки программы. Ответы — `application/json; charset=utf-8`. На `/api` сервер отвечает на `OPTIONS` кодом `204` и разрешает запросы из браузера с любого адреса.

Ошибка всегда такая:

```json
{ "error": "Текст, который можно показать пользователю" }
```

| Код | Когда |
|---|---|
| 400 | Нет поля, неверное значение (например, количество вне 1–10000) |
| 401 | Нет заголовка или ключ не тот |
| 404 | Программа или задача не найдена |
| 413 | Файл программы пустой или больше 5 МБ |

Идентификаторы (`programId`, `jobId`) — строки Convex, передавать как получили. Время — миллисекунды Unix.

`GET /api` возвращает список методов — удобно как проверка ключа.

## Программы

### `POST /api/programs?fileName=<имя>&folder=<папка>`

Тело — сам файл `.cnc` как есть (байты, `Content-Type` любой). `folder` необязателен, это подпись для поиска (например `860`).

Сервер считает SHA-256, разбирает G-код (инструменты, обороты, длина реза, оценка времени, габариты), рисует превью. Тот же файл с тем же именем второй раз не добавляется. Новый файл с уже существующим именем становится текущей версией, старая уходит в архив (задачи на неё не ломаются).

Ответ `201` (новая) или `200` (уже была):

```json
{ "programId": "js7…", "duplicate": false }
```

### `GET /api/programs`

```json
{
  "programs": [
    {
      "_id": "js7…",
      "fileName": "Ard_LIC_L_86-1_10mm.cnc",
      "folder": "860",
      "sha256": "f8fa…",
      "size": 46633,
      "brand": "Ard", "kind": "LIC", "side": "L", "widthMm": 860, "thicknessMm": 10,
      "stats": {
        "lines": 1460,
        "programNumber": null,
        "tools": [{ "tool": 1, "rpm": 18000, "cutMm": 5321.4, "timeSec": 210.5, "minZ": -10.5 }],
        "toolChanges": 1,
        "bounds": { "minX": 0, "maxX": 860, "minY": 0, "maxY": 2100, "minZ": -10.5, "maxZ": 50 },
        "cutMm": 5321.4, "rapidMm": 9120.0, "plunges": 14,
        "estimatedSec": 262, "hasEnd": true, "warnings": []
      },
      "previewUrl": "http://<ip-сервера>:3220/api/storage/…",
      "createdAt": 1794239787520
    }
  ]
}
```

Поля `brand`, `kind`, `side`, `widthMm`, `thicknessMm` разобраны из имени файла и бывают пустыми. `estimatedSec` — оценка по подачам из программы, без учёта разгонов.

## Задачи

Статусы задачи:

| Статус | Значит |
|---|---|
| `queued` | ждёт агента |
| `delivered` | файл лежит в памяти стойки |
| `loaded` | программа выбрана основной, ждёт «Старт» оператора |
| `in_progress` | станок режет по этой задаче |
| `done` | сделано `qtyPlanned` деталей или закрыта вручную |
| `failed` | агент не смог положить файл на стойку, причина в `lastError` |
| `cancelled` | отменена |

### `POST /api/jobs`

```json
{ "programId": "js7…", "qty": 2, "machineId": "velber-1", "note": "заказ 123" }
```

`machineId` необязателен: задачу без станка заберёт первый свободный агент. Ответ `201`:

```json
{ "jobId": "jh7…" }
```

На стойку файл попадает под именем `cncName` — имя программы только из латиницы, цифр, `_` и `-`.

### `GET /api/jobs[?all=1]`

Без `all` — только открытые задачи, с `all=1` — последние 300 вместе с закрытыми.

```json
{
  "jobs": [
    {
      "_id": "jh7…", "number": "Ч-3", "programId": "js7…",
      "fileName": "Ard_LIC_L_86-1_10mm.cnc", "cncName": "Ard_LIC_L_86-1_10mm.cnc",
      "machineId": "velber-1", "qtyPlanned": 2, "qtyDone": 1, "status": "loaded",
      "note": "заказ 123", "lines": 1460, "estimatedSec": 262,
      "createdAt": 1794239787520, "deliveredAt": 1794239790000, "startedAt": 1794239800000
    }
  ]
}
```

### `POST /api/jobs/cancel` — `{ "jobId": "…" }`

Отменяет открытую задачу. Файл в памяти стойки остаётся, агент перестаёт его выбирать.

### `POST /api/jobs/finish` — `{ "jobId": "…" }`

Закрывает задачу как выполненную, сколько бы деталей ни было.

### `POST /api/jobs/parts` — `{ "jobId": "…", "count": 1 }`

Поправка счётчика деталей задачи (отрицательное число — уменьшить). Нужна, если деталь испорчена или счётчик стойки не работает. Ответ всех трёх: `{ "ok": true }`.

## Станки

### `GET /api/machines`

```json
{
  "machines": [
    {
      "machineId": "velber-1", "online": true, "at": 1794239943270,
      "agentVersion": "0.1.0", "hostname": "CNC-GW1", "ip": "192.168.50.2",
      "link": "syntec", "cncIp": "192.168.50.20", "connected": true, "linkError": null,
      "controller": "Syntec Mill … ПО 10.118.14H",
      "mode": "AUTO", "state": "START", "emergency": false, "alarms": [],
      "mainProgram": "Ard_LIC_L_86-1_10mm.cnc", "currentProgram": "Ard_LIC_L_86-1_10mm.cnc",
      "line": 532, "partCount": 118,
      "feed": 15000, "rpm": 18000, "feedOverride": 100, "spindleOverride": 100,
      "position": [{ "axis": "X", "machine": 412.5, "absolute": 402.5 }],
      "ncFiles": ["Ard_LIC_L_86-1_10mm.cnc"], "ncFreeBytes": 41124984,
      "activeJob": { "jobId": "jh7…", "number": "Ч-3", "cncName": "…", "status": "in_progress", "lines": 1460, "qtyPlanned": 2, "qtyDone": 1 }
    }
  ]
}
```

`online` — агент присылал пульс последние 30 секунд. `connected` — агент видит стойку. `state` — как отдаёт стойка: `READY`, `START`, `HOLD`, `STOP`. Поля, которые стойка не отдала, отсутствуют.

## Контур агента (`/agent`)

Для справки: этим пользуется только `CncAgent`.

| Метод | Что делает |
|---|---|
| `GET /agent/jobs?machineId=` | открытые задачи станка и неназначенные, плюс до 10 недавно отменённых |
| `GET /agent/file?jobId=` | байты программы, заголовок `X-Sha256` |
| `POST /agent/events` | `{ machineId, events: [{ eventId, type, jobId?, at, count?, durationSec?, startedAt?, detail? }] }` → `{ accepted: [...], duplicates: [...] }` |
| `POST /agent/heartbeat` | состояние станка, поля как в `GET /api/machines` |

Типы событий: `delivered`, `loaded`, `unloaded`, `run_started`, `run_finished`, `run_stopped`, `failed` (меняют задачу) и `link_lost`, `link_restored`, `alarm`, `alarm_cleared` (журнал станка). `eventId` уникален, повтор того же события сервер не применяет второй раз — агент хранит неотправленные события на диске и досылает после обрыва.
