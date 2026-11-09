import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { axisValidator } from "./schema";

const machineRow = v.object({
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
  activeJob: v.union(
    v.null(),
    v.object({
      jobId: v.id("jobs"),
      number: v.string(),
      cncName: v.string(),
      status: v.string(),
      lines: v.number(),
      qtyPlanned: v.number(),
      qtyDone: v.number(),
    }),
  ),
});

export const list = query({
  args: {},
  returns: v.array(machineRow),
  handler: async (ctx) => {
    const beats = await ctx.db.query("heartbeats").take(50);
    const rows = [];
    for (const beat of beats) {
      let activeJob = null;
      for (const status of ["in_progress", "loaded"] as const) {
        const job = await ctx.db
          .query("jobs")
          .withIndex("by_machine_status", (q) => q.eq("machineId", beat.machineId).eq("status", status))
          .first();
        if (job) {
          activeJob = {
            jobId: job._id,
            number: job.number,
            cncName: job.cncName,
            status: job.status,
            lines: job.lines,
            qtyPlanned: job.qtyPlanned,
            qtyDone: job.qtyDone,
          };
          break;
        }
      }
      const { _id, _creationTime, ...fields } = beat;
      rows.push({ ...fields, activeJob });
    }
    return rows.sort((a, b) => a.machineId.localeCompare(b.machineId));
  },
});

export const events = query({
  args: { machineId: v.string() },
  returns: v.array(v.object({ type: v.string(), text: v.string(), at: v.number(), jobId: v.optional(v.id("jobs")) })),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("machineEvents")
      .withIndex("by_machine", (q) => q.eq("machineId", args.machineId))
      .order("desc")
      .take(100);
    return rows.map((row) => ({ type: row.type, text: row.text, at: row.at, jobId: row.jobId }));
  },
});

export const forget = mutation({
  args: { machineId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const beat = await ctx.db
      .query("heartbeats")
      .withIndex("by_machine", (q) => q.eq("machineId", args.machineId))
      .unique();
    if (beat) await ctx.db.delete(beat._id);
    return null;
  },
});
