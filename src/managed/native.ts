import type { MuseRpc } from "../noise";
import { object, string, type Incoming } from "./protocol";
import { channelReply } from "./reply";
import { ManagedStore, type Task } from "./store";

export interface NativeSession extends Record<string, SqlStorageValue> {
  session: string;
  conversation: string;
  generation: number;
  route: string;
  cursor: number;
  awaiting: number;
  last_checked: number;
}
type Rpc = <T>(operation: (client: MuseRpc) => Promise<T>) => Promise<T>;
type Commit = (operation: () => void) => void;

/** Native Muse owns turn scheduling. This relay persists transport receipts only. */
export class NativeConversations {
  constructor(private store: ManagedStore, private rpc: Rpc, private commit: Commit,
    private watch: (session: string) => void) {
    store.sql.exec(`CREATE TABLE IF NOT EXISTS native_sessions(
      session TEXT PRIMARY KEY, conversation TEXT NOT NULL, generation INTEGER NOT NULL,
      route TEXT NOT NULL, cursor INTEGER NOT NULL, awaiting INTEGER NOT NULL DEFAULT 1,
      last_checked INTEGER NOT NULL DEFAULT 0, UNIQUE(conversation,generation))`);
  }

  private events(response: unknown) {
    const data = object(response);
    if (!Array.isArray(data.chat_events)) throw new Error("history_unavailable");
    return data.chat_events.map(object).filter((event) => Number.isSafeInteger(event.seq))
      .sort((a, b) => Number(a.seq) - Number(b.seq));
  }

  private history(session: string) {
    return this.rpc((client) => client.call("/chat/history?session_id=" + encodeURIComponent(session) + "&limit=500", 0));
  }

  sessions() {
    return this.store.sql.exec<NativeSession>(`SELECT n.* FROM native_sessions n JOIN conversations c ON c.id=n.conversation
      WHERE n.awaiting=1 OR c.generation=n.generation ORDER BY n.last_checked`).toArray();
  }

  private async bind(task: Task): Promise<NativeSession> {
    const existing = this.store.sql.exec<NativeSession>("SELECT * FROM native_sessions WHERE conversation=? AND generation=?", task.conversation, task.generation).toArray()[0];
    if (existing) return existing;
    const conversation = this.store.sql.exec<{ generation: number; session: string | null }>("SELECT generation,session FROM conversations WHERE id=?", task.conversation).one();
    const key = "session:" + task.conversation + ":" + task.generation;
    let session = task.session ?? this.store.get<string>(key) ?? (conversation.generation === task.generation ? conversation.session : null);
    if (!session) {
      const started = object(await this.rpc((client) => client.call("/session/start", 0, "POST", {
        method: "/api/session/start", params: { origin: "fresh", lifecycle: "persistent", title: "CF managed channel" },
      })));
      session = string(started.session_id);
      if (!session) throw new Error("session_unavailable");
      this.store.set(key, session);
      this.store.sql.exec("UPDATE conversations SET session=? WHERE id=? AND generation=?", session, task.conversation, task.generation);
    }
    // Existing delivered replies form the initial boundary. Unsettled old turns
    // instead start at their original boundary so an upgrade cannot lose a reply.
    const unfinished = this.store.sql.exec<{ baseline: number }>(
      "SELECT baseline FROM tasks WHERE conversation=? AND generation=? AND session=? AND state IN ('running','unknown','submitting')", task.conversation, task.generation, session).toArray();
    const events = this.events(await this.history(session));
    const cursor = unfinished.length ? Math.min(...unfinished.map((row) => row.baseline)) : Math.max(0, ...events.map((event) => Number(event.seq)));
    this.store.sql.exec("INSERT INTO native_sessions(session,conversation,generation,route,cursor) VALUES (?,?,?,?,?)", session, task.conversation, task.generation, task.route, cursor);
    return this.store.sql.exec<NativeSession>("SELECT * FROM native_sessions WHERE session=?", session).one();
  }

