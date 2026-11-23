import { DurableObject } from "cloudflare:workers";
import { AdminInputError, readCookieInput } from "./admin-input";
import { ADMIN_SESSION_SECONDS } from "./admin-session";
import { APPROVAL_EVENTS_HEADER, parsePolicy, pollApprovals, type HeldApproval } from "./approval-policy";
import { inspectChannels, publishedChannelStates, unknownChannels, type ChannelHealthReport } from "./channel-health";
import { json } from "./http";
import { MANAGED_MUSE_SOCKET, MUSE_ACCOUNT_HEADER, PRIMARY_ACCOUNT_ID } from "./managed/muse-owner";
import { CookieController, type CredentialState, type CredentialStore } from "./muse";

const MAX_ACCOUNTS = 20;
const COOLDOWN_MS = 60_000;
const PRIMARY_APPROVAL_RECONCILE_MS = 300_000;

export type PoolStrategy = "failover" | "round_robin" | "lru";

type AccountRow = {
  id: string;
  label: string;
  is_default: number;
  enabled: number;
  last_used_at: number;
  cooldown_until: number;
  success_count: number;
  fail_count: number;
  created_at: number;
};

/** One coordinator owns the multi-account registry and each named DO owns its personal rotating Cookie. */
export class MuseCredentials extends DurableObject<Env> {
  private readonly controller: CookieController;
  private channelProbe?: Promise<ChannelHealthReport>;
  private schemaReady = false;
  private rrCursor = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS credential_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS approval_decisions (id TEXT PRIMARY KEY, state TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, started INTEGER NOT NULL, finished INTEGER)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS approval_notifications (id TEXT PRIMARY KEY, notified_at INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS service_events (kind TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS admin_sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS muse_accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, last_used_at INTEGER NOT NULL DEFAULT 0, cooldown_until INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)");
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

  private ensureAccountSchema() {
    if (this.schemaReady) return;
    const cols = new Set(
      this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(muse_accounts)").toArray().map((c) => c.name),
    );
    const additions: Array<[string, string]> = [
      ["enabled", "INTEGER NOT NULL DEFAULT 1"],
      ["last_used_at", "INTEGER NOT NULL DEFAULT 0"],
      ["cooldown_until", "INTEGER NOT NULL DEFAULT 0"],
      ["success_count", "INTEGER NOT NULL DEFAULT 0"],
      ["fail_count", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [col, ddl] of additions) {
      if (!cols.has(col)) {
        this.ctx.storage.sql.exec(`ALTER TABLE muse_accounts ADD COLUMN ${col} ${ddl}`);
      }
    }
    this.schemaReady = true;
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

  private isIsolated(): boolean {
    return Boolean(this.event<{ isolated?: boolean }>("isolated_account")?.isolated);
  }

  private markIsolated() {
    if (!this.isIsolated()) {
      this.record("isolated_account", { isolated: true });
    }
  }

  private ensurePrimaryAccountRow() {
    this.ensureAccountSchema();
    const existing = this.ctx.storage.sql.exec<AccountRow>("SELECT * FROM muse_accounts WHERE id=?", PRIMARY_ACCOUNT_ID).toArray()[0];
    if (!existing) {
      const hasDefault = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM muse_accounts WHERE is_default=1 LIMIT 1").toArray().length > 0;
      this.ctx.storage.sql.exec(
        "INSERT INTO muse_accounts (id, label, is_default, enabled, last_used_at, cooldown_until, success_count, fail_count, created_at) VALUES (?,?,?,1,0,0,0,0,?)",
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
    this.ensureAccountSchema();
    const row = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM muse_accounts WHERE is_default=1 LIMIT 1").toArray()[0];
    return row?.id || PRIMARY_ACCOUNT_ID;
  }

  private poolStrategy(): PoolStrategy {
    const saved = this.event<{ strategy?: string }>("pool_config")?.strategy;
    if (saved === "round_robin" || saved === "lru" || saved === "failover") return saved;
    return "failover";
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

  private async handleAccountLocal(request: Request, path: string): Promise<Response> {
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
      try {
        const result = await this.controller.replaceCookies(await readCookieInput(request));
        if (result.ok) await this.notifyManagedReconnect();
        return await this.dashboard(result);
      }
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
      const explicitAccount = request.headers.get("X-Muse-Account")?.trim();
      const pollResult = explicitAccount ? await this.pollLocal("manual_admin") : await this.poll("manual_admin");
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
    if (path === "/approvals/poll") {
      const explicitAccount = request.headers.get("X-Muse-Account")?.trim();
      return json(explicitAccount ? await this.pollLocal("manual") : await this.poll());
    }
    if (path === "/probe/worker-rpc") {
      try { await this.controller.useRpc((rpc) => rpc.call("/api/session/list", 0)); return json({ ok: true, stage: "worker_owned_noise_rpc" }); }
      catch { return json({ ok: false, error: "worker_rpc_failed" }, 502); }
    }
    return this.controller.fetch(request);
  }

  private async dispatchAccount(accountId: string, request: Request, path: string): Promise<Response> {
    if (accountId === PRIMARY_ACCOUNT_ID) {
      return this.handleAccountLocal(request, path);
    }
    return this.forwardToAccount(accountId, request);
  }

  private markPoolOutcome(accountId: string, ok: boolean) {
    const now = Date.now();
    if (ok) {
      this.ctx.storage.sql.exec(
        "UPDATE muse_accounts SET last_used_at=?, cooldown_until=0, success_count=success_count+1 WHERE id=?",
        now,
        accountId,
      );
    } else {
      this.ctx.storage.sql.exec(
        "UPDATE muse_accounts SET cooldown_until=?, fail_count=fail_count+1 WHERE id=?",
        now + COOLDOWN_MS,
        accountId,
      );
    }
  }

  private async dispatchPooledRequest(request: Request, path: string): Promise<Response> {
    this.ensurePrimaryAccountRow();
    const enabledRows = this.ctx.storage.sql.exec<AccountRow>(
      "SELECT * FROM muse_accounts WHERE enabled=1 ORDER BY created_at ASC, id ASC",
    ).toArray();

    if (enabledRows.length === 0) {
      return json({ ok: false, error: "no_enabled_accounts_in_pool" }, 503);
    }
    if (enabledRows.length === 1) {
      const only = enabledRows[0];
      const res = await this.dispatchAccount(only.id, request, path);
      const ok = res.status === 101 || res.ok;
      this.markPoolOutcome(only.id, ok);
      return this.markManagedSocket(request, path, only.id, res);
    }

    const now = Date.now();
    const snapshots = await Promise.all(
      enabledRows.map(async (row) => ({
        row,
        snap: await this.accountStatusSnapshot(row.id),
      })),
    );
    let candidates = snapshots.filter(({ snap }) => Boolean(snap.configured) && !snap.needs_login);
    if (!candidates.length) {
      // 保留冷启动时从 env.MUSE_COOKIE 自动初始化的能力
      candidates = snapshots.filter(({ row }) => row.id === PRIMARY_ACCOUNT_ID);
      if (!candidates.length) {
        return json({ ok: false, error: "no_healthy_accounts_in_pool" }, 503);
      }
    }

    const strategy = this.poolStrategy();
    const ready = candidates.filter(({ row }) => (row.cooldown_until ?? 0) <= now);
    const cooling = candidates.filter(({ row }) => (row.cooldown_until ?? 0) > now)
      .sort((a, b) => (a.row.cooldown_until ?? 0) - (b.row.cooldown_until ?? 0));

    let orderedReady = ready;
    if (strategy === "failover") {
      orderedReady = [...ready].sort((a, b) => (b.row.is_default - a.row.is_default) || (a.row.created_at - b.row.created_at));
    } else if (strategy === "lru") {
      orderedReady = [...ready].sort((a, b) => ((a.row.last_used_at ?? 0) - (b.row.last_used_at ?? 0)) || (a.row.created_at - b.row.created_at));
    } else if (strategy === "round_robin" && ready.length > 0) {
      const offset = this.rrCursor % ready.length;
      this.rrCursor = (this.rrCursor + 1) % 1_000_000;
      orderedReady = [...ready.slice(offset), ...ready.slice(0, offset)];
    }

    const sequence = [...orderedReady, ...cooling];
    let lastResponse: Response | null = null;
    for (let i = 0; i < sequence.length; i++) {
      const candidate = sequence[i];
      const attemptReq = i === sequence.length - 1 ? request : request.clone();
      try {
        const res = await this.dispatchAccount(candidate.row.id, attemptReq, path);
        const ok = res.status === 101 || res.ok;
        this.markPoolOutcome(candidate.row.id, ok);
        if (ok) return this.markManagedSocket(request, path, candidate.row.id, res);
        lastResponse = res;
      } catch {
        this.markPoolOutcome(candidate.row.id, false);
      }
    }
    return lastResponse ?? json({ ok: false, error: "pool_dispatch_failed" }, 502);
  }

  private markManagedSocket(request: Request, path: string, id: string, response: Response) {
    if (response.status !== 101 || !response.webSocket || new URL(request.url).hostname !== "internal") return response;
    const managed = path === MANAGED_MUSE_SOCKET;
    const events = (path === "/ws" || managed) && id === PRIMARY_ACCOUNT_ID
      && request.headers.get(APPROVAL_EVENTS_HEADER) === "1" && this.approvalEventsEnabled();
    if (!managed && !events) return response;
    const headers = new Headers(response.headers);
    if (managed) headers.set(MUSE_ACCOUNT_HEADER, id);
    if (events) headers.set(APPROVAL_EVENTS_HEADER, "1");
    return new Response(null, { status: 101, webSocket: response.webSocket, headers });
  }

  /** Account candidates for read-only discovery of managed sessions created before ownership was stored. */
  managedAccountIds(): string[] {
    this.ensurePrimaryAccountRow();
    return this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM muse_accounts WHERE enabled=1 ORDER BY created_at,id")
      .toArray().map((row) => row.id);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === MANAGED_MUSE_SOCKET && (url.hostname !== "internal" || request.method !== "GET")) {
      return json({ error: "not_found" }, 404);
    }
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
        const body = await request.json<{ scheduledTime?: number; cron?: string; accountLabel?: string }>().catch(
          (): { scheduledTime?: number; cron?: string; accountLabel?: string } => ({}),
        );
        return json(await this.scheduledRenewal(body.scheduledTime ?? Date.now(), body.cron ?? "54 20 * * *", body.accountLabel));
      }
      if (path === "/admin/internal-poll-approvals" && request.method === "POST") {
        const body = await request.json<{ source?: string; accountLabel?: string }>().catch(
          (): { source?: string; accountLabel?: string } => ({}),
        );
        return json(await this.pollLocal(body.source ?? "durable_object_alarm", body.accountLabel));
      }
      return this.handleAccountLocal(request, path);
    }

    if (path === "/admin/accounts") {
      if (request.method === "GET") return this.listAccounts();
      if (request.method === "POST") return this.mutateAccounts(request);
      return json({ error: "not_found" }, 404);
    }

    const requestedAccount = request.headers.get("X-Muse-Account")?.trim() || "";
    if (path === MANAGED_MUSE_SOCKET) {
      if (!requestedAccount) return this.dispatchPooledRequest(request, path);
      this.ensurePrimaryAccountRow();
      const row = this.ctx.storage.sql.exec<{ enabled: number }>("SELECT enabled FROM muse_accounts WHERE id=?", requestedAccount).toArray()[0];
      if (!row?.enabled) return json({ error: "managed_account_unavailable" }, 409);
      return this.markManagedSocket(request, path, requestedAccount, await this.dispatchAccount(requestedAccount, request, path));
    }
    const isAccountAdminPath = ["/admin/cookie", "/admin/current-cookie", "/admin/renew", "/admin/probe-rpc"].includes(path);
    const isPoolExecutionPath = ["/ws", "/probe/worker-rpc", "/probe/cookie", "/credentials/refresh"].includes(path);
    const isAccountStatusPath = ["/credentials/status", "/cookie-health"].includes(path);

    if (requestedAccount) {
      if (!this.hasAccount(requestedAccount)) {
        return json({ error: "account_not_found" }, 404);
      }
      return this.dispatchAccount(requestedAccount, request, path);
    }

    if (isPoolExecutionPath) {
      return this.dispatchPooledRequest(request, path);
    }

    if (isAccountAdminPath || isAccountStatusPath) {
      const targetAccount = this.defaultAccountId();
      if (targetAccount !== PRIMARY_ACCOUNT_ID && this.hasAccount(targetAccount)) {
        const forwarded = await this.forwardToAccount(targetAccount, request);
        if (forwarded.ok && ["/admin/cookie", "/admin/renew"].includes(path)) {
          const payload = await forwarded.json<Record<string, unknown>>().catch(() => null);
          if (payload) {
            const [renewal, approval] = await Promise.all([
              this.serviceStatus("/renewal/scheduled-status").catch(() => null),
              this.serviceStatus("/approvals/status").catch(() => null),
            ]);
            return json({ ...payload, renewal: renewal ?? payload.renewal, approval: approval ?? payload.approval });
          }
        }
        return forwarded;
      }
    }

    return this.handleAccountLocal(request, path);
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
    const now = Date.now();
    const rows = this.ctx.storage.sql.exec<AccountRow>(
      "SELECT id, label, is_default, enabled, last_used_at, cooldown_until, success_count, fail_count, created_at FROM muse_accounts ORDER BY created_at ASC, id ASC",
    ).toArray();
    const accounts = await Promise.all(rows.map(async (row) => {
      const snap = await this.accountStatusSnapshot(row.id);
      return {
        id: row.id,
        label: row.label,
        is_default: row.is_default === 1,
        enabled: row.enabled === 1,
        last_used_at: row.last_used_at || null,
        cooldown_until: (row.cooldown_until && row.cooldown_until > now) ? row.cooldown_until : null,
        success_count: row.success_count ?? 0,
        fail_count: row.fail_count ?? 0,
        created_at: row.created_at,
        configured: Boolean(snap.configured),
        ok: Boolean(snap.ok),
        needs_login: Boolean(snap.needs_login),
        vm_id: snap.vm_id ?? null,
        last_verified_at: snap.last_verified_at ?? null,
        last_imported_at: snap.last_imported_at ?? null,
        last_error: snap.last_error ?? null,
        renewal: snap.renewal ?? null,
      };
    }));
    const isVmSleeping = (snap: Record<string, unknown>) => {
      const err = snap.last_error as { stage?: string; upstream_status?: number } | null | undefined;
      return Boolean(
        snap.configured
        && !snap.needs_login
        && err?.stage === "websocket"
        && (err.upstream_status === 502 || err.upstream_status === 503 || err.upstream_status === 504),
      );
    };
    const stats = {
      total: accounts.length,
      enabled: accounts.filter((a) => a.enabled).length,
      healthy: accounts.filter((a) => a.enabled && !a.needs_login && !a.cooldown_until && (a.ok || isVmSleeping(a))).length,
      needs_login: accounts.filter((a) => a.needs_login).length,
      cooling: accounts.filter((a) => Boolean(a.cooldown_until)).length,
    };
    return json({
      default_account: this.defaultAccountId(),
      pool_strategy: this.poolStrategy(),
      stats,
      accounts,
    });
  }

  private async createSingleAccount(params: {
    label: string;
    rawId?: string;
    cookiePayload?: unknown;
    enabled?: boolean;
    setDefault?: boolean;
  }): Promise<{ ok: true; id: string } | { ok: false; response: Response; error: string }> {
    const count = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) count FROM muse_accounts").one().count;
    if (count >= MAX_ACCOUNTS) {
      return { ok: false, response: json({ error: "account_limit_reached" }, 409), error: "account_limit_reached" };
    }
    const label = params.label.trim();
    if (!label || label.length > 40) {
      return { ok: false, response: json({ error: "invalid_account_label" }, 400), error: "invalid_account_label" };
    }
    const rawId = (params.rawId ?? "").trim().toLowerCase();
    const suffix = Math.random().toString(36).slice(2, 6);
    const id = rawId || ("account-" + (count + 1) + "-" + Date.now().toString(36).slice(-3) + suffix.slice(0, 2));
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(id)) {
      return { ok: false, response: json({ error: "invalid_account_id" }, 400), error: "invalid_account_id" };
    }
    if (this.hasAccount(id)) {
      return { ok: false, response: json({ error: "account_already_exists" }, 409), error: "account_already_exists" };
    }

    const initialCookie = typeof params.cookiePayload === "string"
      ? params.cookiePayload.trim()
      : (params.cookiePayload && typeof params.cookiePayload === "object")
        ? JSON.stringify(params.cookiePayload)
        : "";

    if (initialCookie) {
      const verifyRes = await this.forwardToAccount(id, new Request("https://internal/admin/cookie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: initialCookie }),
      }));
      if (!verifyRes.ok) {
        return { ok: false, response: verifyRes, error: "cookie_not_saved" };
      }
    } else {
      await this.forwardToAccount(id, new Request("https://internal/admin/internal-init", { method: "POST" }));
    }

    const enabled = (initialCookie && params.enabled !== false) ? 1 : 0;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO muse_accounts (id, label, is_default, enabled, last_used_at, cooldown_until, success_count, fail_count, created_at) VALUES (?,?,0,?,0,0,0,0,?)",
      id,
      label,
      enabled,
      now,
    );
    if (params.setDefault === true && initialCookie) {
      this.ctx.storage.sql.exec("UPDATE muse_accounts SET is_default = CASE WHEN id=? THEN 1 ELSE 0 END, enabled = CASE WHEN id=? THEN 1 ELSE enabled END", id, id);
      await this.notifyManagedReconnect();
    }
    return { ok: true, id };
  }

  private async mutateAccounts(request: Request): Promise<Response> {
    this.ensurePrimaryAccountRow();
    let body: Record<string, unknown>;
    try {
      const text = await request.text();
      if (text.length > 200_000) return json({ error: "payload_too_large" }, 413);
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid_account_payload" }, 400);
    }
    const action = typeof body.action === "string" ? body.action.trim() : "";

    if (action === "create") {
      const res = await this.createSingleAccount({
        label: typeof body.label === "string" ? body.label : "",
        rawId: typeof body.id === "string" ? body.id : undefined,
        cookiePayload: body.cookie,
        enabled: body.enabled !== false,
        setDefault: body.set_default === true,
      });
      if (!res.ok) return res.response;
      return this.listAccounts();
    }

    if (action === "batch_create") {
      const rawItems = Array.isArray(body.items) ? body.items : [];
      if (!rawItems.length || rawItems.length > MAX_ACCOUNTS) {
        return json({ error: "invalid_batch_items" }, 400);
      }
      const created: Array<{ id: string; label: string }> = [];
      const failed: Array<{ label: string; error: string }> = [];
      for (const item of rawItems) {
        if (!item || typeof item !== "object") {
          failed.push({ label: "未知项", error: "invalid_item" });
          continue;
        }
        const rec = item as Record<string, unknown>;
        const label = typeof rec.label === "string" ? rec.label.trim() : "";
        const res = await this.createSingleAccount({
          label,
          rawId: typeof rec.id === "string" ? rec.id : undefined,
          cookiePayload: rec.cookie,
          enabled: rec.enabled !== false,
          setDefault: false,
        });
        if (res.ok) {
          created.push({ id: res.id, label });
        } else {
          failed.push({ label: label || "未命名", error: res.error });
        }
      }
      const listData = await (await this.listAccounts()).json<Record<string, unknown>>();
      return json({ ...listData, batch_result: { created, failed } });
    }

    if (action === "toggle") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id || !this.hasAccount(id)) return json({ error: "account_not_found" }, 404);
      const nextEnabled = body.enabled === true ? 1 : 0;
      if (nextEnabled === 1) {
        const snap = await this.accountStatusSnapshot(id);
        if (!snap.configured) return json({ error: "account_cookie_not_configured" }, 409);
      }
      this.ctx.storage.sql.exec("UPDATE muse_accounts SET enabled=?, cooldown_until=0 WHERE id=?", nextEnabled, id);
      await this.notifyManagedReconnect();
      return this.listAccounts();
    }

    if (action === "set_strategy") {
      const strategy = typeof body.strategy === "string" ? body.strategy.trim() : "";
      if (strategy !== "failover" && strategy !== "round_robin" && strategy !== "lru") {
        return json({ error: "invalid_pool_strategy" }, 400);
      }
      this.record("pool_config", { strategy });
      return this.listAccounts();
    }

    if (action === "clear_cooldown") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id || !this.hasAccount(id)) return json({ error: "account_not_found" }, 404);
      this.ctx.storage.sql.exec("UPDATE muse_accounts SET cooldown_until=0 WHERE id=?", id);
      return this.listAccounts();
    }

    if (action === "renew_all") {
      const rows = this.ctx.storage.sql.exec<AccountRow>(
        "SELECT id, label, enabled FROM muse_accounts ORDER BY created_at ASC, id ASC",
      ).toArray().filter((r) => r.enabled === 1);
      const started = Date.now();
      const results = await Promise.all(rows.map(async (row) => {
        try {
          if (row.id === PRIMARY_ACCOUNT_ID) {
            const r = await this.controller.refresh();
            await this.checkCookieExpiryAlert(rows.length > 1 ? row.label : undefined);
            return { id: row.id, label: row.label, ok: Boolean(r.ok) };
          }
          const resp = await this.forwardToAccount(row.id, new Request("https://internal/admin/internal-scheduled-renew", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scheduledTime: started, cron: "manual_admin", accountLabel: row.label }),
          }));
          const payload = await resp.json<{ ok?: boolean }>().catch(() => ({ ok: false }));
          return { id: row.id, label: row.label, ok: Boolean(payload.ok) };
        } catch {
          return { id: row.id, label: row.label, ok: false };
        }
      }));
      const accountsOk = results.filter((r) => r.ok).length;
      const summaryResult = {
        ok: results.length === 0 ? true : accountsOk === results.length,
        accounts_total: results.length,
        accounts_ok: accountsOk,
        per_account: results,
      };
      this.record("scheduled_renewal", {
        source: "cloudflare_scheduled",
        scheduled_time: started,
        cron: "manual_admin",
        started_at: started,
        completed_at: Date.now(),
        result: summaryResult,
      });
      const listData = await (await this.listAccounts()).json<Record<string, unknown>>();
      return json({ ...listData, renew_result: results });
    }

    if (action === "activate") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id || !this.hasAccount(id)) return json({ error: "account_not_found" }, 404);
      const snap = await this.accountStatusSnapshot(id);
      if (!snap.configured) return json({ error: "account_cookie_not_configured" }, 409);
      this.ctx.storage.sql.exec("UPDATE muse_accounts SET is_default = CASE WHEN id=? THEN 1 ELSE 0 END, enabled = CASE WHEN id=? THEN 1 ELSE enabled END", id, id);
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
      await this.notifyManagedReconnect();
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
    const latest = this.event<Record<string, unknown>>(kind);
    if (kind === "scheduled_renewal") {
      return {
        trigger: "cloudflare_cron",
        daily_cron_utc: "54 20 * * *",
        last_event: latest,
      };
    }
    const localSummary = this.ctx.storage.sql.exec<{ state: string; count: number }>(
      "SELECT state, COUNT(*) AS count FROM approval_decisions GROUP BY state",
    ).toArray();
    const totalAccepted = typeof latest?.total_accepted === "number" ? latest.total_accepted : null;
    const summary = totalAccepted === null
      ? localSummary
      : (() => {
        const rest = localSummary.filter((s) => s.state !== "rpc_accepted");
        return totalAccepted > 0 ? [{ state: "rpc_accepted", count: totalAccepted }, ...rest] : rest;
      })();
    return {
      enabled: this.env.AUTO_APPROVAL_ENABLED === "true",
      next_alarm_at: await this.ctx.storage.getAlarm(),
      last_event: latest,
      primary_event: this.event<Record<string, unknown>>("primary_approval_event"),
      decisions: summary,
    };
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
  /** Restore approval polling when the Worker watchdog finds the alarm missing. */
  async ensureAlarm(): Promise<void> {
    if (this.isIsolated()) return;
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

  private async checkCookieExpiryAlert(accountLabel?: string) {
    const state = await this.controller.publicCookieState().catch(() => "unverified");
    const alerted = this.event<{ at: number }>("cookie_expired_alert");
    if (state === "needs_login") {
      if (!alerted) {
        const at = Date.now();
        this.record("cookie_expired_alert", { at });
        const suffix = accountLabel ? `（账号：${accountLabel}）` : "";
        await this.pushAlert("cookie-expired-" + at, `⚠️ Muse Cookie 已过期（401）${suffix}，请登录管理台 /admin 重新导入新 Cookie。`);
      }
    } else if (state === "healthy" && alerted) {
      this.ctx.storage.sql.exec("DELETE FROM service_events WHERE kind='cookie_expired_alert'");
    }
  }

  async scheduledRenewal(scheduledTime: number, cron: string, accountLabel?: string) {
    const started = Date.now();
    const isolated = this.isIsolated();
    if (isolated || cron === "manual_admin") {
      const result = await this.controller.refresh();
      this.record("scheduled_renewal", {
        source: "cloudflare_scheduled",
        scheduled_time: scheduledTime,
        cron,
        started_at: started,
        completed_at: Date.now(),
        result,
      });
      await this.checkCookieExpiryAlert(isolated ? accountLabel : undefined);
      if (!isolated) await this.ensureAlarm();
      return result;
    }

    this.ensurePrimaryAccountRow();
    const enabledAccounts = this.ctx.storage.sql.exec<AccountRow>(
      "SELECT id, label FROM muse_accounts WHERE enabled = 1 ORDER BY created_at ASC, id ASC",
    ).toArray();

    // 仅存在主账号且已开启时，保持原有单账号返回结构与零额外 DO 请求
    if (enabledAccounts.length === 1 && enabledAccounts[0].id === PRIMARY_ACCOUNT_ID) {
      const result = await this.controller.refresh();
      const fullResult = { ...result, accounts_total: 1, accounts_ok: result.ok ? 1 : 0 };
      this.record("scheduled_renewal", {
        source: "cloudflare_scheduled",
        scheduled_time: scheduledTime,
        cron,
        started_at: started,
        completed_at: Date.now(),
        result: fullResult,
      });
      await this.checkCookieExpiryAlert();
      await this.ensureAlarm();
      return fullResult;
    }

    const perAccount = await Promise.all(
      enabledAccounts.map(async (row) => {
        try {
          if (row.id === PRIMARY_ACCOUNT_ID) {
            const r = await this.controller.refresh();
            await this.checkCookieExpiryAlert(row.label);
            return { id: row.id, label: row.label, ok: Boolean(r.ok) };
          }
          const resp = await this.forwardToAccount(row.id, new Request("https://internal/admin/internal-scheduled-renew", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scheduledTime, cron, accountLabel: row.label }),
          }));
          const payload = await resp.json<{ ok?: boolean }>().catch(() => ({ ok: false }));
          return { id: row.id, label: row.label, ok: Boolean(payload.ok) };
        } catch {
          return { id: row.id, label: row.label, ok: false };
        }
      }),
    );

    const accountsOk = perAccount.filter((a) => a.ok).length;
    const failedAccounts = perAccount.filter((a) => !a.ok).map((a) => a.id);
    const summaryResult = {
      ok: perAccount.length === 0 ? true : accountsOk === perAccount.length,
      accounts_total: perAccount.length,
      accounts_ok: accountsOk,
      last_error: failedAccounts.length ? { stage: "pool_renewal", failed_accounts: failedAccounts } : null,
      per_account: perAccount,
    };
    this.record("scheduled_renewal", {
      source: "cloudflare_scheduled",
      scheduled_time: scheduledTime,
      cron,
      started_at: started,
      completed_at: Date.now(),
      result: summaryResult,
    });
    await this.ensureAlarm();
    return summaryResult;
  }

  private localAcceptedCount(): number {
    const row = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM approval_decisions WHERE state='rpc_accepted'",
    ).one();
    return row?.count ?? 0;
  }

  private approvalEventsEnabled(): boolean {
    return this.env.AUTO_APPROVAL_ENABLED === "true" && this.env.AUTO_APPROVAL_EVENTS_ENABLED === "true"
      && this.env.MANAGED_CHANNELS_ENABLED === "true";
  }

  private async primaryApprovalsUseEvents(): Promise<boolean> {
    if (!this.approvalEventsEnabled() || !this.env.MOBILE) return false;
    const checked = this.event<number>("primary_approval_checked");
    if (checked === null || Date.now() - checked >= PRIMARY_APPROVAL_RECONCILE_MS) return false;
    try {
      return await this.env.MOBILE.getByName("channels").primaryApprovalSubscriptionReady();
    } catch {
      return false;
    }
  }

  /** The subscription is a wake-up hint. The Sentinel list and policy remain authoritative. */
  async checkApprovalEvent(): Promise<void> {
    if (!this.approvalEventsEnabled() || this.isIsolated()) return;
    this.ensurePrimaryAccountRow();
    const primary = this.ctx.storage.sql.exec<{ label: string }>(
      "SELECT label FROM muse_accounts WHERE id=? AND enabled=1", PRIMARY_ACCOUNT_ID,
    ).toArray()[0];
    if (!primary) return;
    const result = await this.pollLocal("approval_event", primary.label);
    if (!result.ok) throw new Error("approval_event_poll_failed");
  }

  private async pollLocal(source = "manual", accountLabel?: string) {
    if (this.env.AUTO_APPROVAL_ENABLED !== "true") {
      return { ok: true, enabled: false, source, pending: 0, approved: 0, held: 0, unknown: 0, accepted_total: this.localAcceptedCount() };
    }
    const started = Date.now();
    const heldItems: HeldApproval[] = [];
    const isolated = this.isIsolated();
    const statusKey = source === "approval_event" ? "primary_approval_event" : "approval_poll";
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
        if (!isolated && this.env.MANAGED_CHANNELS_ENABLED !== "true" && source === "durable_object_alarm"
          && Date.now() - (this.channelSnapshot()?.at ?? 0) >= 60_000) {
          try { this.saveChannels(await inspectChannels(rpc)); } catch { /* Status sampling is independent of approval decisions. */ }
        }
        return result;
      });
      if (heldItems.length) {
        const now = Date.now();
        this.ctx.storage.sql.exec("DELETE FROM approval_notifications WHERE notified_at < ?", now - 7 * 24 * 3600 * 1000);
        const labelSuffix = accountLabel ? `\n账号：${accountLabel}` : "";
        for (const item of heldItems) {
          const inserted = this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO approval_notifications VALUES (?,?) RETURNING id", item.id, now,
          ).toArray().length === 1;
          if (!inserted) continue;
          const remainMin = Math.max(1, Math.round((item.expiresAt - now) / 60_000));
          await this.pushAlert(
            "approval-" + item.id,
            `⚠️ Muse 有待人工确认的外网访问审批${labelSuffix}\n目标：${item.method} ${item.host}:${item.port} (${item.scheme})\n剩余约 ${remainMin} 分钟过期，未在自动放行白名单内，请到 Muse 确认。`,
          );
        }
      }
      await this.checkCookieExpiryAlert(accountLabel);
      const status = {
        ok: true,
        enabled: true,
        source,
        started_at: started,
        completed_at: Date.now(),
        ...result,
        accepted_total: this.localAcceptedCount(),
      };
      this.record(statusKey, status);
      if (!isolated && this.approvalEventsEnabled()) {
        this.record("primary_approval_checked", status.completed_at);
      }
      return status;
    } catch {
      await this.checkCookieExpiryAlert(accountLabel);
      const status = {
        ok: false,
        enabled: true,
        source,
        started_at: started,
        completed_at: Date.now(),
        error: "approval_poll_failed",
        accepted_total: this.localAcceptedCount(),
      };
      this.record(statusKey, status);
      return status;
    }
  }

  async poll(source = "manual") {
    if (this.env.AUTO_APPROVAL_ENABLED !== "true") return { ok: true, enabled: false };
    if (this.isIsolated()) return this.pollLocal(source);
    const started = Date.now();
    this.ensurePrimaryAccountRow();
    const enabledAccounts = this.ctx.storage.sql.exec<AccountRow>(
      "SELECT id, label FROM muse_accounts WHERE enabled = 1 ORDER BY created_at ASC, id ASC",
    ).toArray();
    const primaryViaEvents = source === "durable_object_alarm"
      && enabledAccounts.some((row) => row.id === PRIMARY_ACCOUNT_ID)
      && await this.primaryApprovalsUseEvents();
    const accountsToPoll = primaryViaEvents
      ? enabledAccounts.filter((row) => row.id !== PRIMARY_ACCOUNT_ID)
      : enabledAccounts;

    // 仅存在主账号且已开启时，保持原有单账号返回结构与零额外 DO 请求
    if (accountsToPoll.length === 1 && accountsToPoll[0].id === PRIMARY_ACCOUNT_ID) {
      const local = await this.pollLocal(source);
      const status = { ...local, accounts_polled: 1, accounts_ok: local.ok ? 1 : 0 };
      this.record("approval_poll", status);
      return status;
    }

    const perAccount = await Promise.all(
      accountsToPoll.map(async (row) => {
        try {
          let payload: Record<string, unknown>;
          if (row.id === PRIMARY_ACCOUNT_ID) {
            payload = await this.pollLocal(source, row.label);
          } else {
            const resp = await this.forwardToAccount(row.id, new Request("https://internal/admin/internal-poll-approvals", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ source, accountLabel: row.label }),
            }));
            payload = await resp.json<Record<string, unknown>>().catch(() => ({ ok: false, error: "invalid_internal_poll_response" }));
          }
          return {
            id: row.id,
            label: row.label,
            ok: Boolean(payload.ok),
            pending: Number(payload.pending ?? 0),
            approved: Number(payload.approved ?? 0),
            held: Number(payload.held ?? 0),
            unknown: Number(payload.unknown ?? 0),
            accepted_total: Number(payload.accepted_total ?? 0),
            ...(payload.error ? { error: String(payload.error) } : {}),
          };
        } catch {
          return {
            id: row.id,
            label: row.label,
            ok: false,
            pending: 0,
            approved: 0,
            held: 0,
            unknown: 0,
            accepted_total: 0,
            error: "approval_poll_failed",
          };
        }
      }),
    );

    const accountsOk = perAccount.filter((a) => a.ok).length;
    const summary = {
      ok: perAccount.length === 0 ? true : accountsOk === perAccount.length,
      enabled: true,
      source,
      started_at: started,
      completed_at: Date.now(),
      pending: perAccount.reduce((sum, a) => sum + a.pending, 0),
      approved: perAccount.reduce((sum, a) => sum + a.approved, 0),
      held: perAccount.reduce((sum, a) => sum + a.held, 0),
      unknown: perAccount.reduce((sum, a) => sum + a.unknown, 0),
      accounts_polled: perAccount.length,
      accounts_ok: accountsOk,
      total_accepted: perAccount.reduce((sum, a) => sum + a.accepted_total, primaryViaEvents ? this.localAcceptedCount() : 0),
      ...(primaryViaEvents ? { primary_via_events: true } : {}),
      per_account: perAccount,
    };
    this.record("approval_poll", summary);
    return summary;
  }

  async alarm() {
    if (this.isIsolated()) return;
    if (this.env.AUTO_APPROVAL_ENABLED !== "true") return;
    try { await this.poll("durable_object_alarm"); }
    finally { await this.ctx.storage.setAlarm(Date.now() + this.approvalPollIntervalMs()); }
  }
}
