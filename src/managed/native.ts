import { bytesToBase64, downloadAndDecryptInbound, extractOutboundFiles, imageMimeForExtension, MAX_INLINE_IMAGE_BYTES, writeSandboxFile } from "./media";
import { MuseOwnerUnavailable, type OwnedRpc, type MuseOwner } from "./muse-owner";
import { failureCode, object, string, type Incoming } from "./protocol";
import { channelReply } from "./reply";
import { ManagedStore, type Task } from "./store";

type StreamItem =
  | { type: "text"; text: string }
  | { type: "image"; mime_type: string; filename: string; data_base64: string };

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
      last_checked INTEGER NOT NULL DEFAULT 0, muse_account TEXT, muse_vm TEXT, UNIQUE(conversation,generation))`);
    const columns = store.sql.exec<{ name: string }>("PRAGMA table_info(native_sessions)").toArray();
    if (!columns.some(({ name }) => name === "muse_account")) store.sql.exec("ALTER TABLE native_sessions ADD COLUMN muse_account TEXT");
    if (!columns.some(({ name }) => name === "muse_vm")) store.sql.exec("ALTER TABLE native_sessions ADD COLUMN muse_vm TEXT");
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

  /** 默认仅拉取最近 40 条事件；若检测到游标与最小序号间存在缺口，自动阶梯补拉避免漏消息。 */
  private async historySince(session: string, cursor: number, owner: MuseOwner) {
    const history = async (limit: number) => this.events(await this.rpc(
      (client) => client.call(this.historyPath(session, limit), 0), owner));
    let events = await history(40);
    if (cursor > 0 && events.length >= 40 && Number(events[0].seq) > cursor + 1) {
      events = await history(200);
      if (events.length >= 200 && Number(events[0].seq) > cursor + 1) {
        events = await history(500);
      }
    }
    return events;
  }

  sessions() {
    return this.store.sql.exec<NativeSession>(`SELECT n.* FROM native_sessions n JOIN conversations c ON c.id=n.conversation
      WHERE n.awaiting=1 OR c.generation=n.generation ORDER BY n.last_checked`).toArray();
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

  /** Forward each completed native assistant message, including intermediate answers.
   * The session itself may still be running; it is never a gate on delivery.
   */
  async collect(binding: NativeSession): Promise<boolean> {
    const owner = await this.resolveOwner(binding.session);
    if (binding.awaiting) this.watch(binding.session, owner);
    const events = await this.historySince(binding.session, binding.cursor, owner);
    const latest = new Map<string, Record<string, unknown>>();
    const hasUserEvents = events.some((event) => event.event_name === "message.user");
    const devices = new Map<string, Task>();
    if (hasUserEvents) {
      const inputs = this.store.sql.exec<Task>(
        `SELECT * FROM tasks WHERE session=? AND state='unknown'
         UNION ALL
         SELECT * FROM (SELECT * FROM tasks WHERE session=? AND state='submitted' ORDER BY id DESC LIMIT 20)`,
        binding.session, binding.session).toArray();
      for (const task of inputs) {
        const device = this.store.get<string>("device:" + task.id);
        if (device) devices.set(device, task);
      }
    }
    for (const event of events) {
      const payload = object(event.payload);
      if (payload.session_id !== undefined && payload.session_id !== binding.session) continue;
      if (event.event_name === "message.user") {
        const device = string(object(payload.metadata).client_device_id) || string(object(payload.chat_context).device_id);
        const task = device ? devices.get(device) : undefined;
        const textMatches = task && (
          payload.display_text === task.text
          || payload.content === task.text
          || (typeof payload.display_text === "string" && payload.display_text.includes(task.text))
          || (task.text === "[图片]" && typeof payload.display_text === "string" && payload.display_text.includes("[已附图片"))
        );
        if (task && textMatches) {
          const receipt = this.store.get<Record<string, unknown>>("native-input:" + task.id) ?? {};
          if (!receipt.confirmed_at) {
            this.store.set("native-input:" + task.id, { ...receipt, confirmed_at: Date.now(), event_seq: event.seq,
              muse_input_at: typeof payload.display_text_updated_at_ms === "number" ? payload.display_text_updated_at_ms : null });
          }
          if (task.state === "unknown") this.store.sql.exec("UPDATE tasks SET state='submitted' WHERE id=?", task.id);
        }
      }
      if (event.event_name !== "message.assistant" || Number(event.seq) <= binding.cursor) continue;
      const identity = string(event.message_id) || string(payload.message_id);
      if (!identity) throw new Error("assistant_identity_unavailable");
      latest.set(identity, event);
    }
    let cursor = Math.max(binding.cursor, ...events.map((event) => Number(event.seq)));
    let produced = false;
    const outputs: { identity: string; text: string; seq: number; completedAt: number | null }[] = [];
    for (const [identity, event] of latest) {
      const payload = object(event.payload);
      const state = string(payload.status);
      if (!["completed", "complete", "succeeded", "failed", "error", "cancelled", "canceled"].includes(state) || payload.display_text_ready === false) {
        cursor = Math.min(cursor, Number(event.seq) - 1);
        continue;
      }
      const text = string(payload.display_text) || string(payload.content);
      if (text) outputs.push({ identity, text, seq: Number(event.seq), completedAt: typeof payload.display_text_updated_at_ms === "number" ? payload.display_text_updated_at_ms : null });
    }
    this.commit(() => {
      for (const output of outputs) {
        const id = "native:" + binding.session + ":" + output.identity;
        const rows = this.store.sql.exec<Task>(`INSERT OR IGNORE INTO tasks(message_id,route,conversation,generation,text,state,session,baseline,created_at)
          VALUES (?,?,?,?,?,'queued',?,?,?) RETURNING *`, id, binding.route, binding.conversation, binding.generation, output.text, binding.session, output.seq, Date.now()).toArray();
        if (rows[0]) {
          const extracted = extractOutboundFiles(output.text);
          const replyText = extracted.text ? channelReply(extracted.text) : (extracted.files.length ? "" : channelReply(output.text));
          this.store.complete(rows[0], replyText);
          if (extracted.files.length) this.store.setOutboundFiles(rows[0].id, extracted.files, owner);
          this.store.set("native-output:" + rows[0].id, { message_id: output.identity, muse_completed_at: output.completedAt, captured_at: Date.now() });
          produced = true;
        }
      }
      this.store.sql.exec("UPDATE native_sessions SET cursor=?,last_checked=? WHERE session=?", cursor, Date.now(), binding.session);
    });
    return produced;
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
