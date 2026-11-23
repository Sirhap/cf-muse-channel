import type { Incoming } from "./protocol";
import type { MuseOwner } from "./muse-owner";
export type TaskState = "queued" | "submitting" | "submitted" | "running" | "unknown" | "succeeded" | "failed" | "cancelled";
export interface Task extends Record<string, SqlStorageValue> {
  id: number; message_id: string; route: string; conversation: string; text: string; state: TaskState;
  session: string | null; baseline: number; result: string | null; created_at: number; generation: number;
}
export interface Outbound extends Record<string, SqlStorageValue> { id: number; task_id: number; route: string; text: string; state: string; }
export class ManagedStore {
  constructor(readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS config(channel TEXT PRIMARY KEY,value TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0, session TEXT)");
    sql.exec(`CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL,
      route TEXT NOT NULL, conversation TEXT NOT NULL, generation INTEGER NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL,
      session TEXT, baseline INTEGER NOT NULL DEFAULT 0, result TEXT, created_at INTEGER NOT NULL, UNIQUE(message_id,conversation))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS outbound(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL,
      route TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', UNIQUE(task_id))`);
    sql.exec("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS tasks_conversation_state ON tasks(conversation,state,id)");
    sql.exec("CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state,id)");
    sql.exec("CREATE INDEX IF NOT EXISTS tasks_session_state ON tasks(session,state,id)");
    sql.exec("CREATE INDEX IF NOT EXISTS outbound_state ON outbound(state,id)");
  }
  get<T>(key: string): T | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM metadata WHERE key=?", key).toArray()[0];
    return row ? JSON.parse(row.value) as T : null;
  }
  set(key: string, data: unknown) {
    this.sql.exec("INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(data));
  }
  setOutboundFiles(taskId: number, files: string[], owner: MuseOwner) {
    this.set("outbound-files:" + taskId, files);
    this.set("outbound-owner:" + taskId, owner);
  }
  ingest(message: Incoming): Task | null {
    const conversation = JSON.stringify([message.channel, message.account, message.group, message.chat]);
    this.sql.exec("INSERT OR IGNORE INTO conversations(id) VALUES (?)", conversation);
    const { generation } = this.sql.exec<{ generation: number }>("SELECT generation FROM conversations WHERE id=?", conversation).one();
    const rows = this.sql.exec<Task>(`INSERT OR IGNORE INTO tasks(message_id,route,conversation,generation,text,state,created_at)
      VALUES (?,?,?,?,?,'queued',?) RETURNING *`, message.id, JSON.stringify(message), conversation, generation, message.text, Date.now()).toArray();
    return rows[0] ?? null;
  }
  complete(task: Task, text: string, state: TaskState = "succeeded") {
    const current = this.task(task.id);
    if (["succeeded", "failed", "cancelled"].includes(current.state)) {
      if (current.state !== state || current.result !== text) throw new Error("result_already_committed");
      return;
    }
    this.sql.exec("INSERT OR IGNORE INTO outbound(task_id,route,text) VALUES (?,?,?)", task.id, task.route, text);
    this.sql.exec("UPDATE tasks SET state=?,result=? WHERE id=?", state, text, task.id);
  }
  task(id: number) { return this.sql.exec<Task>("SELECT * FROM tasks WHERE id=?", id).one(); }
  candidate(): Task | null {
    return this.sql.exec<Task>(`SELECT t.* FROM tasks t WHERE t.state='queued' AND NOT EXISTS (
      SELECT 1 FROM tasks blocked JOIN metadata m ON m.key='task-error:' || blocked.id
      WHERE blocked.conversation=t.conversation AND blocked.generation=t.generation AND blocked.state='queued' AND blocked.id<=t.id
        AND json_extract(m.value,'$.retry_after')>?) ORDER BY t.id LIMIT 1`, Date.now()).toArray()[0] ?? null;
  }
  command(task: Task): string | null {
    const word = task.text.trim();
    if (word === "/ping") return "pong · CF 网关运行中";
    if (word === "/help") return "/ping 连通检查\n/status 连接状态\n/new 新会话\n/stop 向 Muse 请求停止\n/help 命令表\n消息直接交给 Muse 原生处理。";
    if (word === "/unsupported-media") return "这条媒体消息暂不支持解析（或缺少可下载附件），请改发文字、图片或常规文件。";
    if (word === "/voice-empty") return "没听清这段语音，请再发一次语音或改发文字。";
    if (word === "/new") {
      this.sql.exec("UPDATE conversations SET generation=generation+1,session=NULL WHERE id=?", task.conversation);
      return "已开启新会话。";
    }
    if (word === "/queue") return "CF 不设置对话执行队列，消息由 Muse 原生处理。";
    if (word === "/status") return "CF 渠道已连接，消息直接交给 Muse 原生处理。";
    if (word === "/stop") return null; // Requires remote cancellation in the runtime.
    return null;
  }
}