  /** A successfully sent input never waits for an earlier assistant reply. */
  async forward(task: Task) {
    if (task.text.trim() === "/stop") {
      const row = this.store.sql.exec<{ session: string | null }>("SELECT session FROM conversations WHERE id=? AND generation=?", task.conversation, task.generation).toArray()[0];
      if (row?.session) {
        this.store.sql.exec("UPDATE tasks SET state='submitting',session=? WHERE id=?", row.session, task.id);
        try { await this.rpc((client) => client.call("/chat/cancel", 0, "POST", { session_id: row.session })); }
        catch { this.store.sql.exec("UPDATE tasks SET state='unknown' WHERE id=?", task.id); return; }
      }
      this.commit(() => this.store.complete(task, row?.session ? "已向 Muse 发送停止请求。" : "当前没有已连接的 Muse 会话。"));
      return;
    }
    const binding = await this.bind(task);
    const device = "cf-managed-" + crypto.randomUUID();
    this.commit(() => {
      this.store.set("device:" + task.id, device);
      this.store.set("native-input:" + task.id, { sending_at: Date.now() });
      this.store.sql.exec("UPDATE native_sessions SET route=?,awaiting=1 WHERE session=?", task.route, binding.session);
      this.store.sql.exec("UPDATE tasks SET state='submitting',session=?,baseline=? WHERE id=? AND state='queued'", binding.session, binding.cursor, task.id);
    });
    this.watch(binding.session);
    try {
      await this.rpc((client) => client.open("/chat/stream", 0, "POST", {
        session_id: binding.session, node_id: device, capabilities: {}, items: [{ type: "text", text: task.text }],
      }));
      this.store.sql.exec("UPDATE tasks SET state='submitted' WHERE id=?", task.id);
      this.store.set("native-input:" + task.id, { ...this.store.get<object>("native-input:" + task.id), submitted_at: Date.now() });
    } catch {
      // Recovery only inspects this device receipt; it never resends this input.
      this.store.sql.exec("UPDATE tasks SET state='unknown' WHERE id=?", task.id);
    }
  }

  /** Adopt any old in-flight transport receipt without resubmitting the message. */
  async recoverLegacy() {
    const rows = this.store.sql.exec<Task>("SELECT * FROM tasks WHERE state IN ('running','unknown') AND session IS NOT NULL ORDER BY id").toArray();
    for (const task of rows) {
      await this.bind(task);
      if (task.state === "running") this.store.sql.exec("UPDATE tasks SET state='submitted' WHERE id=?", task.id);
    }
  }

  /** Forward each completed native assistant message, including intermediate answers.
   * The session itself may still be running; it is never a gate on delivery.
   */
  async collect(binding: NativeSession): Promise<boolean> {
    this.watch(binding.session);
    const events = this.events(await this.history(binding.session));
    const latest = new Map<string, Record<string, unknown>>();
    const inputs = this.store.sql.exec<Task>("SELECT * FROM tasks WHERE session=? AND state IN ('submitted','unknown')", binding.session).toArray();
    const devices = new Map(inputs.map((task) => [this.store.get<string>("device:" + task.id), task]));
    for (const event of events) {
      const payload = object(event.payload);
      if (payload.session_id !== undefined && payload.session_id !== binding.session) continue;
      if (event.event_name === "message.user") {
        const device = string(object(payload.metadata).client_device_id) || string(object(payload.chat_context).device_id);
        const task = device ? devices.get(device) : undefined;
        if (task && (payload.display_text === task.text || payload.content === task.text)) {
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
          this.store.complete(rows[0], channelReply(output.text));
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
    const status = object(await this.rpc((client) => client.call("/api/session/list/" + encodeURIComponent(binding.session), 0)));
    if (["completed", "failed", "error", "cancelled", "canceled"].includes(string(status.status))) {
      this.store.sql.exec("UPDATE native_sessions SET awaiting=0 WHERE session=?", binding.session);
    }
  }
}
