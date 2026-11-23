import { handleAdminRoute, isAdminRoute } from "./admin-route";
import type { AdminSessions } from "./admin-session";
import { authorized, json } from "./http";
export { ManagedChannels } from "./managed/runtime";
export { MuseCredentials } from "./credentials";

const MUSE_ORIGIN = "https://muse.ai";
const GATEWAY_ORIGIN = "https://hatch.metaaivm.com";
const ALARM_WATCHDOG_CRON = "*/5 * * * *";

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

/** Require credentials for account operations; the public view only reads a sanitized snapshot. */
export async function handleRequest(request: Request, env: Env,
  dispatch: (request: Request) => Promise<Response>, sessions?: AdminSessions): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") {
    return json({ ok: true, service: "cf-muse-channel", version: "1.0.0" });
  }
  if (url.search) return json({ error: "query_parameters_not_supported" }, 400);
  if (isAdminRoute(url.pathname)) {
    try { return await handleAdminRoute(request, env, dispatch, sessions); }
    catch { return json({ error: "credential_service_unavailable" }, 503); }
  }
  if (!(await authorized(request, env.DEMO_KEY ?? ""))) return json({ error: "unauthorized" }, 401);
  if (url.pathname === "/probe/network" && request.method === "POST") return networkProbe();
  if (url.pathname === "/ws" && request.method === "GET"
      && request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "websocket_upgrade_required" }, 426);
  }
  const allowed = (request.method === "POST" && ["/probe/cookie", "/credentials/refresh", "/approvals/poll", "/probe/worker-rpc", "/managed/push"].includes(url.pathname))
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

async function restoreAlarm(check: () => Promise<unknown>, failureEvent: string): Promise<void> {
  try { await check(); }
  catch { console.warn(JSON.stringify({ event: failureEvent })); }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const coordinator = env.CREDENTIALS.getByName("primary-account");
    return handleRequest(request, env, (forwarded) => {
      const path = new URL(forwarded.url).pathname;
      if (path === "/admin/managed/probe-native") return env.MOBILE.getByName("native-verification").fetch(forwarded);
      const managed = path.startsWith("/admin/managed/") || path === "/managed/push" || env.MANAGED_CHANNELS_ENABLED === "true"
        && ["/channel-health", "/admin/channels"].includes(path);
      return managed ? env.MOBILE.getByName("channels").fetch(forwarded) : coordinator.fetch(forwarded);
    }, coordinator);
  },
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const restoreChannelAlarm = () => env.MANAGED_CHANNELS_ENABLED === "true" && env.MOBILE
      ? restoreAlarm(() => env.MOBILE.getByName("channels").ensureAlarm(), "channel_alarm_watchdog_failed")
      : Promise.resolve();
    if (event.cron === ALARM_WATCHDOG_CRON) {
      await Promise.all([
        restoreChannelAlarm(),
        env.AUTO_APPROVAL_ENABLED === "true"
          ? restoreAlarm(() => env.CREDENTIALS.getByName("primary-account").ensureAlarm(), "approval_alarm_watchdog_failed")
          : Promise.resolve(),
      ]);
      return;
    }
    try {
      const status = await env.CREDENTIALS.getByName("primary-account").scheduledRenewal(event.scheduledTime, event.cron);
      if (!status.ok) console.warn(JSON.stringify({ event: "cookie_refresh_failed", error: status.last_error }));
    } finally {
      await restoreChannelAlarm();
    }
  },
} satisfies ExportedHandler<Env>;
