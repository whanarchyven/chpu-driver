import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "../convex/_generated/dataModel";
import { api } from "../convex/_generated/api";
import { useEffect, useMemo, useState } from "react";

type Route =
  | { name: "queue" }
  | { name: "programs" }
  | { name: "machines" }
  | { name: "job"; id: Id<"jobs"> };

type Program = FunctionReturnType<typeof api.programs.list>[number];
type Machine = FunctionReturnType<typeof api.machines.list>[number];

function useRoute(): Route {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const onHash = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const job = /^#\/job\/(.+)$/.exec(hash);
  if (job?.[1]) return { name: "job", id: decodeURIComponent(job[1]) as Id<"jobs"> };
  if (hash.startsWith("#/programs")) return { name: "programs" };
  if (hash.startsWith("#/machines")) return { name: "machines" };
  return { name: "queue" };
}

function useNow(periodMs = 5000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return now;
}

const statusLabel: Record<string, string> = {
  queued: "в очереди",
  delivered: "файл на стойке",
  loaded: "выбрана на стойке",
  in_progress: "фрезеруется",
  done: "готово",
  cancelled: "отменено",
  failed: "ошибка",
};

const modeLabel: Record<string, string> = {
  AUTO: "Авто",
  EDIT: "Редактирование",
  MDI: "MDI",
  JOG: "Ручной (JOG)",
  INCJOG: "Шаг",
  MPG: "Маховик",
  HOME: "Выход в ноль",
};

const stateLabel: Record<string, string> = {
  READY: "Готов",
  START: "Работает",
  HOLD: "Пауза",
  STOP: "Стоп",
  NOTREADY: "Не готов",
};

const eventLabel: Record<string, string> = {
  delivered: "файл на стойке",
  loaded: "выбрана основной",
  unloaded: "выбрана другая программа",
  run_started: "старт",
  run_finished: "цикл завершён",
  run_stopped: "остановлено",
  alarm: "тревога",
  alarm_cleared: "тревога снята",
  failed: "ошибка",
  link_lost: "нет связи",
  link_restored: "связь есть",
  cancelled: "отменена",
  finished_manually: "закрыта вручную",
};

function formatTime(ms: number) {
  return new Date(ms).toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}

function formatClock(ms: number) {
  return new Date(ms).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(sec: number) {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} ч ${String(m).padStart(2, "0")} мин`;
  if (m > 0) return `${m} мин ${String(s).padStart(2, "0")} с`;
  return `${s} с`;
}

function meters(mm: number) {
  return `${(mm / 1000).toFixed(mm < 10000 ? 2 : 1)} м`;
}

function isOnline(at: number, now: number) {
  return now - at < 30_000;
}

function agentSiteUrl() {
  return `http://${window.location.hostname}:3221`;
}

export default function App() {
  const route = useRoute();
  return (
    <div className="app">
      <header>
        <div>
          <h1>Очередь ЧПУ</h1>
          <p className="muted">Фрезер Velber · стойка Syntec 60W-E. Старт на станке нажимает оператор.</p>
        </div>
        <nav>
          <a className={route.name === "queue" || route.name === "job" ? "active" : ""} href="#/">
            Очередь
          </a>
          <a className={route.name === "programs" ? "active" : ""} href="#/programs">
            Программы
          </a>
          <a className={route.name === "machines" ? "active" : ""} href="#/machines">
            Станки
          </a>
        </nav>
      </header>
      {route.name === "queue" && <QueuePage />}
      {route.name === "programs" && <ProgramsPage />}
      {route.name === "machines" && <MachinesPage />}
      {route.name === "job" && <JobPage id={route.id} />}
    </div>
  );
}

