import { DurableObject } from "cloudflare:workers";
import { AdminInputError, readCookieInput } from "./admin-input";
import { ADMIN_SESSION_SECONDS } from "./admin-session";
import { parsePolicy, pollApprovals, type HeldApproval } from "./approval-policy";
import { inspectChannels, publishedChannelStates, unknownChannels, type ChannelHealthReport } from "./channel-health";
import { json } from "./http";
import { CookieController, type CredentialState, type CredentialStore } from "./muse";

const PRIMARY_ACCOUNT_ID = "primary-account";
const MAX_ACCOUNTS = 10;

type AccountRow = {
  id: string;
  label: string;
  is_default: number;
  created_at: number;
};

/** One coordinator owns the multi-account registry and each named DO owns its personal rotating Cookie. */
export class MuseCredentials extends DurableObject<Env> {
  private readonly controller: CookieController;
  private channelProbe?: Promise<ChannelHealthReport>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS credential_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS approval_decisions (id TEXT PRIMARY KEY, state TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, started INTEGER NOT NULL, finished INTEGER)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS approval_notifications (id TEXT PRIMARY KEY, notified_at INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS service_events (kind TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS admin_sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS muse_accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)");
    const store: CredentialStore = {
      load: () => {
        const row = ctx.storage.sql.exec<{ value: string }>("SELECT value FROM credential_state WHERE id=1").toArray()[0];
        return row ? JSON.parse(row.value) as CredentialState : undefined;
      },
      save: (state) => {
        ctx.storage.sql.exec("INSERT INTO credential_state VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", JSON.stringify(state));
      },
    };
    this.controller = new CookieController(env, store, () => Boolean(this.event<{ isolated?: boolean }>("isolated_account")?.isolated));
  }

  startAdminSession(hash: string) {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM admin_sessions WHERE expires_at <= ?", now);
    this.ctx.storage.sql.exec("INSERT INTO admin_sessions VALUES (?,?)", hash, now + ADMIN_SESSION_SECONDS * 1000);
  }

  hasAdminSession(hash: string) {
    const session = this.ctx.storage.sql.exec("SELECT 1 FROM admin_sessions WHERE hash=? AND expires_at>?", hash, Date.now());
    return session.toArray().length > 0;
  }

  endAdminSession(hash: string) {
    this.ctx.storage.sql.exec("DELETE FROM admin_sessions WHERE hash=?", hash);
  }

  private markIsolated() {
    if (!this.event<{ isolated?: boolean }>("isolated_account")?.isolated) {
      this.record("isolated_account", { isolated: true });
    }
  }

  private ensurePrimaryAccountRow() {
    const existing = this.ctx.storage.sql.exec<AccountRow>("SELECT * FROM muse_accounts WHERE id=?", PRIMARY_ACCOUNT_ID).toArray()[0];
    if (!existing) {
      const hasDefault = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM muse_accounts WHERE is_default=1 LIMIT 1").toArray().length > 0;
      this.ctx.storage.sql.exec(
        "INSERT INTO muse_accounts VALUES (?,?,?,?)",
        PRIMARY_ACCOUNT_ID,
        "主账号",
        hasDefault ? 0 : 1,
        Date.now(),
      );
      return;
    }
    const hasDefault = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM muse_accounts WHERE is_default=1 LIMIT 1").toArray().length > 0;
    if (!hasDefault) {
      this.ctx.storage.sql.exec("UPDATE muse_accounts SET is_default=1 WHERE id=?", PRIMARY_ACCOUNT_ID);
    }
  }

  private defaultAccountId(): string {
    const row = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM muse_accounts WHERE is_default=1 LIMIT 1").toArray()[0];
    return row?.id || PRIMARY_ACCOUNT_ID;
  }

  private hasAccount(id: string): boolean {
    if (id === PRIMARY_ACCOUNT_ID) return true;
    return this.ctx.storage.sql.exec("SELECT 1 FROM muse_accounts WHERE id=?", id).toArray().length > 0;
  }

