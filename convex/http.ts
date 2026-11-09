import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import * as external from "./externalApi";
import { authorized, json, num, str } from "./lib/httpUtil";

const listJobs = httpAction(async (ctx, request) => {
  if (!authorized(request, "AGENT_TOKEN")) return json({ error: "Unauthorized" }, 401);
  const machineId = new URL(request.url).searchParams.get("machineId")?.trim();
  if (!machineId) return json({ error: "machineId is required" }, 400);
  const jobs = await ctx.runQuery(internal.agent.jobsForAgent, { machineId });
  return json({ jobs });
});

const downloadFile = httpAction(async (ctx, request) => {
  if (!authorized(request, "AGENT_TOKEN")) return json({ error: "Unauthorized" }, 401);
  const raw = new URL(request.url).searchParams.get("jobId") ?? "";
  const jobId = await ctx.runQuery(internal.httpIds.jobId, { raw });
  if (!jobId) return json({ error: "Job not found" }, 404);
  const meta = await ctx.runQuery(internal.agent.fileForAgent, { jobId });
  if (!meta) return json({ error: "Job not found" }, 404);
  const blob = await ctx.storage.get(meta.fileId);
  if (!blob) return json({ error: "File missing" }, 404);
  console.log(`[агент] скачивает ${meta.cncName} (${blob.size} байт)`);
  return new Response(blob, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(meta.cncName)}"`,
      "X-Sha256": meta.sha256,
    },
  });
});

const postEvents = httpAction(async (ctx, request) => {
  if (!authorized(request, "AGENT_TOKEN")) return json({ error: "Unauthorized" }, 401);
  const body = (await request.json()) as { machineId?: unknown; events?: unknown };
  const machineId = str(body.machineId, 64);
  if (!machineId) return json({ error: "machineId is required" }, 400);
  const list = Array.isArray(body.events) ? body.events : [];
  const events = list.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const e = item as Record<string, unknown>;
    const eventId = str(e.eventId, 100);
    const type = str(e.type, 40);
    if (!eventId || !type) return [];
    return [
      {
        eventId,
        type,
        jobId: str(e.jobId, 64),
        at: num(e.at) ?? Date.now(),
        count: num(e.count),
        durationSec: num(e.durationSec),
        startedAt: num(e.startedAt),
        detail: str(e.detail, 1000),
      },
    ];
  });
  const result = await ctx.runMutation(internal.agent.applyEvents, { machineId, events });
  for (const event of events) {
    console.log(`[агент] ${machineId}: событие ${event.type} задача ${event.jobId ?? "—"}${event.detail ? `: ${event.detail}` : ""}`);
  }
  return json(result);
});

const postHeartbeat = httpAction(async (ctx, request) => {
  if (!authorized(request, "AGENT_TOKEN")) return json({ error: "Unauthorized" }, 401);
  const b = (await request.json()) as Record<string, unknown>;
  const machineId = str(b.machineId, 64) ?? str(b.hostname, 64) ?? "stand";
  await ctx.runMutation(internal.agent.recordHeartbeat, {
    machineId,
    agentVersion: str(b.agentVersion, 40) ?? "unknown",
    hostname: str(b.hostname, 100) ?? "",
    ip: str(b.ip, 100),
    serverUrl: str(b.serverUrl, 200),
    link: str(b.link, 20) ?? "unknown",
    cncIp: str(b.cncIp, 100),
    connected: b.connected === true,
    linkError: str(b.linkError, 300),
    mode: str(b.mode, 40),
    state: str(b.state, 40),
    mainProgram: str(b.mainProgram, 200),
    currentProgram: str(b.currentProgram, 200),
    line: num(b.line),
    partCount: num(b.partCount),
    alarms: strings(b.alarms, 20),
    emergency: typeof b.emergency === "boolean" ? b.emergency : undefined,
    feed: num(b.feed),
    rpm: num(b.rpm),
    feedOverride: num(b.feedOverride),
    spindleOverride: num(b.spindleOverride),
    position: axes(b.position),
    ncFiles: strings(b.ncFiles, 500),
    ncFreeBytes: num(b.ncFreeBytes),
    controller: str(b.controller, 200),
    debug: strings(b.debug, 30),
    at: num(b.at) ?? Date.now(),
  });
  return json({ ok: true });
});

function strings(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, max)
    .map((item) => item.slice(0, 300));
}

function axes(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 10).flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const a = item as Record<string, unknown>;
    const axis = str(a.axis, 8);
    const machine = num(a.machine);
    const absolute = num(a.absolute);
    return axis && machine !== undefined && absolute !== undefined ? [{ axis, machine, absolute }] : [];
  });
}

const http = httpRouter();
http.route({ path: "/agent/jobs", method: "GET", handler: listJobs });
http.route({ path: "/agent/file", method: "GET", handler: downloadFile });
http.route({ path: "/agent/events", method: "POST", handler: postEvents });
http.route({ path: "/agent/heartbeat", method: "POST", handler: postHeartbeat });

http.route({ path: "/api", method: "OPTIONS", handler: external.preflight });
http.route({ pathPrefix: "/api/", method: "OPTIONS", handler: external.preflight });
http.route({ path: "/api", method: "GET", handler: external.getIndex });
http.route({ path: "/api/machines", method: "GET", handler: external.getMachines });
http.route({ path: "/api/programs", method: "GET", handler: external.getPrograms });
http.route({ path: "/api/programs", method: "POST", handler: external.postProgram });
http.route({ path: "/api/jobs", method: "GET", handler: external.getJobs });
http.route({ path: "/api/jobs", method: "POST", handler: external.postJob });
http.route({ path: "/api/jobs/cancel", method: "POST", handler: external.postCancel });
http.route({ path: "/api/jobs/finish", method: "POST", handler: external.postFinish });
http.route({ path: "/api/jobs/parts", method: "POST", handler: external.postParts });

export default http;
