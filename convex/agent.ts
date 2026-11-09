import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { axisValidator } from "./schema";
import { activeStatuses, journal, recordRun } from "./lib/runs";

const agentJob = v.object({
  jobId: v.id("jobs"),
  number: v.string(),
  status: v.string(),
  cncName: v.string(),
  sha256: v.string(),
  lines: v.number(),
  qtyPlanned: v.number(),
  qtyDone: v.number(),
  createdAt: v.number(),
});

async function machineJobs(ctx: QueryCtx, machineId: string): Promise<Doc<"jobs">[]> {
  const jobs: Doc<"jobs">[] = [];
  for (const target of [machineId, undefined]) {
    for (const status of [...activeStatuses, "cancelled" as const]) {
      const rows = await ctx.db
        .query("jobs")
        .withIndex("by_machine_status", (q) => q.eq("machineId", target).eq("status", status))
        .order("desc")
        .take(status === "cancelled" ? 10 : 50);
      jobs.push(...rows);
    }
  }
  return jobs;
}

export const jobsForAgent = internalQuery({
  args: { machineId: v.string() },
  returns: v.array(agentJob),
  handler: async (ctx, args) => {
    const jobs = await machineJobs(ctx, args.machineId);
    return jobs
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((job) => ({
        jobId: job._id,
        number: job.number,
        status: job.status,
        cncName: job.cncName,
        sha256: job.sha256,
        lines: job.lines,
        qtyPlanned: job.qtyPlanned,
        qtyDone: job.qtyDone,
        createdAt: job.createdAt,
      }));
  },
});

export const fileForAgent = internalQuery({
  args: { jobId: v.id("jobs") },
  returns: v.union(v.object({ fileId: v.id("_storage"), cncName: v.string(), sha256: v.string() }), v.null()),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    return { fileId: job.fileId, cncName: job.cncName, sha256: job.sha256 };
  },
});

const eventValidator = v.object({
  eventId: v.string(),
  jobId: v.optional(v.string()),
  type: v.string(),
  at: v.number(),
  count: v.optional(v.number()),
  durationSec: v.optional(v.number()),
  startedAt: v.optional(v.number()),
  detail: v.optional(v.string()),
});

const journalText: Record<string, string> = {
  delivered: "файл на стойке",
  loaded: "выбрана основной программой",
  unloaded: "оператор выбрал другую программу",
  run_started: "старт",
  run_finished: "цикл завершён",
  run_stopped: "остановлено до конца программы",
  alarm: "тревога",
  alarm_cleared: "тревога снята",
  failed: "ошибка",
  link_lost: "нет связи со стойкой",
  link_restored: "связь со стойкой восстановлена",
};

