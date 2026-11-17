import { DurableObject } from "cloudflare:workers";
import { json } from "../http";
import { MuseRpc } from "../noise";
import { ManagedStore, type Task, type Outbound } from "./store";
import { channelReply } from "./reply";
import { assertPlatformSuccess, boundedJson, failureCode, object, string, validConfig, wecomMessage, weixinCall, weixinMessages, type Channel, type ChannelConfig, type Incoming } from "./protocol";

interface Health { connected: boolean; last_ok: number | null; error: string | null; }
interface Diagnostic {
  state: string;
  session: string | null;
  baseline: number;
  submitted_at: number | null;
  completed_at: number | null;
  event_received: boolean;
}
export class ManagedChannels extends DurableObject<Env> {
  private store: ManagedStore;
  private muse?: MuseRpc;
  private museConnecting?: Promise<MuseRpc>;
  private museSerial: Promise<void> = Promise.resolve();
  private wecom?: WebSocket;
  private wecomStarting?: Promise<void>;
  private wecomReady = false;
  private responses = new Map<string, { resolve: (response: Record<string, unknown>) => void; reject: () => void }>();
  private subscriptions = new Map<string, MuseRpc>();
  private watching = new Set<string>();
  private eventRevision = 0;
  private pumping?: Promise<void>;
  private polling?: Promise<void>;
  private health: Record<Channel, Health> = {
    weixin: { connected: false, last_ok: null, error: null },
    wecom: { connected: false, last_ok: null, error: null },
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new ManagedStore(ctx.storage.sql);
    // A worker may have died after sending. Such tasks always require reconciliation.
    ctx.storage.sql.exec("UPDATE tasks SET state='unknown' WHERE state='submitting'");
    ctx.storage.sql.exec("UPDATE outbound SET state='unknown' WHERE state='sending'");
  }

