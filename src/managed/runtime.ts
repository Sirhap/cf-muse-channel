import { DurableObject } from "cloudflare:workers";
import { json } from "../http";
import { MuseRpc } from "../noise";
import { ManagedStore, type Task, type Outbound } from "./store";
import { NativeConversations } from "./native";
import { channelReply } from "./reply";
import { assertPlatformSuccess, boundedJson, failureCode, object, string, validConfig, wecomMessage, weixinCall, weixinMessages, type Channel, type ChannelConfig, type Incoming } from "./protocol";

const IDLE_HISTORY_SCAN_MS = 60_000;
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
  private native: NativeConversations;
  private muse?: MuseRpc;
  private museConnecting?: Promise<MuseRpc>;
  private wecom?: WebSocket;
  private wecomStarting?: Promise<void>;
  private wecomReady = false;
  private responses = new Map<string, { resolve: (response: Record<string, unknown>) => void; reject: () => void }>();
  private subscriptions = new Map<string, MuseRpc>();
  private watching = new Set<string>();
  private dirtySessions = new Set<string>();
  private pendingFullScan = false;
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
    this.native = new NativeConversations(this.store, (operation) => this.rpc(operation),
      (operation) => ctx.storage.transactionSync(operation),
      (session) => ctx.waitUntil(this.watch(session).catch(() => {})));
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
    if (path === "/admin/managed/probe-native" && ["GET", "POST"].includes(request.method)) {
      if (request.method === "POST" && !this.store.get("native-verification")) {
        if (this.env.MANAGED_CHANNELS_ENABLED !== "true") return json({ error: "native_probe_disabled" }, 409);
        this.ctx.storage.transactionSync(() => {
          const text = ["这是连续输入验证，请等我发完再回答，不执行任何其他操作。", "这是第二条补充消息。", "输入完成，请回复你已经收到连续输入。"];
          const ids = text.map((value, index) => this.store.ingest({ id: "native-probe-" + index, text: value,
            channel: "weixin", account: "isolated-native-probe", chat: "isolated-native-probe", sender: "isolated-native-probe", group: false, context: "" })!.id);
          this.store.set("native-verification", { ids, created_at: Date.now() });
        });
        await this.ctx.storage.setAlarm(Date.now() + 100);
        this.ctx.waitUntil(this.pump());
      }
      const probe = this.store.get<{ ids: number[]; created_at: number }>("native-verification");
      if (!probe) return json({ state: "not_started" });
      const inputs = probe.ids.map((id) => ({ id, state: this.store.task(id).state, ...this.store.get<object>("native-input:" + id) }));
      const replies = this.ctx.storage.sql.exec<{ id: number; text: string }>("SELECT id,text FROM tasks WHERE message_id LIKE 'native:%' ORDER BY id").toArray()
        .map((row) => ({ ...row, ...this.store.get<object>("native-output:" + row.id) }));
      return json({ state: inputs.every((row) => "confirmed_at" in row) && replies.length > 0 ? "succeeded" : "awaiting_native_receipts", inputs, replies });
    }
    if ((path === "/managed/push" || path === "/admin/managed/push") && request.method === "POST") {
      return this.handlePush(request);
    }
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
        runtime_version: "managed-20261120-fast-push-v1",
        mode: "native",
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
        native_sessions: this.ctx.storage.sql.exec("SELECT COUNT(*) count,SUM(awaiting) active FROM native_sessions").one(),
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
        const nativeActive = this.ctx.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) count FROM native_sessions WHERE awaiting=1 AND json_extract(route,'$.channel')=?", channel).one().count;
        if (replacing && (outstanding || nativeActive)) return json({ error: "tasks_must_be_reconciled_before_configuration_change" }, 409);
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

  private async handlePush(request: Request): Promise<Response> {
    if (this.env.MANAGED_CHANNELS_ENABLED !== "true") return json({ error: "managed_channels_disabled" }, 409);
    let body: Record<string, unknown>;
    try { body = await boundedJson(new Response(request.body), 32768); }
    catch { return json({ error: "invalid_push_payload" }, 400); }
    const text = string(body.text).trim();
    const rawChannel = body.channel === undefined ? "auto" : string(body.channel);
    const rawId = body.id === undefined ? "" : string(body.id).trim();
    const rawChat = body.chat === undefined ? undefined : string(body.chat).trim();
    const rawGroup = body.group === undefined ? undefined : body.group;
    if (!text || text.length > 16000 || !["auto", "weixin", "wecom"].includes(rawChannel)
      || (body.id !== undefined && (!rawId || rawId.length > 128))
      || (body.chat !== undefined && (!rawChat || rawChat.length > 512))
      || (rawGroup !== undefined && typeof rawGroup !== "boolean")
      || (rawChannel === "weixin" && rawGroup === true)) {
      return json({ error: "invalid_push_payload" }, 400);
    }
    const pushId = rawId || crypto.randomUUID();
    const resolved = this.resolvePushRoute(rawChannel as Channel | "auto", pushId, text, rawChat, rawGroup as boolean | undefined);
    if ("error" in resolved) return json({ error: resolved.error }, resolved.status);
    const route = resolved.route;
    let taskId = 0;
    let deduplicated = false;
    this.ctx.storage.transactionSync(() => {
      const created = this.store.ingest(route);
      if (created) {
        this.store.complete(created, channelReply(text));
        taskId = created.id;
        return;
      }
      const conversation = JSON.stringify([route.channel, route.account, route.group, route.chat]);
      const existing = this.ctx.storage.sql.exec<Task>(
        "SELECT * FROM tasks WHERE message_id=? AND conversation=?", route.id, conversation).toArray()[0];
      taskId = existing?.id ?? 0;
      deduplicated = true;
    });
    if (!deduplicated) {
      await this.deliver();
      await this.ctx.storage.setAlarm(Date.now() + 15000);
    }
    const outbound = taskId
      ? this.ctx.storage.sql.exec<Outbound>("SELECT * FROM outbound WHERE task_id=?", taskId).toArray()[0]
      : undefined;
    const deliveryState = outbound?.state ?? "pending";
    return json({
      ok: deliveryState !== "unknown",
      id: pushId,
      task_id: taskId,
      channel: route.channel,
      deduplicated,
      delivery_state: deliveryState,
    }, deliveryState === "unknown" ? 502 : 200);
  }

  /** 解析主动推送目标渠道与合法路由；严格遵守白名单，微信自动复用最新 context_token。 */
  private resolvePushRoute(
    preferred: Channel | "auto",
    pushId: string,
    text: string,
    chat?: string,
    group?: boolean,
  ): { route: Incoming } | { error: string; status: number } {
    const pick = (channel: Channel): { route: Incoming } | { error: string; status: number } => {
      const config = this.config(channel);
      if (!config?.enabled) return { error: "channel_not_enabled", status: 409 };
      if (channel === "weixin" && group === true) return { error: "invalid_push_payload", status: 400 };
      const recent = this.native.latestRoute(channel, config.account, chat, group);
      if (chat !== undefined) {
        if (group === true) {
          if (!recent) return { error: "recipient_not_allowed", status: 403 };
        } else if (!config.allowedSenders.includes(chat)) {
          return { error: "recipient_not_allowed", status: 403 };
        }
      }
      const targetChat = chat ?? recent?.chat ?? config.allowedSenders[0];
      const targetGroup = group ?? (recent ? Boolean(recent.group) : false);
      const targetSender = recent?.sender ?? config.allowedSenders[0];
      const context = channel === "weixin" ? (recent?.context ?? "") : "";
      if (channel === "weixin" && !context) return { error: "weixin_context_unavailable", status: 409 };
      return {
        route: {
          id: "push:" + pushId,
          channel,
          account: config.account,
          chat: targetChat,
          sender: targetSender,
          group: targetGroup,
          text,
          context,
        },
      };
    };
    if (preferred !== "auto") return pick(preferred);
    const candidates: Channel[] = [];
    const wx = this.config("weixin"), wc = this.config("wecom");
    if (wx?.enabled) candidates.push("weixin");
    if (wc?.enabled) candidates.push("wecom");
    if (!candidates.length) return { error: "no_push_channel_available", status: 409 };
    // 若两渠道均启用，优先有最新活跃会话路由的一方，否则回退到不依赖 context_token 的企微。
    if (candidates.length === 2) {
      const latest = this.ctx.storage.sql.exec<{ channel: string }>(
        "SELECT json_extract(route,'$.channel') channel FROM native_sessions ORDER BY last_checked DESC LIMIT 1").toArray()[0]?.channel;
      if (latest === "wecom") candidates.reverse();
    }
    let lastError: { error: string; status: number } = { error: "no_push_channel_available", status: 409 };
    for (const channel of candidates) {
      const result = pick(channel);
      if ("route" in result) return result;
      lastError = result;
    }
    return lastError;
  }

  private async socket(): Promise<MuseRpc> {
    const response = await this.env.CREDENTIALS.getByName("primary-account").fetch(new Request("https://internal/ws", {
      headers: { Upgrade: "websocket" },
    }));
    if (response.status !== 101 || !response.webSocket) throw new Error("muse_connect_failed");
    return MuseRpc.connect(response.webSocket);
  }

  /** 复用支持流级多路复用的热 MuseRpc 连接，仅对建连阶段去重，避免业务 RPC 串行排队。 */
  private async rpc<T>(operation: (client: MuseRpc) => Promise<T>): Promise<T> {
    let client = this.muse;
    if (!client) {
      this.museConnecting ??= this.socket().then((connected) => {
        this.muse = connected;
        return connected;
      }).finally(() => { this.museConnecting = undefined; });
      client = await this.museConnecting;
    }
    try { return await operation(client); }
    catch (error) {
      if (this.muse === client) this.muse = undefined;
      client.close();
      throw error;
    }
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
    await this.pump(true);
    if (this.active()) await this.ctx.storage.setAlarm(Date.now() + 15000);
  }

  private active() {
    const diagnostic = this.store.get<Diagnostic>("diagnostic");
    return Boolean(diagnostic && diagnostic.state !== "succeeded" && diagnostic.state !== "failed")
      || this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) count FROM tasks WHERE state IN ('queued','submitting','running','unknown')").one().count > 0
      || this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) count FROM native_sessions WHERE awaiting=1").one().count > 0;
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
    // Queries and controls bypass older chat work but are persisted and deduplicated first.
    const reply = this.store.command(task);
    if (reply !== null) this.store.complete(task, reply);
  }

  private async watch(session: string) {
    if (this.watching.has(session)) return;
    this.watching.add(session);
    let client: MuseRpc;
    try { client = await this.socket(); }
    catch (error) { this.watching.delete(session); throw error; }
    const diagnostic = this.store.get<Diagnostic>("diagnostic");
    const awaiting = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) count FROM native_sessions WHERE session=? AND awaiting=1", session).one().count > 0;
    const pendingTask = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) count FROM tasks WHERE session=? AND state IN ('queued','submitting','running','unknown')", session).one().count > 0;
    if (!awaiting && !pendingTask && !(diagnostic?.session === session && diagnostic.state !== "succeeded")) {
      this.watching.delete(session); client.close(); return;
    }
    this.subscriptions.set(session, client);
    this.ctx.waitUntil(client.subscribe("/chat/subscribe", {
      session_id: session, capabilities: ["chat_cancel", "delta_stream"],
    }, (event) => {
      const record = object(event), payload = object(record.payload);
      if (payload.session_id !== session) return;
      // 忽略 delta.message_start（此时回复尚未完成），仅在可能产生完成文本的事件时唤醒精准会话。
      if (["delta.message_done", "sessions.updated", "message.assistant"].includes(string(record.event))) {
        const diagnostic = this.store.get<Diagnostic>("diagnostic");
        if (diagnostic?.session === session) this.store.set("diagnostic", { ...diagnostic, event_received: true });
        this.dirtySessions.add(session);
        this.eventRevision++;
        this.ctx.waitUntil(this.pump(false));
      }
    }).catch(() => {}).finally(() => {
      if (this.subscriptions.get(session) === client) this.subscriptions.delete(session);
      this.watching.delete(session);
      client.close();
    }));
  }

  private pump(fullScan = false): Promise<void> {
    if (fullScan) this.pendingFullScan = true;
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
      const fullScan = this.pendingFullScan;
      this.pendingFullScan = false;
      const dirty = new Set(this.dirtySessions);
      this.dirtySessions.clear();
      await this.deliver();
      await this.diagnostic();
      await this.native.recoverLegacy();
      let prepared = true;
      // These are unsent transport receipts. Forward the burst immediately;
      // an earlier Muse turn never gates the next input.
      for (let sent = 0; sent < 20; sent++) {
        const task = this.store.candidate();
        if (!task) break;
        try { await this.native.forward(task); }
        catch {
          prepared = false;
          this.store.set("task-error:" + task.id, { code: "submission_preflight_failed", at: Date.now() });
          break;
        }
      }
      const uncertainSessions = new Set(
        this.ctx.storage.sql.exec<{ session: string }>(
          "SELECT DISTINCT session FROM tasks WHERE state='unknown' AND session IS NOT NULL").toArray().map((row) => row.session),
      );
      const now = Date.now();
      const targets = fullScan
        ? this.native.sessions().filter((binding) =>
            dirty.has(binding.session)
            || uncertainSessions.has(binding.session)
            || Boolean(binding.awaiting)
            || now - binding.last_checked >= IDLE_HISTORY_SCAN_MS)
        : Array.from(new Set([...dirty, ...uncertainSessions]))
            .map((id) => this.native.session(id))
            .filter((binding): binding is NonNullable<typeof binding> => Boolean(binding));
      for (const binding of targets) {
        try {
          const produced = await this.native.collect(binding);
          await this.deliver();
          if (produced || binding.awaiting && Date.now() - binding.last_checked > 15000) {
            await this.native.refreshActivity(binding);
          }
        } catch { this.store.set("native-error:" + binding.session, { code: "native_history_check_failed", at: Date.now() }); }
      }
      await this.deliver();
      if (!prepared) break;
      loops++;
    } while (loops < 10 && (revision !== this.eventRevision || this.dirtySessions.size > 0 || this.pendingFullScan || this.store.candidate()));
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

  private history(response: Record<string, unknown>) {
    if (!Array.isArray(response.chat_events)) throw new Error("history_unavailable");
    return response.chat_events.map(object).filter((event) => Number.isSafeInteger(event.seq));
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