export const applyEvents = internalMutation({
  args: { machineId: v.string(), events: v.array(eventValidator) },
  returns: v.object({ accepted: v.array(v.string()), duplicates: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const accepted: string[] = [];
    const duplicates: string[] = [];
    for (const event of args.events) {
      const seen = await ctx.db
        .query("agentEvents")
        .withIndex("by_event", (q) => q.eq("eventId", event.eventId))
        .unique();
      if (seen) {
        duplicates.push(event.eventId);
        continue;
      }
      let job: Doc<"jobs"> | null = null;
      if (event.jobId) {
        const id = ctx.db.normalizeId("jobs", event.jobId);
        job = id ? await ctx.db.get(id) : null;
      }
      if (job) await applyToJob(ctx, args.machineId, job, event);
      if (journalText[event.type] !== undefined) {
        const prefix = job ? `${job.number}: ` : "";
        const detail = event.detail ? ` — ${event.detail}` : "";
        await journal(ctx, args.machineId, job?._id, event.type, `${prefix}${journalText[event.type]}${detail}`, event.at);
      }
      await ctx.db.insert("agentEvents", {
        eventId: event.eventId,
        jobId: job?._id,
        type: event.type,
        at: event.at,
      });
      accepted.push(event.eventId);
    }
    return { accepted, duplicates };
  },
});

async function applyToJob(
  ctx: Parameters<typeof recordRun>[0],
  machineId: string,
  job: Doc<"jobs">,
  event: { type: string; at: number; count?: number; durationSec?: number; startedAt?: number; detail?: string },
): Promise<void> {
  const closed = job.status === "done" || job.status === "cancelled";
  const claim: { machineId?: string } = job.machineId ? {} : { machineId };
  const id: Id<"jobs"> = job._id;
  switch (event.type) {
    case "delivered":
      if (job.status === "queued" || job.status === "failed") {
        await ctx.db.patch(id, { ...claim, status: "delivered", deliveredAt: event.at, lastError: undefined });
      }
      break;
    case "loaded":
      if (job.status === "queued" || job.status === "delivered") {
        await ctx.db.patch(id, { ...claim, status: "loaded" });
      }
      break;
    case "unloaded":
      if (job.status === "loaded") await ctx.db.patch(id, { status: "delivered" });
      break;
    case "run_started":
      if (!closed) {
        await ctx.db.patch(id, { ...claim, status: "in_progress", startedAt: job.startedAt ?? event.at });
      }
      break;
    case "run_finished":
    case "run_stopped":
      if (!closed) {
        await recordRun(ctx, { ...job, machineId: job.machineId ?? machineId }, {
          machineId,
          result: event.type === "run_finished" ? "finished" : "stopped",
          count: event.type === "run_finished" ? Math.max(1, Math.floor(event.count ?? 1)) : 0,
          durationSec: event.durationSec,
          startedAt: event.startedAt,
          source: "agent",
          at: event.at,
        });
        if (!job.machineId) await ctx.db.patch(id, claim);
      }
      break;
    case "failed":
      if (!closed) {
        await ctx.db.patch(id, { status: "failed", lastError: event.detail ?? "Агент сообщил об ошибке" });
      }
      break;
  }
}

export const recordHeartbeat = internalMutation({
  args: {
    machineId: v.string(),
    agentVersion: v.string(),
    hostname: v.string(),
    ip: v.optional(v.string()),
    serverUrl: v.optional(v.string()),
    link: v.string(),
    cncIp: v.optional(v.string()),
    connected: v.boolean(),
    linkError: v.optional(v.string()),
    mode: v.optional(v.string()),
    state: v.optional(v.string()),
    mainProgram: v.optional(v.string()),
    currentProgram: v.optional(v.string()),
    line: v.optional(v.number()),
    partCount: v.optional(v.number()),
    alarms: v.optional(v.array(v.string())),
    emergency: v.optional(v.boolean()),
    feed: v.optional(v.number()),
    rpm: v.optional(v.number()),
    feedOverride: v.optional(v.number()),
    spindleOverride: v.optional(v.number()),
    position: v.optional(v.array(axisValidator)),
    ncFiles: v.optional(v.array(v.string())),
    ncFreeBytes: v.optional(v.number()),
    controller: v.optional(v.string()),
    debug: v.optional(v.array(v.string())),
    at: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("heartbeats")
      .withIndex("by_machine", (q) => q.eq("machineId", args.machineId))
      .unique();
    if (
      !existing ||
      existing.connected !== args.connected ||
      existing.mode !== args.mode ||
      existing.state !== args.state ||
      existing.mainProgram !== args.mainProgram
    ) {
      console.log(
        `[агент] ${args.machineId}: ${args.link} ${args.cncIp ?? ""} связь ${args.connected ? "есть" : "нет"}${args.linkError ? ` (${args.linkError})` : ""}, режим ${args.mode ?? "—"}, состояние ${args.state ?? "—"}, программа ${args.mainProgram ?? "—"}`,
      );
    }
    if (existing) {
      // Fields the agent sends only now and then (file list) stay until replaced.
      await ctx.db.replace(existing._id, {
        ...args,
        ncFiles: args.ncFiles ?? existing.ncFiles,
        ncFreeBytes: args.ncFreeBytes ?? existing.ncFreeBytes,
        controller: args.controller ?? existing.controller,
      });
    } else {
      await ctx.db.insert("heartbeats", args);
    }
    return null;
  },
});
