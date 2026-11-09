import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { gcodePreviewSvg, parseGcode, parseProgramName } from "./lib/parseGcode";
import { statsValidator } from "./schema";

const MAX_PROGRAM_BYTES = 5 * 1024 * 1024;

export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

function latin1(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return text;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const ingestResult = v.object({ programId: v.id("programs"), duplicate: v.boolean() });

export const ingest = internalAction({
  args: { storageId: v.id("_storage"), fileName: v.string(), folder: v.optional(v.string()) },
  returns: ingestResult,
  handler: async (ctx, args): Promise<{ programId: Id<"programs">; duplicate: boolean }> => {
    const blob = await ctx.storage.get(args.storageId);
    if (!blob) throw new Error("Файл не загрузился");
    if (blob.size > MAX_PROGRAM_BYTES) {
      await ctx.storage.delete(args.storageId);
      throw new Error("Файл больше 5 МБ");
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sha256 = await sha256Hex(bytes);
    const fileName = args.fileName.replace(/^.*[\\/]/, "").trim();
    const existing = await ctx.runQuery(internal.programs.bySha, { sha256, fileName });
    if (existing) {
      await ctx.storage.delete(args.storageId);
      return { programId: existing, duplicate: true };
    }
    const text = latin1(bytes);
    const stats = parseGcode(text);
    const name = parseProgramName(fileName, args.folder);
    const previewId = await ctx.storage.store(new Blob([gcodePreviewSvg(text)], { type: "image/svg+xml" }));
    const programId: Id<"programs"> = await ctx.runMutation(internal.programs.insert, {
      fileName,
      folder: args.folder?.slice(0, 300),
      fileId: args.storageId,
      sha256,
      size: bytes.length,
      previewId,
      stats,
      brand: name.brand ?? undefined,
      kind: name.kind ?? undefined,
      side: name.side ?? undefined,
      widthMm: name.widthMm ?? undefined,
      thicknessMm: name.thicknessMm ?? undefined,
    });
    return { programId, duplicate: false };
  },
});

export const create = action({
  args: { storageId: v.id("_storage"), fileName: v.string(), folder: v.optional(v.string()) },
  returns: ingestResult,
  handler: async (ctx, args): Promise<{ programId: Id<"programs">; duplicate: boolean }> =>
    await ctx.runAction(internal.programs.ingest, args),
});

export const bySha = internalQuery({
  args: { sha256: v.string(), fileName: v.string() },
  returns: v.union(v.id("programs"), v.null()),
  handler: async (ctx, args) => {
    const same = await ctx.db
      .query("programs")
      .withIndex("by_sha256", (q) => q.eq("sha256", args.sha256))
      .collect();
    const match = same.find((program) => program.fileName === args.fileName && !program.archived);
    return match?._id ?? null;
  },
});

export const insert = internalMutation({
  args: {
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
  },
  returns: v.id("programs"),
  handler: async (ctx, args) => {
    // A new version of a file with the same name replaces the old one in the list.
    const older = await ctx.db
      .query("programs")
      .withIndex("by_file_name", (q) => q.eq("fileName", args.fileName))
      .collect();
    for (const program of older) {
      if (!program.archived) await ctx.db.patch(program._id, { archived: true });
    }
    return await ctx.db.insert("programs", { ...args, createdAt: Date.now() });
  },
});

const programRow = v.object({
  _id: v.id("programs"),
  fileName: v.string(),
  folder: v.optional(v.string()),
  sha256: v.string(),
  size: v.number(),
  stats: statsValidator,
  brand: v.optional(v.string()),
  kind: v.optional(v.string()),
  side: v.optional(v.union(v.literal("L"), v.literal("R"))),
  widthMm: v.optional(v.number()),
  thicknessMm: v.optional(v.number()),
  previewUrl: v.union(v.string(), v.null()),
  createdAt: v.number(),
});

export const list = query({
  args: {},
  returns: v.array(programRow),
  handler: async (ctx) => {
    const programs = await ctx.db.query("programs").withIndex("by_created").order("desc").take(500);
    const rows = [];
    for (const program of programs) {
      if (program.archived) continue;
      rows.push({
        _id: program._id,
        fileName: program.fileName,
        folder: program.folder,
        sha256: program.sha256,
        size: program.size,
        stats: program.stats,
        brand: program.brand,
        kind: program.kind,
        side: program.side,
        widthMm: program.widthMm,
        thicknessMm: program.thicknessMm,
        previewUrl: program.previewId ? await ctx.storage.getUrl(program.previewId) : null,
        createdAt: program.createdAt,
      });
    }
    return rows.sort((a, b) => a.fileName.localeCompare(b.fileName, "ru"));
  },
});

export const archive = mutation({
  args: { programId: v.id("programs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.programId, { archived: true });
    return null;
  },
});
