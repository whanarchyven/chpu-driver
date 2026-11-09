export function authorized(request: Request, kind: "AGENT_TOKEN" | "API_TOKEN"): boolean {
  const token = kind === "API_TOKEN" ? (process.env.API_TOKEN ?? process.env.AGENT_TOKEN) : process.env.AGENT_TOKEN;
  if (!token) return false;
  return request.headers.get("Authorization") === `Bearer ${token}`;
}

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

export function str(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
