import { DurableObject } from "cloudflare:workers";
import { AdminInputError, readCookieInput } from "./admin-input";
import { parsePolicy, pollApprovals } from "./approval-policy";
import { inspectChannels, unknownChannels, type ChannelHealthReport } from "./channel-health";
import { json } from "./http";
import { CookieController, type CredentialState, type CredentialStore } from "./muse";

/** One coordinator owns this personal account's rotating Cookie and renewal requests. */
export class MuseCredentials extends DurableObject<Env> {
  private readonly controller: CookieController;
  private channelProbe?: Promise<ChannelHealthReport>;
  private channelCache?: { at: number; data: ChannelHealthReport };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS credential_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
    const store: CredentialStore = {
      load: () => {
        const row = ctx.storage.sql.exec<{ value: string }>("SELECT value FROM credential_state WHERE id=1").toArray()[0];
        return row ? JSON.parse(row.value) as CredentialState : undefined;
      },
      save: (state) => {
        ctx.storage.sql.exec("INSERT INTO credential_state VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", JSON.stringify(state));
      },
    };
    this.controller = new CookieController(env, store);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS approval_decisions (id TEXT PRIMARY KEY, state TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, started INTEGER NOT NULL, finished INTEGER)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS service_events (kind TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureAlarm();
    const path = new URL(request.url).pathname;
    if (path === "/admin/channels" && request.method === "GET") return json(await this.channels());
    if (path === "/admin/cookie") {
      if (request.method === "GET") return this.dashboard(await this.controller.adminStatus());
      if (request.method !== "POST") return json({ error: "not_found" }, 404);
      try { return await this.dashboard(await this.controller.replaceCookies(await readCookieInput(request))); }
      catch (error) {
        if (error instanceof AdminInputError) return json({ error: error.code }, error.status);
        throw error;
      }
    }
    if (path === "/approvals/status" || path === "/renewal/scheduled-status") return json(await this.serviceStatus(path));
    if (path === "/approvals/poll") return json(await this.poll());
    if (path === "/probe/worker-rpc") {
      try { await this.controller.useRpc((rpc) => rpc.call("/api/session/list", 0)); return json({ ok: true, stage: "worker_owned_noise_rpc" }); }
      catch { return json({ ok: false, error: "worker_rpc_failed" }, 502); }
    }
    return this.controller.fetch(request);
  }

  /** Cron invokes only renewal; no chat or user task is submitted. */
  refresh() { return this.controller.refresh(); }

  private async channels() {
    if (this.channelCache && Date.now() - this.channelCache.at < 15_000) return this.channelCache.data;
    this.channelProbe ??= this.controller.useRpc(inspectChannels)
      .catch(() => unknownChannels())
      .then((data) => {
        this.channelCache = { at: Date.now(), data };
        this.channelProbe = undefined;
        return data;
      });
    return this.channelProbe;
  }

  /** Add the existing service summaries only to authenticated management responses. */
  private async dashboard(response: Response) {
    if (!response.ok) return response;
    const [credentials, renewal, approval] = await Promise.all([
      response.json<Record<string, unknown>>(),
      this.serviceStatus("/renewal/scheduled-status").catch(() => null),
      this.serviceStatus("/approvals/status").catch(() => null),
    ]);
    return json({ ...credentials, renewal, approval });
  }

  private async serviceStatus(path: string) {
    const kind = path === "/approvals/status" ? "approval_poll" : "scheduled_renewal";
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM service_events WHERE kind=?", kind).toArray()[0];
    if (kind === "scheduled_renewal") return { trigger: "cloudflare_cron", daily_cron_utc: "54 20 * * *",
      last_event: row ? JSON.parse(row.value) as unknown : null };
    const summary = this.ctx.storage.sql.exec<{ state: string; count: number }>("SELECT state, COUNT(*) AS count FROM approval_decisions GROUP BY state").toArray();
    return { enabled: this.env.AUTO_APPROVAL_ENABLED === "true", next_alarm_at: await this.ctx.storage.getAlarm(),
      last_event: row ? JSON.parse(row.value) as unknown : null, decisions: summary };
  }
  private record(kind: string, value: unknown) {
    this.ctx.storage.sql.exec("INSERT INTO service_events VALUES (?,?) ON CONFLICT(kind) DO UPDATE SET value=excluded.value", kind, JSON.stringify(value));
  }
  private async ensureAlarm() {
    if (this.env.AUTO_APPROVAL_ENABLED === "true" && await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + 10000);
    }
  }
  async scheduledRenewal(scheduledTime: number, cron: string) {
    const started = Date.now();
    const result = await this.controller.refresh();
    this.record("scheduled_renewal", { source: "cloudflare_scheduled", scheduled_time: scheduledTime, cron, started_at: started, completed_at: Date.now(), result });
    await this.ensureAlarm();
    return result;
  }
  async poll(source = "manual") {
    if (this.env.AUTO_APPROVAL_ENABLED !== "true") return { ok: true, enabled: false };
    const started = Date.now();
    try {
      const rules = parsePolicy(this.env.AUTO_APPROVAL_POLICY_JSON);
      if (!rules.length) throw new Error("empty_approval_policy");
      const result = await this.controller.useRpc((rpc) => pollApprovals(rpc, rules, {
        claim: (id, host, port) => {
          return this.ctx.storage.sql.exec("INSERT OR IGNORE INTO approval_decisions VALUES (?,'decision_unknown',?,?,?,NULL) RETURNING id", id, host, port, Date.now()).toArray().length === 1;
        },
        accepted: (id) => { this.ctx.storage.sql.exec("UPDATE approval_decisions SET state='rpc_accepted',finished=? WHERE id=?", Date.now(), id); },
      }));
      const status = { ok: true, enabled: true, source, started_at: started, completed_at: Date.now(), ...result };
      this.record("approval_poll", status); return status;
    } catch {
      const status = { ok: false, enabled: true, source, started_at: started, completed_at: Date.now(), error: "approval_poll_failed" };
      this.record("approval_poll", status); return status;
    }
  }
  async alarm() {
    if (this.env.AUTO_APPROVAL_ENABLED !== "true") return;
    try { await this.poll("durable_object_alarm"); }
    finally { await this.ctx.storage.setAlarm(Date.now() + 30000); }
  }
}