  private config(channel: Channel): ChannelConfig | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM config WHERE channel=?", channel).toArray()[0];
    return row ? JSON.parse(row.value) as ChannelConfig : null;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/admin/managed/confirm-delivery" && request.method === "POST") {
      try {
        const body = await boundedJson(new Response(request.body), 2048);
        if (body.received !== true || !Number.isSafeInteger(body.task_id) || Number(body.task_id) <= 0 || !string(body.message_id)) return json({ error: "explicit_receipt_required" }, 400);
        const task = this.store.task(Number(body.task_id));
        if (task.message_id !== body.message_id) return json({ error: "receipt_binding_mismatch" }, 409);
        const row = this.ctx.storage.sql.exec<Outbound>("SELECT * FROM outbound WHERE task_id=?", task.id).toArray()[0];
        // A recipient's confirmation resolves a single ambiguous bubble; never resend it.
        if (!row || row.text.length > 900 || !["unknown", "delivered"].includes(row.state)) return json({ error: "delivery_not_confirmable" }, 409);
        this.ctx.storage.transactionSync(() => {
          this.store.set("outbound-receipt:" + row.id, { source: "administrator_recipient_confirmation", at: Date.now(), message_id: task.message_id });
          this.ctx.storage.sql.exec("UPDATE outbound SET state='delivered' WHERE id=?", row.id);
        });
        return json({ ok: true, task_id: task.id, source: "recipient_confirmation" });
      } catch { return json({ error: "invalid_delivery_receipt" }, 400); }
    }
    if (path === "/admin/managed/connectivity" && request.method === "POST") {
      const weixin = this.config("weixin");
      const [wx, wc] = await Promise.all([
        (async () => {
          if (!weixin) return { configured: false };
          try {
            await weixinCall("getconfig", weixin, { ilink_user_id: weixin.allowedSenders[0], context_token: "",
              base_info: { channel_version: "2.4.9", bot_agent: "Muse/1.0" } });
            return { ok: true, stage: "authenticated_config_read" };
          } catch (error) { return { ok: false, error: failureCode(error) }; }
        })(),
        (async () => {
          try {
            const r = await fetch("https://openws.work.weixin.qq.com", { headers: { Upgrade: "websocket" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
            const upgraded = r.status === 101 && Boolean(r.webSocket);
            if (r.webSocket) { r.webSocket.accept(); r.webSocket.close(1000, "connectivity probe only"); }
            else await r.body?.cancel();
            return { ok: upgraded, status: r.status, stage: "upgrade_only_no_subscription" };
          } catch (error) { return { ok: false, error: failureCode(error), stage: "upgrade_only_no_subscription" }; }
        })(),
      ]);
      const result = { checked_at: Date.now(), weixin: wx, wecom: wc };
      this.store.set("connectivity", result);
      return json(result);
    }
    if (request.method === "GET" && (path === "/channel-health" || path === "/admin/channels")) {
      const states = Object.fromEntries((["weixin", "wecom"] as const).map((channel) => {
        const health = this.health[channel];
        const enabled = this.config(channel)?.enabled;
        const fresh = health.last_ok !== null && Date.now() - health.last_ok < 150000;
        const state = !enabled ? "unknown" : health.connected && fresh ? "healthy" : health.error ? "disconnected" : "stale";
        return [channel, path === "/channel-health" ? state : {
          state, observed_at: health.last_ok, valid_until: health.last_ok === null ? null : health.last_ok + 150000,
        }];
      }));
      return json(states);
    }
    if (path === "/admin/managed/probe") {
      if (request.method === "GET") return json(this.store.get("diagnostic") ?? { state: "not_started" });
      if (request.method === "POST") {
        const existing = this.store.get<Diagnostic>("diagnostic");
        if (existing) return json(existing);
        this.store.set("diagnostic", { state: "preparing", session: null, baseline: 0, submitted_at: null, completed_at: null, event_received: false } satisfies Diagnostic);
        await this.ctx.storage.setAlarm(Date.now() + 100);
        return json({ state: "preparing" }, 202);
      }
    }
    if (request.method === "GET" && path === "/admin/managed/status") {
      return json({
        runtime_version: "managed-20261117-reply-v2",
        last_alarm_at: this.store.get("last_alarm_at"),
        next_alarm_at: await this.ctx.storage.getAlarm(),
        last_pump_error: this.store.get("last_pump_error"),
        channels: Object.fromEntries((["weixin", "wecom"] as const).map((channel) => {
          const config = this.config(channel);
          return [channel, { configured: Boolean(config), enabled: config?.enabled ?? false, ...this.health[channel] }];
        })),
        tasks: this.ctx.storage.sql.exec("SELECT state,COUNT(*) count FROM tasks GROUP BY state").toArray(),
        outbound: this.ctx.storage.sql.exec("SELECT state,COUNT(*) count FROM outbound GROUP BY state").toArray(),
        pending: this.ctx.storage.sql.exec("SELECT id,state,created_at FROM tasks WHERE state IN ('queued','submitting','running','unknown') ORDER BY id LIMIT 20").toArray(),
        recent: this.ctx.storage.sql.exec<{ id: number; state: string; channel: string; message_id: string; created_at: number }>(
          "SELECT id,state,json_extract(route,'$.channel') channel,message_id,created_at FROM tasks ORDER BY id DESC LIMIT 10").toArray()
          .map((task) => ({ ...task, error: this.store.get("task-error:" + task.id) })),
        deliveries: this.ctx.storage.sql.exec<{ id: number; task_id: number; state: string }>(
          "SELECT id,task_id,state FROM outbound ORDER BY id DESC LIMIT 10").toArray()
          .map((row) => ({ ...row, error: this.store.get("outbound-error:" + row.id) })),
        scope: "text",
      });
    }
    if (request.method === "POST" && (path === "/admin/managed/weixin" || path === "/admin/managed/wecom")) {
      const channel: Channel = path.endsWith("/weixin") ? "weixin" : "wecom";
      try {
        const data = await this.readConfig(request);
        if (data.enabled && this.env.MANAGED_CHANNELS_ENABLED !== "true") return json({ error: "staging_channels_disabled" }, 409);
        const previous = this.config(channel);
        const replacing = !previous || previous.account !== data.account || previous.secret !== data.secret
          || JSON.stringify(previous.allowedSenders) !== JSON.stringify(data.allowedSenders) || data.initialCursor !== undefined;
        const outstanding = this.ctx.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) count FROM tasks WHERE json_extract(route,'$.channel')=? AND
          (state IN ('queued','submitting','running','unknown') OR id IN (SELECT task_id FROM outbound WHERE state<>'delivered'))`, channel).one().count;
        if (replacing && outstanding) return json({ error: "tasks_must_be_reconciled_before_configuration_change" }, 409);
        if (channel === "weixin" && (!previous || previous.account !== data.account || data.initialCursor !== undefined)) {
          this.store.set("weixin_cursor", data.initialCursor ?? "");
        }
        delete data.initialCursor;
        this.ctx.storage.sql.exec("INSERT INTO config VALUES (?,?) ON CONFLICT(channel) DO UPDATE SET value=excluded.value", channel, JSON.stringify(data));
        if (channel === "wecom") this.closeWecom();
        await this.ctx.storage.setAlarm(Date.now() + 100);
        return json({ ok: true, enabled: data.enabled });
      } catch { return json({ error: "invalid_channel_configuration" }, 400); }
    }
    return json({ error: "not_found" }, 404);
  }

  private async readConfig(request: Request) {
    if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") throw new Error("json_required");
    const reader = request.body?.getReader();
    if (!reader) throw new Error("body_required");
    let size = 0;
    const decoder = new TextDecoder();
    let text = "";
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 24000) { await reader.cancel(); throw new Error("config_limit"); }
        text += decoder.decode(part.value, { stream: true });
      }
    } finally { reader.releaseLock(); }
    return validConfig(JSON.parse(text + decoder.decode()));
  }

  private async socket(): Promise<MuseRpc> {
    const response = await this.env.CREDENTIALS.getByName("primary-account").fetch(new Request("https://internal/ws", {
      headers: { Upgrade: "websocket" },
    }));
    if (response.status !== 101 || !response.webSocket) throw new Error("muse_connect_failed");
    return MuseRpc.connect(response.webSocket);
  }

  private async rpc<T>(operation: (client: MuseRpc) => Promise<T>): Promise<T> {
    const work = this.museSerial.then(async () => {
      if (!this.muse) {
        this.museConnecting ??= this.socket().finally(() => { this.museConnecting = undefined; });
        this.muse = await this.museConnecting;
      }
      try { return await operation(this.muse); }
      catch (error) { this.muse.close(); this.muse = undefined; throw error; }
    });
    this.museSerial = work.then(() => {}, () => {});
    return work;
  }

  private healthResult(channel: Channel, error?: string) {
    this.health[channel] = error ? { ...this.health[channel], connected: false, error }
      : { connected: true, last_ok: Date.now(), error: null };
  }

  async alarm() {
    if (this.env.MANAGED_CHANNELS_ENABLED !== "true") return;
    this.store.set("last_alarm_at", Date.now());
    const wecom = this.config("wecom"), weixin = this.config("weixin");
    if (!wecom?.enabled && !weixin?.enabled && !this.active()) {
      await this.ctx.storage.deleteAlarm();
      this.muse?.close(); this.muse = undefined;
      for (const subscription of this.subscriptions.values()) subscription.close();
      this.closeWecom();
      return;
    }
    // Schedule before I/O so an interrupted invocation has a durable recovery trigger.
    await this.ctx.storage.setAlarm(Date.now() + 30000);
    if (wecom?.enabled) {
      try {
        await this.ensureWecom(wecom);
        assertPlatformSuccess(await this.frame({ cmd: "ping", headers: { req_id: crypto.randomUUID() } }));
        this.healthResult("wecom");
      } catch (error) { this.healthResult("wecom", failureCode(error)); this.closeWecom(); }
    }
    if (weixin?.enabled) {
      this.polling ??= this.pollWeixin(weixin).finally(() => { this.polling = undefined; });
      this.ctx.waitUntil(this.polling);
    }
    await this.pump();
    if (this.active()) await this.ctx.storage.setAlarm(Date.now() + 15000);
  }

  private active() {
    const diagnostic = this.store.get<Diagnostic>("diagnostic");
    return Boolean(diagnostic && diagnostic.state !== "succeeded" && diagnostic.state !== "failed")
      || this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) count FROM tasks WHERE state IN ('queued','running','unknown')").one().count > 0;
  }

  private async pollWeixin(config: ChannelConfig) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && this.config("weixin")?.enabled) {
      try {
        const started = Date.now();
        const data = await weixinCall("getupdates", config, {
          get_updates_buf: this.store.get<string>("weixin_cursor") ?? "", base_info: { channel_version: "2.4.9", bot_agent: "Muse/1.0" },
        }, 45000);
        const messages = weixinMessages(data, config);
        const current = this.config("weixin");
        if (!current?.enabled || current.account !== config.account || current.secret !== config.secret) return;
        // No await between ingest and cursor commit. Both share one synchronous SQLite transaction.
        this.ctx.storage.transactionSync(() => {
          for (const message of messages) this.ingest(message);
          if (typeof data.get_updates_buf === "string") this.store.set("weixin_cursor", data.get_updates_buf);
        });
        this.healthResult("weixin");
        this.ctx.waitUntil(this.pump());
        // An unexpectedly immediate empty response must not create a busy poll loop.
        if (!messages.length && Date.now() - started < 500) await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) continue;
        this.healthResult("weixin", failureCode(error));
        break;
      }
    }
  }

  private async ensureWecom(config: ChannelConfig) {
    if (this.wecomStarting) return this.wecomStarting;
    if (this.wecomReady && this.wecom?.readyState === WebSocket.OPEN) return;
    this.wecomStarting ??= this.connectWecom(config).finally(() => { this.wecomStarting = undefined; });
    return this.wecomStarting;
  }

  private async connectWecom(config: ChannelConfig) {
    // A permanently armed timeout aborts the upgraded socket 15 seconds later.
    // Bound only the handshake, then remove the timer for the connection lifetime.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let result: Response;
    try {
      result = await fetch("https://openws.work.weixin.qq.com", { headers: { Upgrade: "websocket" }, redirect: "manual", signal: controller.signal });
    } finally { clearTimeout(timeout); }
    if (result.status !== 101 || !result.webSocket) throw new Error("wecom_upgrade_failed_" + result.status);
    const socket = result.webSocket;
    const current = this.config("wecom");
    if (!current?.enabled || current.account !== config.account || current.secret !== config.secret) {
      socket.accept(); socket.close(1000, "configuration changed"); throw new Error("configuration_changed");
    }
    this.wecom = socket;
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || event.data.length > 1024 * 1024) return;
      try {
        const frame = object(JSON.parse(event.data));
        const id = string(object(frame.headers).req_id);
        const pending = this.responses.get(id);
        if (pending) { pending.resolve(frame); return; }
        const current = this.config("wecom");
        if (!current?.enabled || current.account !== config.account || current.secret !== config.secret) return;
        const message = wecomMessage(frame, config);
        if (message) {
          this.ctx.storage.transactionSync(() => this.ingest(message));
          this.ctx.waitUntil(this.pump());
        }
      } catch { this.healthResult("wecom", "invalid_gateway_frame"); }
    });
    const disconnected = (event: Event) => {
      if (this.wecom !== socket) return;
      this.closeWecom();
      this.healthResult("wecom", event instanceof CloseEvent ? "gateway_closed_" + event.code : "gateway_disconnected");
      this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 5000));
    };
    socket.addEventListener("close", disconnected);
    socket.addEventListener("error", disconnected);
    socket.accept();
    assertPlatformSuccess(await this.frame({ cmd: "aibot_subscribe", headers: { req_id: crypto.randomUUID() }, body: { bot_id: config.account, secret: config.secret } }));
    this.wecomReady = true;
    this.healthResult("wecom");
  }

  private closeWecom() {
    const socket = this.wecom;
    this.wecom = undefined;
    this.wecomReady = false;
    for (const pending of this.responses.values()) pending.reject();
    this.responses.clear();
    try { socket?.close(1000, "reconnect"); } catch { /* Already closed. */ }
  }

  private frame(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.wecom || this.wecom.readyState !== WebSocket.OPEN) return Promise.reject(new Error("wecom_not_connected"));
    const id = string(object(value.headers).req_id);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.responses.delete(id); reject(new Error("platform_response_unknown")); }, 12000);
      this.responses.set(id, {
        resolve: (result) => { clearTimeout(timeout); this.responses.delete(id); resolve(result); },
        reject: () => { clearTimeout(timeout); reject(new Error("platform_connection_lost")); },
      });
      try { this.wecom!.send(JSON.stringify(value)); }
      catch { clearTimeout(timeout); this.responses.delete(id); reject(new Error("platform_send_unknown")); }
    });
  }

  private ingest(message: Incoming) {
    const task = this.store.ingest(message);
    if (!task) return;
    const word = task.text.trim().split(/\s+/)[0];
    // Queries and controls bypass older chat work but are persisted and deduplicated first.
    const reply = this.store.command(task);
    if (reply !== null) this.store.complete(task, reply);
    else if (word === "/stop") {
      this.ctx.storage.sql.exec("UPDATE tasks SET state='cancelled' WHERE conversation=? AND id<>? AND state='queued'", task.conversation, task.id);
      const running = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) count FROM tasks WHERE conversation=? AND state IN ('running','submitting','unknown')", task.conversation).one().count;
      if (running) this.store.set("cancel:" + task.conversation, true);
      this.store.complete(task, "已登记停止请求，正在核对远端任务。");
    }
  }

  private async watch(session: string) {
    if (this.watching.has(session)) return;
    this.watching.add(session);
    let client: MuseRpc;
    try { client = await this.socket(); }
    catch (error) { this.watching.delete(session); throw error; }
    const diagnostic = this.store.get<Diagnostic>("diagnostic");
    const interested = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) count FROM tasks WHERE session=? AND state IN ('queued','submitting','running','unknown')", session).one().count > 0;
    if (!interested && !(diagnostic?.session === session && diagnostic.state !== "succeeded")) {
      this.watching.delete(session); client.close(); return;
    }
    this.subscriptions.set(session, client);
    this.ctx.waitUntil(client.subscribe("/chat/subscribe", {
      session_id: session, capabilities: ["chat_cancel", "delta_stream"],
    }, (event) => {
      const record = object(event), payload = object(record.payload);
      if (payload.session_id !== session) return;
      if (["delta.message_done", "delta.message_start", "sessions.updated", "message.assistant"].includes(string(record.event))) {
        const diagnostic = this.store.get<Diagnostic>("diagnostic");
        if (diagnostic?.session === session) this.store.set("diagnostic", { ...diagnostic, event_received: true });
        this.eventRevision++;
        this.ctx.waitUntil(this.pump());
      }
    }).catch(() => {}).finally(() => {
      if (this.subscriptions.get(session) === client) this.subscriptions.delete(session);
      this.watching.delete(session);
      client.close();
    }));
  }

  private pump(): Promise<void> {
    if (this.pumping) {
      this.eventRevision++;
      return this.pumping;
    }
    this.pumping = this.run().catch((error) => {
      this.store.set("last_pump_error", { code: failureCode(error), at: Date.now() });
      this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 5000));
    }).finally(() => { this.pumping = undefined; });
    return this.pumping;
  }

  private async run() {
    let revision;
    let loops = 0;
    do {
      revision = this.eventRevision;
      await this.deliver(); // Local commands remain available during a Muse outage.
      await this.diagnostic();
      const running = this.ctx.storage.sql.exec<Task>("SELECT * FROM tasks WHERE state IN ('running','unknown') ORDER BY id LIMIT 10").toArray();
      for (const task of running) {
        try { await this.check(task); }
        catch { this.store.set("task-error:" + task.id, { code: "result_check_failed", at: Date.now() }); }
      }
      const task = this.store.candidate();
      let prepared = true;
      if (task) {
        try { await this.submit(task); }
        catch { prepared = false; this.store.set("task-error:" + task.id, { code: "submission_preflight_failed", at: Date.now() }); }
      }
      await this.deliver();
      if (!prepared) break;
      loops++;
    } while (loops < 10 && (revision !== this.eventRevision || this.store.candidate()));
    if (this.active()) await this.ctx.storage.setAlarm(Date.now() + 15000);
  }

  private async diagnostic() {
    const diagnostic = this.store.get<Diagnostic>("diagnostic");
    if (!diagnostic || diagnostic.state === "succeeded" || diagnostic.state === "failed") return;
    if (diagnostic.state === "preparing") {
      const started = object(await this.rpc((rpc) => rpc.call("/session/start", 0, "POST", {
        method: "/api/session/start", params: { origin: "fresh", lifecycle: "persistent", title: "CF managed isolated verification" },
      })));
      const session = string(started.session_id);
      if (!session) throw new Error("session_unavailable");
      const next: Diagnostic = { ...diagnostic, session, state: "submission_unknown", submitted_at: Date.now() };
      this.store.set("diagnostic", next);
      this.ctx.waitUntil(this.watch(session).catch(() => {}));
      await this.rpc((rpc) => rpc.open("/chat/stream", 0, "POST", {
        session_id: session, node_id: "cf-managed-diagnostic", capabilities: {},
        items: [{ type: "text", text: "只回复：CF 托管独立验证成功。不要执行其他操作。" }],
      }));
      return;
    }
    if (!diagnostic.session) return;
    const session = diagnostic.session;
    this.ctx.waitUntil(this.watch(session).catch(() => {}));
    const history = object(await this.rpc((rpc) => rpc.call("/chat/history?session_id=" + encodeURIComponent(session) + "&limit=40", 0)));
    if (this.history(history).some((event) => event.event_name === "message.assistant"
      && object(event.payload).status === "completed" && string(object(event.payload).display_text))) {
      this.store.set("diagnostic", { ...this.store.get<Diagnostic>("diagnostic")!, state: "succeeded", completed_at: Date.now() });
    }
  }

  private async submit(task: Task) {
    const row = this.ctx.storage.sql.exec<{ generation: number; session: string | null }>("SELECT generation,session FROM conversations WHERE id=?", task.conversation).one();
    const sessionKey = "session:" + task.conversation + ":" + task.generation;
    let session = this.store.get<string>(sessionKey) ?? (row.generation === task.generation ? row.session : null);
    if (!session) {
      const started = object(await this.rpc((rpc) => rpc.call("/session/start", 0, "POST", {
        method: "/api/session/start", params: { origin: "fresh", lifecycle: "persistent", title: "CF managed channel" },
      })));
      session = string(started.session_id);
      if (!session) throw new Error("session_unavailable");
      this.ctx.storage.sql.exec("UPDATE conversations SET session=? WHERE id=? AND generation=?", session, task.conversation, task.generation);
    }
    this.store.set(sessionKey, session);
    const id = session;
    const history = object(await this.rpc((rpc) => rpc.call("/chat/history?session_id=" + encodeURIComponent(id) + "&limit=10", 0)));
    const baseline = Math.max(0, ...this.history(history).map((event) => Number(event.seq)));
    this.ctx.storage.sql.exec("UPDATE tasks SET session=?,baseline=? WHERE id=?", id, baseline, task.id);
    const device = "cf-managed-" + crypto.randomUUID();
    this.store.set("device:" + task.id, device);
    this.ctx.waitUntil(this.watch(id).catch(() => {}));
    // This durable boundary forbids replay if sending or the following write is interrupted.
    this.ctx.storage.sql.exec("UPDATE tasks SET state='submitting' WHERE id=? AND state='queued'", task.id);
    try {
      await this.rpc((rpc) => rpc.open("/chat/stream", 0, "POST", {
        session_id: id, node_id: device, capabilities: {}, items: [{ type: "text", text: task.text }],
      }));
      this.ctx.storage.sql.exec("UPDATE tasks SET state='running' WHERE id=?", task.id);
    } catch { this.ctx.storage.sql.exec("UPDATE tasks SET state='unknown' WHERE id=?", task.id); }
  }

  private history(response: Record<string, unknown>) {
    if (!Array.isArray(response.chat_events)) throw new Error("history_unavailable");
    return response.chat_events.map(object).filter((event) => Number.isSafeInteger(event.seq));
  }

  private async check(task: Task) {
    if (!task.session) throw new Error("task_missing_session");
    const session = task.session;
    this.ctx.waitUntil(this.watch(session).catch(() => {}));
    const history = object(await this.rpc((rpc) => rpc.call("/chat/history?session_id=" + encodeURIComponent(session) + "&limit=100", 0)));
    const events = this.history(history);
    let anchor = this.store.get<number>("anchor:" + task.id);
    if (anchor === null) {
      const device = this.store.get<string>("device:" + task.id);
      const matches = events.filter((event) => {
        const payload = object(event.payload);
        return event.event_name === "message.user" && Number(event.seq) > task.baseline
          && device !== null && (object(payload.metadata).client_device_id === device || object(payload.chat_context).device_id === device)
          && (payload.display_text === task.text || payload.content === task.text);
      });
      if (matches.length !== 1) return; // Read-only recovery never guesses or replays an ambiguous submission.
      anchor = Number(matches[0].seq);
      this.store.set("anchor:" + task.id, anchor);
      this.ctx.storage.sql.exec("UPDATE tasks SET state='running' WHERE id=?", task.id);
    }
    const cancelling = Boolean(this.store.get("cancel:" + task.conversation));
    if (cancelling && !this.store.get("cancel-sent:" + task.id)) {
      await this.rpc((rpc) => rpc.call("/chat/cancel", 0, "POST", { session_id: session }));
      this.store.set("cancel-sent:" + task.id, true);
    }
    const current = object(await this.rpc((rpc) => rpc.call("/api/session/list/" + encodeURIComponent(session), 0)));
    const sessionState = string(current.status);
    if (!["completed", "failed", "error", "cancelled", "canceled"].includes(sessionState)) return;
    const latest = new Map<unknown, Record<string, unknown>>();
    for (const event of events) {
      if (event.event_name === "message.assistant" && Number(event.seq) > anchor) {
        latest.set(event.message_id ?? object(event.payload).message_id ?? event.seq, event);
      }
    }
    const replies = [...latest.values()].sort((a, b) => Number(a.seq) - Number(b.seq));
    const last = object(replies.at(-1)?.payload);
    const terminal = string(last.status);
    if (["cancelled", "canceled"].includes(sessionState) || ["cancelled", "canceled"].includes(terminal)) {
      this.finish(task, "任务已停止。", "cancelled"); return;
    }
    if (["failed", "error"].includes(sessionState) || ["failed", "error"].includes(terminal)) {
      this.finish(task, "Muse 任务未完成，请查看任务状态后再决定是否重新发送。", "failed"); return;
    }
    if (!replies.length) return;
    if (replies.some((event) => ["running", "pending", "in_progress", "streaming", "generating"].includes(string(object(event.payload).status))
      || object(event.payload).display_text_ready === false)) return;
    const texts = replies.map((event) => object(event.payload))
      .filter((payload) => ["completed", "complete", "succeeded"].includes(string(payload.status)))
      .map((payload) => string(payload.display_text)).filter(Boolean);
    if (!texts.length) return;
    this.finish(task, texts.join("\n"), "succeeded");
  }

  /** Only confirmed terminal state releases the conversation for its next turn. */
  private finish(task: Task, text: string, state: "succeeded" | "failed" | "cancelled") {
    this.ctx.storage.transactionSync(() => {
      this.store.complete(task, channelReply(text), state);
      this.store.set("cancel:" + task.conversation, false);
    });
    // Reuse the subscription for the next turn. Its existing bounded idle read
    // timeout closes it naturally; reconnecting never replays a user message.
  }

  private async deliver() {
    const rows = this.ctx.storage.sql.exec<Outbound>("SELECT * FROM outbound WHERE state='pending' ORDER BY id LIMIT 10").toArray();
    for (const row of rows) {
      const route = JSON.parse(row.route) as Incoming;
      const config = this.config(route.channel);
      if (!config?.enabled || config.account !== route.account) continue;
      // Each chunk has its own persisted send boundary. Ambiguous chunks are never replayed.
      const parts = this.store.get<number>("outbound-part:" + row.id) ?? 0;
      const chunks = row.text.match(/[\s\S]{1,900}/gu) ?? [""];
      const identity = this.store.get<string>("outbound-id:" + row.id) ?? crypto.randomUUID();
      this.store.set("outbound-id:" + row.id, identity);
      for (let i = parts; i < chunks.length; i++) {
        if (route.channel === "wecom") {
          try { await this.ensureWecom(config); }
          catch { this.healthResult("wecom", "gateway_connect_failed"); break; }
        }
        this.ctx.storage.sql.exec("UPDATE outbound SET state='sending' WHERE id=?", row.id);
        try {
          if (route.channel === "weixin") {
            await weixinCall("sendmessage", config, {
              msg: { from_user_id: "", to_user_id: route.chat, client_id: "cf-" + identity + "-" + i,
                message_type: 2, message_state: 2, context_token: route.context,
                item_list: [{ type: 1, text_item: { text: chunks[i] } }] },
              base_info: { channel_version: "2.4.9", bot_agent: "Muse/1.0" },
            });
          } else {
            assertPlatformSuccess(await this.frame({ cmd: "aibot_send_msg", headers: { req_id: "cf-" + identity + "-" + i },
              body: { chatid: route.chat, chat_type: route.group ? 2 : 1, msgtype: "markdown", markdown: { content: chunks[i] } } }));
          }
          this.ctx.storage.transactionSync(() => {
            this.store.set("outbound-part:" + row.id, i + 1);
            this.ctx.storage.sql.exec("UPDATE outbound SET state=? WHERE id=?", i + 1 === chunks.length ? "delivered" : "pending", row.id);
          });
        } catch (error) {
          this.store.set("outbound-error:" + row.id, { code: failureCode(error), at: Date.now() });
          this.ctx.storage.sql.exec("UPDATE outbound SET state='unknown' WHERE id=?", row.id);
          break;
        }
      }
    }
  }
}
