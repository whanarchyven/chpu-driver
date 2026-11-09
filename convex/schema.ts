import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const jobStatus = v.union(
  v.literal("queued"),
  v.literal("delivered"),
  v.literal("loaded"),
  v.literal("in_progress"),
  v.literal("done"),
  v.literal("cancelled"),
  v.literal("failed"),
);

export const boundsValidator = v.object({
  minX: v.number(),
  maxX: v.number(),
  minY: v.number(),
  maxY: v.number(),
  minZ: v.number(),
  maxZ: v.number(),
});

export const statsValidator = v.object({
  lines: v.number(),
  programNumber: v.union(v.string(), v.null()),
  tools: v.array(
    v.object({
      tool: v.number(),
      rpm: v.union(v.number(), v.null()),
      cutMm: v.number(),
      timeSec: v.number(),
      minZ: v.union(v.number(), v.null()),
    }),
  ),
  toolChanges: v.number(),
  bounds: v.union(boundsValidator, v.null()),
  cutMm: v.number(),
  rapidMm: v.number(),
  plunges: v.number(),
  estimatedSec: v.number(),
  hasEnd: v.boolean(),
  warnings: v.array(v.string()),
});

export const axisValidator = v.object({ axis: v.string(), machine: v.number(), absolute: v.number() });

export default defineSchema({
  programs: defineTable({
    fileName: v.string(),
    folder: v.optional(v.string()),
    fileId: v.id("_storage"),
    sha256: v.string(),
    size: v.number(),
    previewId: v.optional(v.id("_storage")),
    stats: statsValidator,
    brand: v.optional(v.string()),
    kind: v.optional(v.string()),
    side: v.optional(v.union(v.literal("L"), v.literal("R"))),
    widthMm: v.optional(v.number()),
    thicknessMm: v.optional(v.number()),
    archived: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_sha256", ["sha256"])
    .index("by_file_name", ["fileName"])
    .index("by_created", ["createdAt"]),

  jobs: defineTable({
    number: v.string(),
    programId: v.id("programs"),
    // Name the file gets in NcFiles on the controller.
    cncName: v.string(),
    fileId: v.id("_storage"),
    sha256: v.string(),
    lines: v.number(),
    machineId: v.optional(v.string()),
    qtyPlanned: v.number(),
    qtyDone: v.number(),
    status: jobStatus,
    note: v.optional(v.string()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    deliveredAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_machine_status", ["machineId", "status"])
    .index("by_program", ["programId"])
    .index("by_created", ["createdAt"]),

  runs: defineTable({
    jobId: v.id("jobs"),
    machineId: v.string(),
    result: v.union(v.literal("finished"), v.literal("stopped")),
    startedAt: v.optional(v.number()),
    durationSec: v.optional(v.number()),
    count: v.number(),
    source: v.union(v.literal("agent"), v.literal("operator")),
    at: v.number(),
  })
    .index("by_job", ["jobId"])
    .index("by_machine", ["machineId", "at"]),

  counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),

  agentEvents: defineTable({
    eventId: v.string(),
    jobId: v.optional(v.id("jobs")),
    type: v.string(),
    at: v.number(),
  }).index("by_event", ["eventId"]),

  machineEvents: defineTable({
    machineId: v.string(),
    jobId: v.optional(v.id("jobs")),
    type: v.string(),
    text: v.string(),
    at: v.number(),
  }).index("by_machine", ["machineId", "at"]),

  heartbeats: defineTable({
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
  }).index("by_machine", ["machineId"]),
});
