import { bytesToBase64, downloadAndDecryptInbound, extractOutboundFiles, imageMimeForExtension, MAX_INLINE_IMAGE_BYTES, writeSandboxFile } from "./media";
import { MuseOwnerUnavailable, type OwnedRpc, type MuseOwner } from "./muse-owner";
import { failureCode, object, string, type Incoming } from "./protocol";
import { channelReply } from "./reply";
import { ManagedStore, type Task } from "./store";

type StreamItem =
  | { type: "text"; text: string }
  | { type: "image"; mime_type: string; filename: string; data_base64: string };

const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 3;
const PENDING_ASSISTANT_CHECKS = 3;
const FINAL_ASSISTANT_STATES = new Set(["completed", "complete", "succeeded", "failed", "error", "cancelled", "canceled"]);
type HistoryEvent = Record<string, unknown> & { seq: number };
interface PendingAssistant extends Record<string, SqlStorageValue> { message: string; seq: number; }
interface ReceiptInput { task: Task; after: number; }

export interface NativeSession extends Record<string, SqlStorageValue> {
  session: string;
  conversation: string;
  generation: number;
  route: string;
  cursor: number;
  awaiting: number;
  last_checked: number;
  muse_account: string | null;
  muse_vm: string | null;
  history_more: number;
}
type Commit = (operation: () => void) => void;

/** Native Muse owns turn scheduling. This relay persists transport receipts only. */
export class NativeConversations {
  private resolving = new Map<string, Promise<MuseOwner>>();

  constructor(private store: ManagedStore, private rpc: OwnedRpc, private commit: Commit,
    private watch: (session: string, owner: MuseOwner) => void, private accountIds: () => Promise<string[]>) {
    store.sql.exec(`CREATE TABLE IF NOT EXISTS native_sessions(
      session TEXT PRIMARY KEY, conversation TEXT NOT NULL, generation INTEGER NOT NULL,
      route TEXT NOT NULL, cursor INTEGER NOT NULL, awaiting INTEGER NOT NULL DEFAULT 1,
      last_checked INTEGER NOT NULL DEFAULT 0, muse_account TEXT, muse_vm TEXT,
      history_more INTEGER NOT NULL DEFAULT 0, UNIQUE(conversation,generation))`);
    const columns = store.sql.exec<{ name: string }>("PRAGMA table_info(native_sessions)").toArray();
    if (!columns.some(({ name }) => name === "muse_account")) store.sql.exec("ALTER TABLE native_sessions ADD COLUMN muse_account TEXT");
    if (!columns.some(({ name }) => name === "muse_vm")) store.sql.exec("ALTER TABLE native_sessions ADD COLUMN muse_vm TEXT");
    if (!columns.some(({ name }) => name === "history_more")) {
      store.sql.exec("ALTER TABLE native_sessions ADD COLUMN history_more INTEGER NOT NULL DEFAULT 0");
    }
    store.sql.exec(`CREATE TABLE IF NOT EXISTS native_pending_assistant (
      session TEXT NOT NULL, message TEXT NOT NULL, seq INTEGER NOT NULL, checked_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(session,message))`);
  }

  private events(response: unknown) {
    const data = object(response);
    if (!Array.isArray(data.chat_events)) throw new Error("history_unavailable");
    return data.chat_events.map(object).filter((event) => Number.isSafeInteger(event.seq))
      .sort((a, b) => Number(a.seq) - Number(b.seq));
  }

  private historyPath(session: string, limit: number) {
    return "/chat/history?session_id=" + encodeURIComponent(session) + "&limit=" + limit;
  }

