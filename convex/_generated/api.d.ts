/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent from "../agent.js";
import type * as externalApi from "../externalApi.js";
import type * as http from "../http.js";
import type * as httpIds from "../httpIds.js";
import type * as jobs from "../jobs.js";
import type * as lib_httpUtil from "../lib/httpUtil.js";
import type * as lib_parseGcode from "../lib/parseGcode.js";
import type * as lib_runs from "../lib/runs.js";
import type * as machines from "../machines.js";
import type * as programs from "../programs.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  externalApi: typeof externalApi;
  http: typeof http;
  httpIds: typeof httpIds;
  jobs: typeof jobs;
  "lib/httpUtil": typeof lib_httpUtil;
  "lib/parseGcode": typeof lib_parseGcode;
  "lib/runs": typeof lib_runs;
  machines: typeof machines;
  programs: typeof programs;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
