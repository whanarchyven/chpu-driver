import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { jobStatus } from "./schema";
import { cncNameOf, journal, nextNumber, recordRun } from "./lib/runs";

const jobRow = v.object({
  _id: v.id("jobs"),
  number: v.string(),
  programId: v.id("programs"),
  fileName: v.string(),
  cncName: v.string(),
  machineId: v.optional(v.string()),
  qtyPlanned: v.number(),
  qtyDone: v.number(),
  status: jobStatus,
  note: v.optional(v.string()),
  lastError: v.optional(v.string()),
  lines: v.number(),
  estimatedSec: v.number(),
  createdAt: v.number(),
  deliveredAt: v.optional(v.number()),
  startedAt: v.optional(v.number()),
  finishedAt: v.optional(v.number()),
});

export const enqueue = mutation({
  args: {
    programId: v.id("programs"),
    qty: v.number(),
    machineId: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  returns: v.id("jobs"),
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program) throw new Error("Программа не найдена");
    const qty = Math.floor(args.qty);
    if (!(qty >= 1 && qty <= 10_000)) throw new Error("Количество от 1 до 10000");
    const n = await nextNumber(ctx, "job");
    const machineId = args.machineId?.trim() || undefined;
    const jobId = await ctx.db.insert("jobs", {
      number: `Ч-${n}`,
      programId: program._id,
      cncName: cncNameOf(program.fileName),
      fileId: program.fileId,
      sha256: program.sha256,
      lines: program.stats.lines,
      machineId,
      qtyPlanned: qty,
      qtyDone: 0,
      status: "queued",
      note: args.note?.trim().slice(0, 500) || undefined,
      createdAt: Date.now(),
    });
    return jobId;
  },
});

export const list = query({
  args: { includeClosed: v.optional(v.boolean()) },
  returns: v.array(jobRow),
  handler: async (ctx, args) => {
    const jobs = await ctx.db.query("jobs").withIndex("by_created").order("desc").take(300);
    const rows = [];
    for (const job of jobs) {
      const closed = job.status === "done" || job.status === "cancelled";
      if (closed && !args.includeClosed) continue;
      rows.push(await rowOf(ctx, job));
    }
    return rows;
  },
});

export const get = query({
  args: { jobId: v.id("jobs") },
  returns: v.union(
    v.null(),
    v.object({
      job: jobRow,
      runs: v.array(
        v.object({
          result: v.union(v.literal("finished"), v.literal("stopped")),
          count: v.number(),
          durationSec: v.optional(v.number()),
          source: v.union(v.literal("agent"), v.literal("operator")),
          machineId: v.string(),
          at: v.number(),
        }),
      ),
      events: v.array(v.object({ type: v.string(), text: v.string(), at: v.number() })),
    }),
  ),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_job", (q) => q.eq("jobId", job._id))
      .order("desc")
      .take(200);
    const events = job.machineId
      ? (
          await ctx.db
            .query("machineEvents")
            .withIndex("by_machine", (q) => q.eq("machineId", job.machineId ?? "").gte("at", job.createdAt))
            .order("desc")
            .take(300)
        ).filter((event) => event.jobId === job._id)
      : [];
    return {
      job: await rowOf(ctx, job),
      runs: runs.map((run) => ({
        result: run.result,
        count: run.count,
        durationSec: run.durationSec,
        source: run.source,
        machineId: run.machineId,
        at: run.at,
      })),
      events: events.map((event) => ({ type: event.type, text: event.text, at: event.at })),
    };
  },
});

async function rowOf(ctx: QueryCtx, job: Doc<"jobs">) {
  const program = await ctx.db.get(job.programId);
  return {
    _id: job._id,
    number: job.number,
    programId: job.programId,
    fileName: program?.fileName ?? job.cncName,
    cncName: job.cncName,
    machineId: job.machineId,
    qtyPlanned: job.qtyPlanned,
    qtyDone: job.qtyDone,
    status: job.status,
    note: job.note,
    lastError: job.lastError,
    lines: job.lines,
    estimatedSec: program?.stats.estimatedSec ?? 0,
    createdAt: job.createdAt,
    deliveredAt: job.deliveredAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

export const cancel = mutation({
  args: { jobId: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Задача не найдена");
    if (job.status === "done" || job.status === "cancelled") return null;
    await ctx.db.patch(job._id, { status: "cancelled", finishedAt: Date.now() });
    await journal(ctx, job.machineId, job._id, "cancelled", `${job.number} отменена`, Date.now());
    return null;
  },
});

export const finish = mutation({
  args: { jobId: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Задача не найдена");
    if (job.status === "done" || job.status === "cancelled") return null;
    await ctx.db.patch(job._id, { status: "done", finishedAt: Date.now() });
    await journal(ctx, job.machineId, job._id, "finished_manually", `${job.number} закрыта вручную`, Date.now());
    return null;
  },
});

export const retry = mutation({
  args: { jobId: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Задача не найдена");
    if (job.status !== "failed") return null;
    await ctx.db.patch(job._id, { status: "queued", lastError: undefined });
    return null;
  },
});

// Operator correction: parts cut outside the agent's view (or a miscount).
export const addParts = mutation({
  args: { jobId: v.id("jobs"), count: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Задача не найдена");
    const count = Math.floor(args.count);
    if (count === 0 || Math.abs(count) > 10_000) throw new Error("Неверное количество");
    if (count < 0) {
      await ctx.db.patch(job._id, { qtyDone: Math.max(0, job.qtyDone + count) });
      return null;
    }
    await recordRun(ctx, job, {
      machineId: job.machineId ?? "",
      result: "finished",
      count,
      source: "operator",
      at: Date.now(),
    });
    return null;
  },
});
