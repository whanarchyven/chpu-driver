import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

// Ids arrive as plain strings over HTTP; these turn them into typed ids or null.
export const jobId = internalQuery({
  args: { raw: v.string() },
  returns: v.union(v.id("jobs"), v.null()),
  handler: async (ctx, args) => ctx.db.normalizeId("jobs", args.raw),
});

export const programId = internalQuery({
  args: { raw: v.string() },
  returns: v.union(v.id("programs"), v.null()),
  handler: async (ctx, args) => ctx.db.normalizeId("programs", args.raw),
});
