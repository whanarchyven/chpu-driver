import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { authorized, corsHeaders, json, num, str } from "./lib/httpUtil";

const MAX_PROGRAM_BYTES = 5 * 1024 * 1024;

export const preflight = httpAction(async () => new Response(null, { status: 204, headers: corsHeaders }));

export const getIndex = httpAction(async (_ctx, request) => {
  if (!authorized(request, "API_TOKEN")) return json({ error: "Unauthorized" }, 401);
  return json({
    name: "cnc-erp",
    endpoints: [
      "GET  /api/machines",
      "GET  /api/programs",
      "POST /api/programs?fileName=&folder=   (тело — файл .cnc)",
      "GET  /api/jobs[?all=1]",
      "POST /api/jobs            {programId, qty, machineId?, note?}",
      "POST /api/jobs/cancel     {jobId}",
      "POST /api/jobs/finish     {jobId}",
      "POST /api/jobs/parts      {jobId, count}",
    ],
  });
});

export const getMachines = httpAction(async (ctx, request) => {
  if (!authorized(request, "API_TOKEN")) return json({ error: "Unauthorized" }, 401);
  const machines = await ctx.runQuery(api.machines.list, {});
  const now = Date.now();
  return json({ machines: machines.map((m) => ({ ...m, online: now - m.at < 30_000 })) });
});

export const getPrograms = httpAction(async (ctx, request) => {
  if (!authorized(request, "API_TOKEN")) return json({ error: "Unauthorized" }, 401);
  const programs = await ctx.runQuery(api.programs.list, {});
  return json({ programs });
});

export const postProgram = httpAction(async (ctx, request) => {
  if (!authorized(request, "API_TOKEN")) return json({ error: "Unauthorized" }, 401);
  const params = new URL(request.url).searchParams;
  const fileName = str(params.get("fileName"), 200);
  if (!fileName) return json({ error: "fileName is required" }, 400);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PROGRAM_BYTES) {
    return json({ error: "file must be 1 byte .. 5 MB" }, 413);
  }
  const storageId = await ctx.storage.store(new Blob([bytes], { type: "text/plain" }));
  try {
    const result = await ctx.runAction(internal.programs.ingest, {
      storageId,
      fileName,
      folder: str(params.get("folder"), 300),
    });
    return json(result, result.duplicate ? 200 : 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

export const getJobs = httpAction(async (ctx, request) => {
  if (!authorized(request, "API_TOKEN")) return json({ error: "Unauthorized" }, 401);
  const all = new URL(request.url).searchParams.get("all") === "1";
  const jobs = await ctx.runQuery(api.jobs.list, { includeClosed: all });
  return json({ jobs });
});

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const postJob = httpAction(async (ctx, request) => {
  if (!authorized(request, "API_TOKEN")) return json({ error: "Unauthorized" }, 401);
  const b = await body(request);
  const programId = await ctx.runQuery(internal.httpIds.programId, { raw: str(b.programId, 64) ?? "" });
  if (!programId) return json({ error: "programId not found" }, 404);
  try {
    const jobId = await ctx.runMutation(api.jobs.enqueue, {
      programId,
      qty: num(b.qty) ?? 1,
      machineId: str(b.machineId, 64),
      note: str(b.note, 500),
    });
    return json({ jobId }, 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

function jobAction(run: "cancel" | "finish" | "parts") {
  return httpAction(async (ctx, request) => {
    if (!authorized(request, "API_TOKEN")) return json({ error: "Unauthorized" }, 401);
    const b = await body(request);
    const jobId = await ctx.runQuery(internal.httpIds.jobId, { raw: str(b.jobId, 64) ?? "" });
    if (!jobId) return json({ error: "jobId not found" }, 404);
    try {
      if (run === "cancel") await ctx.runMutation(api.jobs.cancel, { jobId });
      else if (run === "finish") await ctx.runMutation(api.jobs.finish, { jobId });
      else await ctx.runMutation(api.jobs.addParts, { jobId, count: num(b.count) ?? 1 });
      return json({ ok: true });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
}

export const postCancel = jobAction("cancel");
export const postFinish = jobAction("finish");
export const postParts = jobAction("parts");