  private forwardToAccount(accountId: string, request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set("X-Muse-Internal-Isolated", "1");
    headers.delete("X-Muse-Account");
    return this.env.CREDENTIALS.getByName(accountId).fetch(new Request(request, { headers }));
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const isInternalIsolated = request.headers.get("X-Muse-Internal-Isolated") === "1";
    if (isInternalIsolated) {
      this.markIsolated();
      if (path === "/admin/internal-init" && request.method === "POST") {
        return json({ ok: true });
      }
      if (path === "/admin/internal-wipe" && request.method === "POST") {
        this.ctx.storage.sql.exec("DELETE FROM credential_state");
        this.ctx.storage.sql.exec("DELETE FROM approval_decisions");
        this.ctx.storage.sql.exec("DELETE FROM approval_notifications");
        this.ctx.storage.sql.exec("DELETE FROM service_events");
        return json({ ok: true });
      }
      if (path === "/admin/internal-scheduled-renew" && request.method === "POST") {
        const body = await request.json<{ scheduledTime?: number; cron?: string }>().catch(
          (): { scheduledTime?: number; cron?: string } => ({}),
        );
        return json(await this.scheduledRenewal(body.scheduledTime ?? Date.now(), body.cron ?? "54 20 * * *"));
      }
    }

    if (!isInternalIsolated) {
      if (path === "/admin/accounts") {
        if (request.method === "GET") return this.listAccounts();
        if (request.method === "POST") return this.mutateAccounts(request);
        return json({ error: "not_found" }, 404);
      }

      const requestedAccount = request.headers.get("X-Muse-Account")?.trim() || "";
      const isAccountAdminPath = ["/admin/cookie", "/admin/current-cookie", "/admin/renew", "/admin/approvals/poll", "/admin/probe-rpc"].includes(path);
      const isAccountServicePath = ["/ws", "/credentials/status", "/credentials/refresh", "/probe/cookie", "/cookie-health", "/probe/worker-rpc", "/approvals/status", "/approvals/poll", "/renewal/scheduled-status"].includes(path);
      if (isAccountAdminPath || isAccountServicePath) {
        if (requestedAccount && !this.hasAccount(requestedAccount)) {
          return json({ error: "account_not_found" }, 404);
        }
        const targetAccount = requestedAccount || this.defaultAccountId();
        if (targetAccount !== PRIMARY_ACCOUNT_ID && this.hasAccount(targetAccount)) {
          return this.forwardToAccount(targetAccount, request);
        }
      }
    }

    if (path === "/channel-health" && request.method === "GET") {
      return json(publishedChannelStates(this.channelSnapshot()?.data ?? unknownChannels()));
    }
    if (path === "/cookie-health" && request.method === "GET") {
      return json({ state: await this.controller.publicCookieState() });
    }
    if (path === "/admin/current-cookie" && request.method === "POST") return this.controller.showCurrentCookie();
    await this.ensureAlarm();
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
    if (path === "/admin/renew" && request.method === "POST") {
      await this.scheduledRenewal(Date.now(), "manual_admin");
      return this.dashboard(await this.controller.adminStatus());
    }
    if (path === "/admin/approvals/poll" && request.method === "POST") {
      const pollResult = await this.poll("manual_admin");
      const dash = await (await this.dashboard(await this.controller.adminStatus())).json<Record<string, unknown>>();
      return json({ ...dash, poll_result: pollResult });
    }
    if (path === "/admin/probe-rpc" && request.method === "POST") {
      const started = Date.now();
      try {
        await this.controller.useRpc((rpc) => rpc.call("/api/session/list", 0));
        return json({ ok: true, stage: "worker_owned_noise_rpc", latency_ms: Date.now() - started });
      } catch {
        return json({ ok: false, error: "worker_rpc_failed", latency_ms: Date.now() - started }, 502);
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

  private async accountStatusSnapshot(accountId: string): Promise<Record<string, unknown>> {
    if (accountId === PRIMARY_ACCOUNT_ID) {
      const res = await this.dashboard(await this.controller.adminStatus());
      return res.json<Record<string, unknown>>();
    }
    const res = await this.forwardToAccount(accountId, new Request("https://internal/admin/cookie", { method: "GET" }));
    return res.json<Record<string, unknown>>().catch(() => ({ configured: false, ok: false, needs_login: false }));
  }

  private async listAccounts(): Promise<Response> {
    this.ensurePrimaryAccountRow();
    const rows = this.ctx.storage.sql.exec<AccountRow>(
      "SELECT id, label, is_default, created_at FROM muse_accounts ORDER BY created_at ASC, id ASC",
    ).toArray();
    const accounts = await Promise.all(rows.map(async (row) => {
      const snap = await this.accountStatusSnapshot(row.id);
      return {
        id: row.id,
        label: row.label,
        is_default: row.is_default === 1,
        created_at: row.created_at,
        configured: Boolean(snap.configured),
        ok: Boolean(snap.ok),
        needs_login: Boolean(snap.needs_login),
        last_verified_at: snap.last_verified_at ?? null,
        last_imported_at: snap.last_imported_at ?? null,
        last_error: snap.last_error ?? null,
        renewal: snap.renewal ?? null,
      };
    }));
    return json({ default_account: this.defaultAccountId(), accounts });
  }

  private async mutateAccounts(request: Request): Promise<Response> {
    this.ensurePrimaryAccountRow();
    let body: Record<string, unknown>;
    try {
      const text = await request.text();
      if (text.length > 48_000) return json({ error: "payload_too_large" }, 413);
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid_account_payload" }, 400);
    }
    const action = typeof body.action === "string" ? body.action.trim() : "";

    if (action === "create") {
      const count = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) count FROM muse_accounts").one().count;
      if (count >= MAX_ACCOUNTS) return json({ error: "account_limit_reached" }, 409);
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (!label || label.length > 40) return json({ error: "invalid_account_label" }, 400);
      const rawId = typeof body.id === "string" ? body.id.trim().toLowerCase() : "";
      const id = rawId || ("account-" + (count + 1) + "-" + Date.now().toString(36).slice(-4));
      if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(id)) return json({ error: "invalid_account_id" }, 400);
      if (this.hasAccount(id)) return json({ error: "account_already_exists" }, 409);

      const initialCookie = typeof body.cookie === "string" ? body.cookie.trim() : "";
      if (initialCookie) {
        const verifyRes = await this.forwardToAccount(id, new Request("https://internal/admin/cookie", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cookie: initialCookie }),
        }));
        if (!verifyRes.ok) return verifyRes;
      } else {
        await this.forwardToAccount(id, new Request("https://internal/admin/internal-init", { method: "POST" }));
      }

