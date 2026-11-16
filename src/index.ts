import { adminPage } from "./admin-page";
import { authorized, json, validBearerKey } from "./http";
export { MuseCredentials } from "./credentials";

const MUSE_ORIGIN = "https://muse.ai";
const GATEWAY_ORIGIN = "https://hatch.metaaivm.com";

async function networkProbe(): Promise<Response> {
  const checks = await Promise.all(
    [MUSE_ORIGIN, "https://api.muse.ai", GATEWAY_ORIGIN].map(async (origin) => {
      try {
        const response = await fetch(`${origin}/`, {
          redirect: "manual", signal: AbortSignal.timeout(10_000),
        });
        await response.body?.cancel();
        return { host: new URL(origin).hostname, response_received: true, status: response.status };
      } catch {
        return { host: new URL(origin).hostname, response_received: false, error: "network_failed" };
      }
    }),
  );
  const ok = checks.every((check) => check.response_received && check.status !== undefined
    && check.status !== 403 && check.status !== 407 && check.status < 500);
  return json({ ok, stage: "network", location: "worker_runtime", checks,
    note: "HTTP response received does not prove Cookie authentication or Noise RPC works." }, ok ? 200 : 502);
}

/** Route only authenticated credential operations into the per-account coordinator. */
export async function handleRequest(request: Request, env: Env,
  dispatch: (request: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") {
    return json({ ok: true, service: "cf-muse-channel", version: "1.0.0" });
  }
  if (url.search) return json({ error: "query_parameters_not_supported" }, 400);
  if (url.pathname === "/admin" || url.pathname === "/admin/cookie" || url.pathname === "/admin/channels") {
    const key = env.MUSE_ADMIN_KEY ?? "";
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((!local && url.protocol !== "https:") || !validBearerKey(key) || key === env.DEMO_KEY) return json({ error: "not_found" }, 404);
    if (url.pathname === "/admin" && request.method === "GET") return adminPage(local);
    const allowed = request.method === "GET" && url.pathname === "/admin/channels"
      || ["GET", "POST"].includes(request.method) && url.pathname === "/admin/cookie";
    if (!allowed) return json({ error: "not_found" }, 404);
    if (!(await authorized(request, key))) return json({ error: "unauthorized" }, 401);
    if (request.method === "POST" && request.headers.get("Origin") !== url.origin) return json({ error: "origin_not_allowed" }, 403);
    // Keep the admin key at the public Worker boundary.
    const forwarded = new Request(request);
    forwarded.headers.delete("Authorization");
    return dispatchSafely(forwarded, dispatch);
  }
  if (!(await authorized(request, env.DEMO_KEY ?? ""))) return json({ error: "unauthorized" }, 401);
  if (url.pathname === "/probe/network" && request.method === "POST") return networkProbe();
  if (url.pathname === "/ws" && request.method === "GET"
      && request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "websocket_upgrade_required" }, 426);
  }
  const allowed = (request.method === "POST" && ["/probe/cookie", "/credentials/refresh", "/approvals/poll", "/probe/worker-rpc"].includes(url.pathname))
    || (request.method === "GET" && ["/ws", "/credentials/status", "/approvals/status", "/renewal/scheduled-status"].includes(url.pathname));
  if (!allowed) return json({ error: "not_found" }, 404);
  return dispatchSafely(request, dispatch);
}

async function dispatchSafely(request: Request, dispatch: (request: Request) => Promise<Response>) {
  try {
    return await dispatch(request);
  } catch {
    return json({ ok: false, error: "credential_service_unavailable" }, 503);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, (forwarded) => env.CREDENTIALS.getByName("primary-account").fetch(forwarded));
  },
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const status = await env.CREDENTIALS.getByName("primary-account").scheduledRenewal(event.scheduledTime, event.cron);
    if (!status.ok) console.warn(JSON.stringify({ event: "cookie_refresh_failed", error: status.last_error }));
  },
} satisfies ExportedHandler<Env>;