  private async historyPage(session: string, owner: MuseOwner, after: number, limit = HISTORY_PAGE_SIZE) {
    const data = object(await this.rpc((client) =>
      client.call(this.historyPath(session, limit) + "&after_seq=" + after, 0), owner));
    if (typeof data.has_more !== "boolean" || !Array.isArray(data.chat_events) || data.chat_events.length > limit) {
      throw new Error("history_page_invalid");
    }
    const rows = data.chat_events.map(object);
    const events: HistoryEvent[] = [];
    for (const row of rows) {
      const { seq } = row;
      const eventSession = object(row.payload).session_id;
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 || !string(row.event_name)
          || (eventSession !== undefined && eventSession !== session)) throw new Error("history_page_invalid");
      if (seq > after) events.push({ ...row, seq });
    }
    events.sort((a, b) => a.seq - b.seq);
    if (!events.length && (data.has_more || rows.length)) throw new Error("history_page_no_progress");
    return { events, more: data.has_more };
  }

  sessions() {
    return this.store.sql.exec<NativeSession>(`SELECT n.* FROM native_sessions n JOIN conversations c ON c.id=n.conversation
      WHERE n.awaiting=1 OR c.generation=n.generation OR n.history_more=1
        OR EXISTS(SELECT 1 FROM native_pending_assistant p WHERE p.session=n.session)
        OR EXISTS(SELECT 1 FROM tasks t WHERE t.session=n.session AND t.state='unknown') ORDER BY n.last_checked`).toArray();
  }

  needsHistoryCheck() {
    return Boolean(this.store.sql.exec(`SELECT 1 FROM native_sessions WHERE awaiting=1 OR history_more=1
      UNION ALL SELECT 1 FROM native_pending_assistant LIMIT 1`).toArray().length);
  }

  session(id: string): NativeSession | null {
    return this.store.sql.exec<NativeSession>("SELECT * FROM native_sessions WHERE session=?", id).toArray()[0] ?? null;
  }

  /** A positive history response plus definitive misses on the other enabled accounts establishes ownership. */
  async resolveOwner(session: string): Promise<MuseOwner> {
    const binding = this.session(session);
    if (binding?.muse_account && binding.muse_vm) return { account: binding.muse_account, vm: binding.muse_vm };
    const pending = this.resolving.get(session);
    if (pending) return pending;
    const check = this.discoverOwner(session).finally(() => this.resolving.delete(session));
    this.resolving.set(session, check);
    return check;
  }

  private async discoverOwner(session: string): Promise<MuseOwner> {
    const proposals = await Promise.all((await this.accountIds()).map(async (account) => {
      try {
        return await this.rpc(async (client, owner) => {
          this.events(await client.call(this.historyPath(session, 1), 0));
          return owner;
        }, { account });
      } catch (error) {
        if (error instanceof Error && ["rpc_http_404", "muse_account_unconfigured"].includes(error.message)) return null;
        throw new MuseOwnerUnavailable("muse_owner_unresolved");
      }
    }));
    const matches = proposals.filter((owner): owner is MuseOwner => owner !== null);
    if (matches.length !== 1) throw new MuseOwnerUnavailable("muse_owner_unresolved");
    const [owner] = matches;
    this.store.sql.exec("UPDATE native_sessions SET muse_account=?,muse_vm=? WHERE session=? AND muse_account IS NULL",
      owner.account, owner.vm, session);
    return owner;
  }

  /** 查找指定渠道最近保存的合法路由（用于主动推送自动继承微信最新 context_token 与目标聊天）。 */
  latestRoute(channel: Incoming["channel"], account: string, chat?: string, group?: boolean): Incoming | null {
    const rows = this.store.sql.exec<{ route: string }>(
      "SELECT route FROM native_sessions WHERE json_extract(route,'$.channel')=? AND json_extract(route,'$.account')=? ORDER BY last_checked DESC LIMIT 50",
      channel, account).toArray();
    for (const row of rows) {
      try {
        const route = JSON.parse(row.route) as Incoming;
        if (chat !== undefined && route.chat !== chat) continue;
        if (group !== undefined && Boolean(route.group) !== group) continue;
        if (channel === "weixin" && !route.context) continue;
        return route;
      } catch { /* 跳过格式异常记录 */ }
    }
    const taskRows = this.store.sql.exec<{ route: string }>(
      "SELECT route FROM tasks WHERE json_extract(route,'$.channel')=? AND json_extract(route,'$.account')=? AND message_id NOT LIKE 'push:%' ORDER BY id DESC LIMIT 50",
      channel, account).toArray();
    for (const row of taskRows) {
      try {
        const route = JSON.parse(row.route) as Incoming;
        if (chat !== undefined && route.chat !== chat) continue;
        if (group !== undefined && Boolean(route.group) !== group) continue;
        if (channel === "weixin" && !route.context) continue;
        return route;
      } catch { /* 跳过格式异常记录 */ }
    }
    return null;
  }

  private async bind(task: Task): Promise<NativeSession> {
    const existing = this.store.sql.exec<NativeSession>("SELECT * FROM native_sessions WHERE conversation=? AND generation=?", task.conversation, task.generation).toArray()[0];
    if (existing) return existing;
    const conversation = this.store.sql.exec<{ generation: number; session: string | null }>("SELECT generation,session FROM conversations WHERE id=?", task.conversation).one();
    const key = "session:" + task.conversation + ":" + task.generation;
    const session = task.session ?? this.store.get<string>(key) ?? (conversation.generation === task.generation ? conversation.session : null);
    if (!session) {
      return this.rpc(async (client, owner) => {
        const started = object(await client.call("/session/start", 0, "POST", {
          method: "/api/session/start", params: { origin: "fresh", lifecycle: "persistent", title: "CF managed channel" },
        }));
        const created = string(started.session_id);
        if (!created) throw new Error("session_unavailable");
        this.commit(() => {
          this.insertSession(task, created, owner, 0);
          this.store.set(key, created);
          this.store.sql.exec("UPDATE conversations SET session=? WHERE id=? AND generation=?", created, task.conversation, task.generation);
        });
        return this.session(created)!;
      });
    }
    // Existing delivered replies form the initial boundary. Unsettled old turns
    // instead start at their original boundary so an upgrade cannot lose a reply.
    const unfinished = this.store.sql.exec<{ baseline: number }>(
      "SELECT baseline FROM tasks WHERE conversation=? AND generation=? AND session=? AND state IN ('running','unknown','submitting')", task.conversation, task.generation, session).toArray();
    const owner = await this.resolveOwner(session);
    const cursor = unfinished.length ? Math.min(...unfinished.map((row) => row.baseline)) : Math.max(0, ...this.events(
      await this.rpc((client) => client.call(this.historyPath(session, 20), 0), owner)).map((event) => Number(event.seq)));
    this.insertSession(task, session, owner, cursor);
    return this.session(session)!;
  }

  private insertSession(task: Task, session: string, owner: MuseOwner, cursor: number) {
    this.store.sql.exec("INSERT INTO native_sessions(session,conversation,generation,route,cursor,muse_account,muse_vm) VALUES (?,?,?,?,?,?,?)",
      session, task.conversation, task.generation, task.route, cursor, owner.account, owner.vm);
  }

  /** A successfully sent input never waits for an earlier assistant reply. */
  async forward(task: Task): Promise<string | null> {
    if (task.text.trim() === "/stop") {
      const row = this.store.sql.exec<{ session: string | null }>("SELECT session FROM conversations WHERE id=? AND generation=?", task.conversation, task.generation).toArray()[0];
      if (row?.session) {
        const owner = await this.resolveOwner(row.session);
        try {
          await this.rpc((client) => {
            this.store.sql.exec("UPDATE tasks SET state='submitting',session=? WHERE id=?", row.session, task.id);
            return client.call("/chat/cancel", 0, "POST", { session_id: row.session });
          }, owner);
        } catch (error) {
          if (this.store.task(task.id).state !== "submitting") throw error;
          this.store.sql.exec("UPDATE tasks SET state='unknown' WHERE id=?", task.id);
          return row.session;
        }
      }
      this.commit(() => this.store.complete(task, row?.session ? "已向 Muse 发送停止请求。" : "当前没有已连接的 Muse 会话。"));
      return row?.session ?? null;
    }
    const binding = await this.bind(task);
    const owner = await this.resolveOwner(binding.session);
    const route = JSON.parse(task.route) as Incoming;
    const streamItems = await this.stageInboundMedia(task, route, owner);
    const device = "cf-managed-" + crypto.randomUUID();
    try {
      await this.rpc((client) => {
        this.commit(() => {
          this.store.set("device:" + task.id, device);
          this.store.set("native-input:" + task.id, { sending_at: Date.now() });
          this.store.sql.exec("UPDATE native_sessions SET route=?,awaiting=1 WHERE session=?", task.route, binding.session);
          this.store.sql.exec("UPDATE tasks SET state='submitting',session=?,baseline=? WHERE id=? AND state='queued'", binding.session, binding.cursor, task.id);
        });
        this.watch(binding.session, owner);
        return client.open("/chat/stream", 0, "POST", {
          session_id: binding.session, node_id: device, capabilities: {}, items: streamItems,
        });
      }, owner);
      this.store.sql.exec("UPDATE tasks SET state='submitted' WHERE id=?", task.id);
      this.store.set("native-input:" + task.id, { ...this.store.get<object>("native-input:" + task.id), submitted_at: Date.now() });
    } catch (error) {
      if (this.store.task(task.id).state !== "submitting") throw error;
      // Recovery only inspects this device receipt; it never resends this input.
      this.store.sql.exec("UPDATE tasks SET state='unknown' WHERE id=?", task.id);
    }
    return binding.session;
  }

  /** 将微信/企微入站媒体下载解密后写入 Muse 沙箱；对 1.5MB 以内的图片同时附上 Muse 原生 image item 以便多模态直接识别。 */
  private async stageInboundMedia(task: Task, route: Incoming, owner: MuseOwner): Promise<StreamItem[]> {
    if (!route.media?.length) return [{ type: "text", text: task.text }];
    const notes: string[] = [];
    const imageItems: StreamItem[] = [];
    const safeId = task.message_id.replace(/[^A-Za-z0-9_-]/g, "").slice(-24) || String(task.id);
    for (let index = 0; index < route.media.length; index++) {
      const item = route.media[index];
      const label = item.kind === "image" ? "图片" : item.kind === "video" ? "视频" : "文件";
      try {
        const { bytes, ext } = await downloadAndDecryptInbound(item);
        const filename = `${safeId}_${index}.${ext}`;
        const relPath = `workspace/cf-inbound-media/${filename}`;
        await writeSandboxFile((op) => this.rpc(op, owner), relPath, bytes);
        const mime = item.kind === "image" ? imageMimeForExtension(ext) : null;
        if (mime && bytes.length <= MAX_INLINE_IMAGE_BYTES) {
          imageItems.push({
            type: "image",
            mime_type: mime,
            filename,
            data_base64: bytesToBase64(bytes),
          });
          notes.push(`[已附${label}，已内联传入并保存到沙箱路径：/home/hatch/${relPath}（${bytes.length} 字节）]`);
        } else {
          const oversizeHint = mime && bytes.length > MAX_INLINE_IMAGE_BYTES ? "；图片较大未内联，请直接读取沙箱路径查看" : "";
          notes.push(`[已附${label}，已保存到沙箱路径：/home/hatch/${relPath}（${bytes.length} 字节）${oversizeHint}]`);
        }
      } catch (error) {
        if (error instanceof MuseOwnerUnavailable) throw error;
        const code = error instanceof Error ? error.message : "unknown_error";
        const reason = code === "media_too_large"
          ? "超过 CF 托管 6MB 单文件上限"
          : `下载或解密失败（${code}）`;
        notes.push(`[用户发送的${label}未能转存到沙箱：${reason}]`);
      }
    }
    const baseText = task.text === "[图片]" && imageItems.length > 0
      ? "请识别并查看用户发送的图片。"
      : task.text;
    const promptText = notes.length ? `${baseText}\n\n${notes.join("\n")}` : baseText;
    return [{ type: "text", text: promptText }, ...imageItems];
  }

  /** Adopt any old in-flight transport receipt without resubmitting the message. */
  async recoverLegacy() {
    const rows = this.store.sql.exec<Task>(`SELECT t.* FROM tasks t LEFT JOIN native_sessions n ON n.session=t.session
      WHERE t.session IS NOT NULL AND (t.state='running' OR (t.state='unknown' AND n.session IS NULL)) ORDER BY t.id`).toArray();
    for (const task of rows) {
      try {
        await this.bind(task);
        if (task.state === "running") {
          await this.resolveOwner(task.session!);
          this.store.sql.exec("UPDATE tasks SET state='submitted' WHERE id=?", task.id);
        }
      } catch (error) {
        this.store.set("task-error:" + task.id, { code: failureCode(error), at: Date.now() });
      }
    }
  }

  /** Commit each page before requesting the next one. Unfinished replies have their own durable retry position. */
  async collect(requested: NativeSession): Promise<boolean> {
    const binding = this.session(requested.session) ?? requested;
    const owner = await this.resolveOwner(binding.session);
    if (binding.awaiting) this.watch(binding.session, owner);
    const pending = this.store.sql.exec<PendingAssistant>(
      "SELECT message,seq FROM native_pending_assistant WHERE session=? ORDER BY checked_at,seq LIMIT ?",
      binding.session, PENDING_ASSISTANT_CHECKS).toArray();

    let after = binding.cursor;
    let produced = false;
    for (let index = 0; index < MAX_HISTORY_PAGES; index++) {
      const { events, more } = await this.historyPage(binding.session, owner, after);
      const through = events.at(-1)?.seq ?? after;
      const assistant = new Map<string, HistoryEvent>();
      for (const event of events) {
        if (event.event_name !== "message.assistant") continue;
        const identity = this.assistantIdentity(event);
        if (!identity) throw new Error("assistant_identity_unavailable");
        assistant.set(identity, event);
      }

      this.commit(() => {
        if (through > after) this.confirmInputs(events, this.receiptInputs(binding.session), after, through);
        for (const [identity, event] of assistant) {
          if (this.acceptAssistant(binding, owner, identity, event)) produced = true;
        }
        this.store.sql.exec("UPDATE native_sessions SET cursor=?,history_more=?,last_checked=? WHERE session=?",
          through, Number(more), Date.now(), binding.session);
      });
      after = through;
      if (!more) break;
    }
    if (await this.recheckAssistant(binding, owner, pending)) produced = true;
    await this.reconcileEarlierInputs(binding, owner, after);
    return produced;
  }

  private assistantIdentity(event: HistoryEvent) {
    return string(event.message_id) || string(object(event.payload).message_id);
  }

  private acceptAssistant(binding: NativeSession, owner: MuseOwner, identity: string, event: HistoryEvent) {
    const payload = object(event.payload);
    const id = "native:" + binding.session + ":" + identity;
    if (!FINAL_ASSISTANT_STATES.has(string(payload.status)) || payload.display_text_ready === false) {
      this.store.sql.exec(`INSERT INTO native_pending_assistant(session,message,seq)
        SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM tasks WHERE message_id=? AND conversation=?)
        ON CONFLICT(session,message) DO UPDATE SET seq=excluded.seq WHERE excluded.seq>seq`,
        binding.session, identity, event.seq, id, binding.conversation);
      return false;
    }

    this.store.sql.exec("DELETE FROM native_pending_assistant WHERE session=? AND message=?", binding.session, identity);
    const text = string(payload.display_text) || string(payload.content);
    if (!text) return false;
    const rows = this.store.sql.exec<Task>(`INSERT OR IGNORE INTO tasks(message_id,route,conversation,generation,text,state,session,baseline,created_at)
      VALUES (?,?,?,?,?,'queued',?,?,?) RETURNING *`, id, binding.route, binding.conversation, binding.generation, text, binding.session, event.seq, Date.now()).toArray();
    const [task] = rows;
    if (!task) return false;
    const { text: reply, files } = extractOutboundFiles(text);
    this.store.complete(task, reply ? channelReply(reply) : (files.length ? "" : channelReply(text)));
    if (files.length) this.store.setOutboundFiles(task.id, files, owner);
    this.store.set("native-output:" + task.id, { message_id: identity,
      muse_completed_at: typeof payload.display_text_updated_at_ms === "number" ? payload.display_text_updated_at_ms : null,
      captured_at: Date.now() });
    return true;
  }

  /** Read the original sequence again to catch a reply finalized in place. Other messages can pass it. */
  private async recheckAssistant(binding: NativeSession, owner: MuseOwner, pending: PendingAssistant[]) {
    let produced = false;
    for (const { message, seq } of pending) {
      const stillPending = () => this.store.sql.exec<PendingAssistant>(
        "SELECT message,seq FROM native_pending_assistant WHERE session=? AND message=?", binding.session, message).toArray()[0];
      if (stillPending()?.seq !== seq) continue;
      this.store.sql.exec("UPDATE native_pending_assistant SET checked_at=? WHERE session=? AND message=?", Date.now(), binding.session, message);
      const { events } = await this.historyPage(binding.session, owner, seq - 1, 1);
      const event = events[0];
      if (!event || event.seq !== seq || event.event_name !== "message.assistant" || this.assistantIdentity(event) !== message) continue;
      this.commit(() => {
        if (stillPending()?.seq === seq && this.acceptAssistant(binding, owner, message, event)) produced = true;
      });
    }
    return produced;
  }

  private receiptInputs(session: string, includeSubmitted = true): Map<string, ReceiptInput> {
    const unknown = this.store.sql.exec<Task>("SELECT * FROM tasks WHERE session=? AND state='unknown'", session).toArray();
    const submitted = includeSubmitted ? this.store.sql.exec<Task>(
      "SELECT * FROM tasks WHERE session=? AND state='submitted' ORDER BY id DESC LIMIT 20", session).toArray() : [];
    const inputs = new Map<string, ReceiptInput>();
    for (const task of [...unknown, ...submitted]) {
      const device = this.store.get<string>("device:" + task.id);
      if (device) inputs.set(device, { task, after: this.store.get<number>("native-receipt-cursor:" + task.id) ?? task.baseline });
    }
    return inputs;
  }

  private confirmInputs(events: HistoryEvent[], inputs: Map<string, ReceiptInput>, from: number, through: number) {
    for (const event of events) {
      if (event.event_name !== "message.user") continue;
      const payload = object(event.payload);
      const device = string(object(payload.metadata).client_device_id) || string(object(payload.chat_context).device_id);
      const input = inputs.get(device);
      if (!input || event.seq <= input.task.baseline) continue;
      const { task } = input;
      const text = string(payload.display_text);
      if (text !== task.text && payload.content !== task.text && !text.includes(task.text)
          && !(task.text === "[图片]" && text.includes("[已附图片"))) continue;
      const receipt = this.store.get<Record<string, unknown>>("native-input:" + task.id) ?? {};
      if (!receipt.confirmed_at) {
        this.store.set("native-input:" + task.id, { ...receipt, confirmed_at: Date.now(), event_seq: event.seq,
          muse_input_at: typeof payload.display_text_updated_at_ms === "number" ? payload.display_text_updated_at_ms : null });
      }
      if (task.state === "unknown") {
        this.store.sql.exec("UPDATE tasks SET state='submitted' WHERE id=?", task.id);
        this.store.sql.exec("DELETE FROM metadata WHERE key=?", "native-receipt-cursor:" + task.id);
      }
      inputs.delete(device);
    }
    for (const { task, after } of inputs.values()) {
      if (task.state === "unknown" && after >= from && after < through) {
        this.store.set("native-receipt-cursor:" + task.id, through);
      }
    }
  }

  /** Legacy unknown sends may start before the output cursor. Scan that interval without moving the output cursor. */
  private async reconcileEarlierInputs(binding: NativeSession, owner: MuseOwner, until: number) {
    const inputs = this.receiptInputs(binding.session, false);
    let after = until;
    for (const input of inputs.values()) after = Math.min(after, input.after);
    if (after >= until) return;
    const { events, more } = await this.historyPage(binding.session, owner, after);
    const through = more ? Math.min(until, events.at(-1)!.seq) : until;
    this.commit(() => this.confirmInputs(events.filter((event) => event.seq <= until), inputs, after, through));
  }

  /** This only adjusts the history fallback cadence, after replies are delivered. */
  async refreshActivity(binding: NativeSession) {
    const owner = await this.resolveOwner(binding.session);
    const status = object(await this.rpc((client) => client.call("/api/session/list/" + encodeURIComponent(binding.session), 0), owner));
    if (["completed", "failed", "error", "cancelled", "canceled"].includes(string(status.status))) {
      this.store.sql.exec("UPDATE native_sessions SET awaiting=0 WHERE session=?", binding.session);
    }
  }
}