      const now = Date.now();
      this.ctx.storage.sql.exec("INSERT INTO muse_accounts VALUES (?,?,0,?)", id, label, now);
      if (body.set_default === true && initialCookie) {
        this.ctx.storage.sql.exec("UPDATE muse_accounts SET is_default = CASE WHEN id=? THEN 1 ELSE 0 END", id);
        await this.notifyManagedReconnect();
      }
      return this.listAccounts();
    }

    if (action === "activate") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id || !this.hasAccount(id)) return json({ error: "account_not_found" }, 404);
      const snap = await this.accountStatusSnapshot(id);
      if (!snap.configured) return json({ error: "account_cookie_not_configured" }, 409);
      this.ctx.storage.sql.exec("UPDATE muse_accounts SET is_default = CASE WHEN id=? THEN 1 ELSE 0 END", id);
      await this.notifyManagedReconnect();
      return this.listAccounts();
    }

    if (action === "rename") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (!id || !this.hasAccount(id)) return json({ error: "account_not_found" }, 404);
      if (!label || label.length > 40) return json({ error: "invalid_account_label" }, 400);
      this.ctx.storage.sql.exec("UPDATE muse_accounts SET label=? WHERE id=?", label, id);
      return this.listAccounts();
    }

    if (action === "delete") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id || !this.hasAccount(id)) return json({ error: "account_not_found" }, 404);
      if (id === PRIMARY_ACCOUNT_ID) return json({ error: "cannot_delete_primary_account" }, 400);
      if (this.defaultAccountId() === id) return json({ error: "cannot_delete_active_default_account" }, 409);
      await this.forwardToAccount(id, new Request("https://internal/admin/internal-wipe", { method: "POST" })).catch(() => {});
      this.ctx.storage.sql.exec("DELETE FROM muse_accounts WHERE id=?", id);
      return this.listAccounts();
    }

    return json({ error: "unsupported_account_action" }, 400);
  }

  private async notifyManagedReconnect() {
    if (this.env.MANAGED_CHANNELS_ENABLED !== "true" || !this.env.MOBILE) return;
    try {
      await this.env.MOBILE.getByName("channels").fetch(new Request("https://internal/admin/managed/reconnect-muse", {
        method: "POST",
      }));
    } catch { /* Non-fatal if managed channels are idle. */ }
  }

  /** Cron invokes only renewal; no chat or user task is submitted. */
  refresh() { return this.controller.refresh(); }

  private channelSnapshot(): { at: number; data: ChannelHealthReport } | null {
    return this.event<{ at: number; data: ChannelHealthReport }>("channel_health");
  }

  private saveChannels(data: ChannelHealthReport) {
    this.record("channel_health", { at: Date.now(), data });
    return data;
  }

  private async channels() {
    const cache = this.channelSnapshot();
    if (cache && Date.now() - cache.at < 15_000) return cache.data;
    this.channelProbe ??= this.controller.useRpc(inspectChannels)
      .catch(() => unknownChannels())
      .then((data) => this.saveChannels(data))
      .finally(() => { this.channelProbe = undefined; });
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
    const latest = this.event<unknown>(kind);
    if (kind === "scheduled_renewal") return { trigger: "cloudflare_cron", daily_cron_utc: "54 20 * * *",
      last_event: latest };
    const summary = this.ctx.storage.sql.exec<{ state: string; count: number }>("SELECT state, COUNT(*) AS count FROM approval_decisions GROUP BY state").toArray();
    return { enabled: this.env.AUTO_APPROVAL_ENABLED === "true", next_alarm_at: await this.ctx.storage.getAlarm(),
      last_event: latest, decisions: summary };
  }
  private event<T>(kind: string): T | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM service_events WHERE kind=?", kind).toArray()[0];
    return row ? JSON.parse(row.value) as T : null;
  }
  private record(kind: string, value: unknown) {
    this.ctx.storage.sql.exec("INSERT INTO service_events VALUES (?,?) ON CONFLICT(kind) DO UPDATE SET value=excluded.value", kind, JSON.stringify(value));
  }
  private approvalPollIntervalMs() {
    const raw = Number((this.env as Env & { AUTO_APPROVAL_POLL_MS?: string }).AUTO_APPROVAL_POLL_MS);
    if (Number.isFinite(raw) && raw >= 15_000 && raw <= 300_000) return Math.floor(raw);
    return 30_000;
  }
  private async ensureAlarm() {
    if (this.env.AUTO_APPROVAL_ENABLED === "true" && await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + 10000);
    }
  }
  /** 通过托管渠道发送低噪音一次性告警（审批待办 / Cookie 失效），失败不阻断凭证主流程。 */
  private async pushAlert(id: string, text: string) {
    if (this.env.MANAGED_CHANNELS_ENABLED !== "true" || !this.env.MOBILE) return;
    try {
      await this.env.MOBILE.getByName("channels").fetch(new Request("https://internal/managed/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, channel: "auto", text }),
      }));
    } catch { /* 告警通道异常不得影响凭证与审批主逻辑 */ }
  }

  private async checkCookieExpiryAlert() {
    const state = await this.controller.publicCookieState().catch(() => "unverified");
    const alerted = this.event<{ at: number }>("cookie_expired_alert");
    if (state === "needs_login") {
      if (!alerted) {
        const at = Date.now();
        this.record("cookie_expired_alert", { at });
        await this.pushAlert("cookie-expired-" + at, "⚠️ Muse Cookie 已过期（401），请登录管理台 /admin 重新导入新 Cookie。");
      }
    } else if (state === "healthy" && alerted) {
      this.ctx.storage.sql.exec("DELETE FROM service_events WHERE kind='cookie_expired_alert'");
    }
  }

  async scheduledRenewal(scheduledTime: number, cron: string) {
    const started = Date.now();
    const result = await this.controller.refresh();
    this.record("scheduled_renewal", { source: "cloudflare_scheduled", scheduled_time: scheduledTime, cron, started_at: started, completed_at: Date.now(), result });
    await this.checkCookieExpiryAlert();
    await this.ensureAlarm();
    if (!this.event<{ isolated?: boolean }>("isolated_account")?.isolated && cron !== "manual_admin") {
      const secondary = this.ctx.storage.sql.exec<{ id: string }>(
        "SELECT id FROM muse_accounts WHERE id <> ?", PRIMARY_ACCOUNT_ID,
      ).toArray();
      for (const row of secondary) {
        await this.forwardToAccount(row.id, new Request("https://internal/admin/internal-scheduled-renew", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scheduledTime, cron }),
        })).catch(() => {});
      }
    }
    return result;
  }
  async poll(source = "manual") {
    if (this.env.AUTO_APPROVAL_ENABLED !== "true") return { ok: true, enabled: false };
    const started = Date.now();
    const heldItems: HeldApproval[] = [];
    try {
      const rules = parsePolicy(this.env.AUTO_APPROVAL_POLICY_JSON);
      if (!rules.length) throw new Error("empty_approval_policy");
      const result = await this.controller.useRpc(async (rpc) => {
        const result = await pollApprovals(rpc, rules, {
          claim: (id, host, port) => {
            return this.ctx.storage.sql.exec("INSERT OR IGNORE INTO approval_decisions VALUES (?,'decision_unknown',?,?,?,NULL) RETURNING id", id, host, port, Date.now()).toArray().length === 1;
          },
          accepted: (id) => { this.ctx.storage.sql.exec("UPDATE approval_decisions SET state='rpc_accepted',finished=? WHERE id=?", Date.now(), id); },
          held: (item) => { heldItems.push(item); },
        });
        // Piggyback on the existing scheduled session. Anonymous reads can never start one.
        if (this.env.MANAGED_CHANNELS_ENABLED !== "true" && source === "durable_object_alarm"
          && Date.now() - (this.channelSnapshot()?.at ?? 0) >= 60_000) {
          try { this.saveChannels(await inspectChannels(rpc)); } catch { /* Status sampling is independent of approval decisions. */ }
        }
        return result;
      });
      if (heldItems.length) {
        const now = Date.now();
        this.ctx.storage.sql.exec("DELETE FROM approval_notifications WHERE notified_at < ?", now - 7 * 24 * 3600 * 1000);
        for (const item of heldItems) {
          const inserted = this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO approval_notifications VALUES (?,?) RETURNING id", item.id, now,
          ).toArray().length === 1;
          if (!inserted) continue;
          const remainMin = Math.max(1, Math.round((item.expiresAt - now) / 60_000));
          await this.pushAlert(
            "approval-" + item.id,
            `⚠️ Muse 有待人工确认的外网访问审批\n目标：${item.method} ${item.host}:${item.port} (${item.scheme})\n剩余约 ${remainMin} 分钟过期，未在自动放行白名单内，请到 Muse 确认。`,
          );
        }
      }
      await this.checkCookieExpiryAlert();
      const status = { ok: true, enabled: true, source, started_at: started, completed_at: Date.now(), ...result };
      this.record("approval_poll", status); return status;
    } catch {
      await this.checkCookieExpiryAlert();
      const status = { ok: false, enabled: true, source, started_at: started, completed_at: Date.now(), error: "approval_poll_failed" };
      this.record("approval_poll", status); return status;
    }
  }
  async alarm() {
    if (this.env.AUTO_APPROVAL_ENABLED !== "true") return;
    try { await this.poll("durable_object_alarm"); }
    finally { await this.ctx.storage.setAlarm(Date.now() + this.approvalPollIntervalMs()); }
  }
}
