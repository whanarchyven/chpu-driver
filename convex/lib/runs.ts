import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

export const activeStatuses = ["queued", "delivered", "loaded", "in_progress"] as const;

// Controllers keep names short and ASCII; anything else becomes "_".
export function cncNameOf(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "");
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[^A-Za-z0-9_\-]/g, "_").slice(0, 60) || "program";
  const ext = dot > 0 ? base.slice(dot + 1).replace(/[^A-Za-z0-9]/g, "").slice(0, 4) : "";
  return `${stem}.${ext || "cnc"}`;
}

export async function nextNumber(ctx: MutationCtx, name: string): Promise<number> {
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  const value = (counter?.value ?? 0) + 1;
  if (counter) await ctx.db.patch(counter._id, { value });
  else await ctx.db.insert("counters", { name, value });
  return value;
}

export async function journal(
  ctx: MutationCtx,
  machineId: string | undefined,
  jobId: Id<"jobs"> | undefined,
  type: string,
  text: string,
  at: number,
): Promise<void> {
  if (!machineId) return;
  await ctx.db.insert("machineEvents", { machineId, jobId, type, text: text.slice(0, 500), at });
}

// One or more parts cut: count them, close the job when the plan is reached.
export async function recordRun(
  ctx: MutationCtx,
  job: Doc<"jobs">,
  run: {
    machineId: string;
    result: "finished" | "stopped";
    count: number;
    durationSec?: number;
    startedAt?: number;
    source: "agent" | "operator";
    at: number;
  },
): Promise<void> {
  await ctx.db.insert("runs", { jobId: job._id, ...run });
  if (run.result === "stopped") {
    if (job.status === "in_progress") await ctx.db.patch(job._id, { status: "loaded" });
    return;
  }
  const qtyDone = job.qtyDone + run.count;
  if (qtyDone >= job.qtyPlanned) {
    await ctx.db.patch(job._id, { qtyDone, status: "done", finishedAt: run.at });
  } else {
    await ctx.db.patch(job._id, {
      qtyDone,
      status: job.status === "queued" || job.status === "delivered" ? job.status : "loaded",
    });
  }
}