function QueuePage() {
  const [showClosed, setShowClosed] = useState(false);
  const jobs = useQuery(api.jobs.list, { includeClosed: showClosed });
  const machines = useQuery(api.machines.list);
  const cancel = useMutation(api.jobs.cancel);
  const finish = useMutation(api.jobs.finish);
  const retry = useMutation(api.jobs.retry);
  const now = useNow();
  return (
    <section className="grid">
      <MachineStrip machines={machines ?? []} now={now} />
      <div className="card">
        <div className="row">
          <h2>Задачи</h2>
          <label className="inline">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
            показывать завершённые
          </label>
        </div>
        {jobs === undefined ? (
          <p className="muted">Загрузка…</p>
        ) : jobs.length === 0 ? (
          <p className="muted">
            Очередь пуста. Добавьте задачу на странице <a href="#/programs">«Программы»</a>.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>№</th>
                <th>Программа</th>
                <th>Станок</th>
                <th>Статус</th>
                <th>Сделано</th>
                <th>Создана</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job._id}>
                  <td>
                    <a href={`#/job/${job._id}`}>{job.number}</a>
                  </td>
                  <td>
                    {job.fileName}
                    {job.note ? <div className="muted small">{job.note}</div> : null}
                  </td>
                  <td>{job.machineId ?? <span className="muted">любой</span>}</td>
                  <td>
                    <span className={`badge ${job.status}`}>{statusLabel[job.status] ?? job.status}</span>
                    {job.lastError ? <div className="error small">{job.lastError}</div> : null}
                  </td>
                  <td>
                    {job.qtyDone} / {job.qtyPlanned}
                    <div className="progress">
                      <span style={{ width: `${Math.min(100, (job.qtyDone / job.qtyPlanned) * 100)}%` }} />
                    </div>
                  </td>
                  <td className="muted">{formatTime(job.createdAt)}</td>
                  <td className="actions">
                    {job.status === "failed" && (
                      <button className="ghost" onClick={() => void retry({ jobId: job._id })}>
                        повторить
                      </button>
                    )}
                    {job.status !== "done" && job.status !== "cancelled" && (
                      <>
                        <button className="ghost" onClick={() => void finish({ jobId: job._id })}>
                          закрыть
                        </button>
                        <button className="danger" onClick={() => void cancel({ jobId: job._id })}>
                          отменить
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function MachineStrip({ machines, now }: { machines: Machine[]; now: number }) {
  if (machines.length === 0) {
    return (
      <div className="card muted">
        Агент ещё не выходил на связь. Адрес для агента: <code>{agentSiteUrl()}</code>
      </div>
    );
  }
  return (
    <div className="machines-strip">
      {machines.map((m) => (
        <a key={m.machineId} className="card machine-mini" href="#/machines">
          <div className="row">
            <strong>{m.machineId}</strong>
            <OnlineDot machine={m} now={now} />
          </div>
          <div className="muted small">
            {m.connected
              ? `${modeLabel[m.mode ?? ""] ?? m.mode ?? "—"} · ${stateLabel[m.state ?? ""] ?? m.state ?? "—"}`
              : "нет связи со стойкой"}
          </div>
          <div className="small">{m.mainProgram ?? "—"}</div>
          <LineProgress machine={m} />
        </a>
      ))}
    </div>
  );
}

function OnlineDot({ machine, now }: { machine: Machine; now: number }) {
  const online = isOnline(machine.at, now);
  const alarm = (machine.alarms?.length ?? 0) > 0 || machine.emergency === true;
  const cls = !online ? "off" : !machine.connected ? "warn" : alarm ? "bad" : "on";
  const text = !online ? "агент не на связи" : !machine.connected ? "стойка недоступна" : alarm ? "тревога" : "на связи";
  return (
    <span className={`dot ${cls}`} title={text}>
      {text}
    </span>
  );
}

function LineProgress({ machine }: { machine: Machine }) {
  const job = machine.activeJob;
  if (!job || machine.line === undefined) return null;
  const sameProgram = machine.mainProgram?.toLowerCase() === job.cncName.toLowerCase();
  if (!sameProgram || job.lines <= 0) return null;
  const pct = Math.max(0, Math.min(100, (machine.line / job.lines) * 100));
  return (
    <div className="stack">
      <div className="progress">
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="muted small">
        строка {machine.line} из {job.lines} · {job.number}: {job.qtyDone}/{job.qtyPlanned}
      </div>
    </div>
  );
}

type UploadState = { name: string; status: "wait" | "ok" | "dup" | "error"; text?: string };

function ProgramsPage() {
  const programs = useQuery(api.programs.list);
  const machines = useQuery(api.machines.list);
  const generateUploadUrl = useMutation(api.programs.generateUploadUrl);
  const create = useAction(api.programs.create);
  const enqueue = useMutation(api.jobs.enqueue);
  const archive = useMutation(api.programs.archive);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [filter, setFilter] = useState("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [machineId, setMachineId] = useState("");
  const [added, setAdded] = useState<string | null>(null);
  const [preview, setPreview] = useState<Program | null>(null);

  async function upload(files: FileList | null) {
    if (!files) return;
    const list = Array.from(files).filter((file) => /\.(cnc|nc|tap)$/i.test(file.name));
    setUploads(list.map((file) => ({ name: file.webkitRelativePath || file.name, status: "wait" })));
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      if (!file) continue;
      const relative = file.webkitRelativePath || "";
      const folder = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : undefined;
      try {
        const url = await generateUploadUrl();
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: file });
        if (!response.ok) throw new Error(`загрузка: ${response.status}`);
        const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
        const result = await create({ storageId, fileName: file.name, folder });
        setUploads((prev) => prev.map((u, j) => (j === i ? { ...u, status: result.duplicate ? "dup" : "ok" } : u)));
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        setUploads((prev) => prev.map((u, j) => (j === i ? { ...u, status: "error", text } : u)));
      }
    }
  }

  const shown = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    return (programs ?? []).filter((p) => {
      const hay = `${p.fileName} ${p.folder ?? ""} ${p.brand ?? ""} ${p.kind ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [programs, filter]);

  async function add(program: Program) {
    const count = qty[program._id] ?? 1;
    await enqueue({ programId: program._id, qty: count, machineId: machineId || undefined });
    setAdded(`${program.fileName} × ${count} — в очереди`);
    setTimeout(() => setAdded(null), 4000);
  }

  return (
    <section className="grid">
      <div className="card stack">
        <h2>Загрузить программы</h2>
        <div className="drop stack">
          <p>Файлы .cnc с флешки или из папки бренда (например «БРЕНД АРДЕКО/860»).</p>
          <div className="row center">
            <label className="button-like">
              Выбрать файлы
              <input type="file" accept=".cnc,.nc,.tap" multiple hidden onChange={(e) => void upload(e.target.files)} />
            </label>
            <label className="button-like">
              Выбрать папку
              <input
                type="file"
                multiple
                hidden
                {...{ webkitdirectory: "", directory: "" }}
                onChange={(e) => void upload(e.target.files)}
              />
            </label>
          </div>
        </div>
        {uploads.length > 0 && (
          <div className="chips">
            {uploads.map((u) => (
              <span key={u.name} className={`chip ${u.status}`} title={u.text}>
                {u.name}: {u.status === "wait" ? "…" : u.status === "ok" ? "добавлен" : u.status === "dup" ? "уже есть" : `ошибка ${u.text ?? ""}`}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="card stack">
        <div className="row wrap">
          <h2>Программы ({shown.length})</h2>
          <div className="row">
            <input placeholder="поиск: Ard 960 L" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <label className="inline">
              станок
              <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
                <option value="">любой</option>
                {(machines ?? []).map((m) => (
                  <option key={m.machineId} value={m.machineId}>
                    {m.machineId}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        {added && <p className="ok">{added}</p>}
        {programs === undefined ? (
          <p className="muted">Загрузка…</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th />
                <th>Файл</th>
                <th>Изделие</th>
                <th>Габарит, мм</th>
                <th>Время ≈</th>
                <th>Инструменты</th>
                <th>В очередь</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p._id}>
                  <td>
                    {p.previewUrl && (
                      <img className="thumb drawing" src={p.previewUrl} alt="" onClick={() => setPreview(p)} />
                    )}
                  </td>
                  <td>
                    <strong>{p.fileName}</strong>
                    <div className="muted small">
                      {p.folder ? `${p.folder} · ` : ""}
                      {p.stats.lines} строк · {(p.size / 1024).toFixed(0)} КБ
                    </div>
                    {p.stats.warnings.length > 0 && <div className="error small">{p.stats.warnings.join("; ")}</div>}
                  </td>
                  <td className="small">
                    {[p.brand, p.kind, p.side, p.widthMm ? `${p.widthMm}` : null, p.thicknessMm ? `${p.thicknessMm} мм` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </td>
                  <td className="small">
                    {p.stats.bounds
                      ? `${Math.round(p.stats.bounds.maxX - p.stats.bounds.minX)} × ${Math.round(p.stats.bounds.maxY - p.stats.bounds.minY)}, глубина ${-p.stats.bounds.minZ}`
                      : "—"}
                  </td>
                  <td className="small">
                    {formatDuration(p.stats.estimatedSec)}
                    <div className="muted">рез {meters(p.stats.cutMm)}</div>
                  </td>
                  <td className="small">
                    {p.stats.tools.map((t) => `T${t.tool}${t.rpm ? ` ${t.rpm}` : ""}`).join(", ")}
                  </td>
                  <td>
                    <div className="qty">
                      <input
                        type="number"
                        min={1}
                        value={qty[p._id] ?? 1}
                        onChange={(e) => setQty({ ...qty, [p._id]: Math.max(1, Number(e.target.value) || 1) })}
                      />
                      <button className="primary" onClick={() => void add(p)}>
                        +
                      </button>
                      <button className="ghost" title="убрать из списка" onClick={() => void archive({ programId: p._id })}>
                        ×
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {preview && (
        <div className="modal" onClick={() => setPreview(null)}>
          <div className="card stack" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <h2>{preview.fileName}</h2>
              <button className="ghost" onClick={() => setPreview(null)}>
                закрыть
              </button>
            </div>
            {preview.previewUrl && <img className="preview" src={preview.previewUrl} alt="" />}
            <ProgramFacts program={preview} />
          </div>
        </div>
      )}
    </section>
  );
}

function ProgramFacts({ program }: { program: Program }) {
  const s = program.stats;
  return (
    <div className="facts">
      <span>строк: {s.lines}</span>
      <span>рез: {meters(s.cutMm)}</span>
      <span>холостые: {meters(s.rapidMm)}</span>
      <span>врезаний: {s.plunges}</span>
      <span>смен инструмента: {s.toolChanges}</span>
      <span>оценка: {formatDuration(s.estimatedSec)}</span>
      {s.tools.map((t) => (
        <span key={t.tool}>
          T{t.tool}: {t.rpm ?? "?"} об/мин, {meters(t.cutMm)}, до Z{t.minZ ?? "?"}
        </span>
      ))}
    </div>
  );
}

function MachinesPage() {
  const machines = useQuery(api.machines.list);
  const now = useNow(2000);
  if (machines === undefined) return <p className="muted">Загрузка…</p>;
  if (machines.length === 0) {
    return (
      <div className="card stack">
        <h2>Станков пока нет</h2>
        <p className="muted">
          Станок появится здесь, когда агент на шлюзовом ПК выйдет на связь. Адрес для агента (BaseUrl):{" "}
          <code>{agentSiteUrl()}</code>
        </p>
      </div>
    );
  }
  return (
    <section className="grid">
      {machines.map((m) => (
        <MachineCard key={m.machineId} machine={m} now={now} />
      ))}
    </section>
  );
}

function MachineCard({ machine: m, now }: { machine: Machine; now: number }) {
  const events = useQuery(api.machines.events, { machineId: m.machineId });
  const forget = useMutation(api.machines.forget);
  const [showFiles, setShowFiles] = useState(false);
  const online = isOnline(m.at, now);
  return (
    <div className="card stack">
      <div className="row">
        <h2>{m.machineId}</h2>
        <OnlineDot machine={m} now={now} />
      </div>
      <div className="muted small">
        агент {m.agentVersion} на {m.hostname}
        {m.ip ? ` (${m.ip})` : ""} · канал {m.link}
        {m.cncIp ? ` → стойка ${m.cncIp}` : ""} · последний сигнал {formatClock(m.at)}
        {m.controller ? ` · ${m.controller}` : ""}
      </div>
      {m.linkError && <p className="error">{m.linkError}</p>}
      <div className="panel">
        <div>
          <span className="muted">Режим</span>
          <strong>{modeLabel[m.mode ?? ""] ?? m.mode ?? "—"}</strong>
        </div>
        <div>
          <span className="muted">Состояние</span>
          <strong className={m.state === "START" ? "ok" : m.state === "HOLD" ? "wait" : ""}>
            {stateLabel[m.state ?? ""] ?? m.state ?? "—"}
          </strong>
        </div>
        <div>
          <span className="muted">Программа</span>
          <strong>{m.mainProgram ?? "—"}</strong>
        </div>
        <div>
          <span className="muted">Деталей (счётчик стойки)</span>
          <strong>{m.partCount ?? "—"}</strong>
        </div>
        <div>
          <span className="muted">Подача / шпиндель</span>
          <strong>
            {m.feed !== undefined ? `${Math.round(m.feed)} мм/мин` : "—"} / {m.rpm !== undefined ? `${m.rpm} об/мин` : "—"}
          </strong>
          {(m.feedOverride !== undefined || m.spindleOverride !== undefined) && (
            <span className="muted small">
              коррекция {m.feedOverride ?? "—"}% / {m.spindleOverride ?? "—"}%
            </span>
          )}
        </div>
        <div>
          <span className="muted">Координаты</span>
          <strong className="mono">
            {(m.position ?? []).map((p) => `${p.axis} ${p.absolute.toFixed(3)}`).join("  ") || "—"}
          </strong>
        </div>
      </div>
      <LineProgress machine={m} />
      {m.activeJob && (
        <p>
          Текущая задача: <a href={`#/job/${m.activeJob.jobId}`}>{m.activeJob.number}</a> {m.activeJob.cncName} —{" "}
          {statusLabel[m.activeJob.status] ?? m.activeJob.status}, сделано {m.activeJob.qtyDone} из {m.activeJob.qtyPlanned}
        </p>
      )}
      {(m.emergency || (m.alarms?.length ?? 0) > 0) && (
        <div className="alarm">
          {m.emergency && <strong>Аварийный стоп нажат. </strong>}
          {(m.alarms ?? []).join("; ")}
        </div>
      )}
      {m.ncFiles && (
        <div>
          <button className="ghost" onClick={() => setShowFiles(!showFiles)}>
            Файлы на стойке ({m.ncFiles.length}){m.ncFreeBytes !== undefined ? `, свободно ${(m.ncFreeBytes / 1024 / 1024).toFixed(1)} МБ` : ""}
          </button>
          {showFiles && (
            <div className="chips">
              {m.ncFiles.map((name) => (
                <span key={name}>{name}</span>
              ))}
            </div>
          )}
        </div>
      )}
      <h3>Журнал</h3>
      {events === undefined ? (
        <p className="muted">Загрузка…</p>
      ) : events.length === 0 ? (
        <p className="muted">Событий пока нет.</p>
      ) : (
        <pre className="log">
          {events.map((e) => `${formatClock(e.at)}  ${eventLabel[e.type] ?? e.type}  ${e.text}`).join("\n")}
        </pre>
      )}
      {m.debug && m.debug.length > 0 && (
        <details>
          <summary className="muted">Отладка агента</summary>
          <pre className="log">{m.debug.join("\n")}</pre>
        </details>
      )}
      {!online && (
        <button className="danger" onClick={() => void forget({ machineId: m.machineId })}>
          Убрать станок из списка
        </button>
      )}
    </div>
  );
}

function JobPage({ id }: { id: Id<"jobs"> }) {
  const data = useQuery(api.jobs.get, { jobId: id });
  const programs = useQuery(api.programs.list);
  const addParts = useMutation(api.jobs.addParts);
  const cancel = useMutation(api.jobs.cancel);
  const finish = useMutation(api.jobs.finish);
  if (data === undefined) return <p className="muted">Загрузка…</p>;
  if (data === null) return <p className="error">Задача не найдена.</p>;
  const { job, runs, events } = data;
  const program = programs?.find((p) => p._id === job.programId);
  const finished = runs.filter((r) => r.result === "finished" && r.durationSec !== undefined);
  const avg = finished.length ? finished.reduce((sum, r) => sum + (r.durationSec ?? 0), 0) / finished.length : null;
  const open = job.status !== "done" && job.status !== "cancelled";
  return (
    <section className="grid">
      <div className="card stack">
        <div className="row">
          <h2>
            {job.number} · {job.fileName}
          </h2>
          <span className={`badge ${job.status}`}>{statusLabel[job.status] ?? job.status}</span>
        </div>
        <div className="facts">
          <span>на стойке: {job.cncName}</span>
          <span>станок: {job.machineId ?? "любой"}</span>
          <span>
            сделано {job.qtyDone} из {job.qtyPlanned}
          </span>
          <span>оценка цикла: {formatDuration(job.estimatedSec)}</span>
          {avg !== null && <span>факт в среднем: {formatDuration(avg)}</span>}
          <span>создана {formatTime(job.createdAt)}</span>
          {job.deliveredAt && <span>на стойке с {formatTime(job.deliveredAt)}</span>}
          {job.finishedAt && <span>закрыта {formatTime(job.finishedAt)}</span>}
        </div>
        {job.note && <p>{job.note}</p>}
        {job.lastError && <p className="error">{job.lastError}</p>}
        <div className="progress">
          <span style={{ width: `${Math.min(100, (job.qtyDone / job.qtyPlanned) * 100)}%` }} />
        </div>
        {open && (
          <div className="row start">
            <button className="ghost" onClick={() => void addParts({ jobId: job._id, count: 1 })}>
              +1 деталь вручную
            </button>
            <button className="ghost" onClick={() => void addParts({ jobId: job._id, count: -1 })}>
              −1
            </button>
            <button className="ghost" onClick={() => void finish({ jobId: job._id })}>
              закрыть задачу
            </button>
            <button className="danger" onClick={() => void cancel({ jobId: job._id })}>
              отменить
            </button>
          </div>
        )}
      </div>
      {program?.previewUrl && (
        <div className="card stack">
          <img className="preview" src={program.previewUrl} alt="" />
          <ProgramFacts program={program} />
        </div>
      )}
      <div className="card stack">
        <h3>Прогоны</h3>
        {runs.length === 0 ? (
          <p className="muted">Ещё не запускали.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Когда</th>
                <th>Итог</th>
                <th>Деталей</th>
                <th>Длительность</th>
                <th>Источник</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r, i) => (
                <tr key={i}>
                  <td>{formatClock(r.at)}</td>
                  <td>{r.result === "finished" ? "завершён" : "остановлен"}</td>
                  <td>{r.count}</td>
                  <td>{r.durationSec !== undefined ? formatDuration(r.durationSec) : "—"}</td>
                  <td>{r.source === "agent" ? "станок" : "вручную"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h3>События</h3>
        {events.length === 0 ? (
          <p className="muted">Событий нет.</p>
        ) : (
          <pre className="log">{events.map((e) => `${formatClock(e.at)}  ${e.text}`).join("\n")}</pre>
        )}
      </div>
    </section>
  );
}
