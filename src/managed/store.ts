import type { Incoming } from "./protocol";
export type TaskState = "queued" | "submitting" | "running" | "unknown" | "succeeded" | "failed" | "cancelled";
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
    sql.exec("CREATE INDEX IF NOT EXISTS outbound_state ON outbound(state,id)");
  }
  get<T>(key: string): T | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM metadata WHERE key=?", key).toArray()[0];
    return row ? JSON.parse(row.value) as T : null;
  }
  set(key: string, data: unknown) {
    this.sql.exec("INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(data));
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
    return this.sql.exec<Task>(`SELECT t.* FROM tasks t WHERE state='queued' AND NOT EXISTS(
      SELECT 1 FROM tasks older WHERE older.conversation=t.conversation AND older.id<t.id
      AND older.state IN ('queued','submitting','running','unknown')) ORDER BY id LIMIT 1`).toArray()[0] ?? null;
  }
  command(task: Task): string | null {
    const [word, ...args] = task.text.trim().split(/\s+/);
    if (word === "/ping") return "pong · CF 网关运行中";
    if (word === "/help") return "/ping 连通检查\n/status 状态\n/queue 排队\n/new 新会话\n/stop 停止任务\n/help 命令表\n首版支持文字消息。";
    if (word === "/unsupported-media") return "CF 托管首版暂支持文字，请发送文字消息。";
    if (word === "/new") {
      this.sql.exec("UPDATE conversations SET generation=generation+1,session=NULL WHERE id=?", task.conversation);
      return "已开启新会话。";
    }
    if (word === "/status" || word === "/queue") {
      const rows = this.sql.exec<{ state: string; count: number }>("SELECT state,COUNT(*) count FROM tasks WHERE conversation=? AND id<>? AND state IN ('queued','running','submitting','unknown') GROUP BY state", task.conversation, task.id).toArray();
      return rows.length ? rows.map((row) => ({ queued: "排队", running: "执行", submitting: "提交中", unknown: "待核查" }[row.state] + " " + row.count)).join("\n") : "当前空闲。";
    }
    if (word === "/stop") return null; // Requires remote cancellation in the runtime.
    if (word.startsWith("/")) return "暂不支持此命令，请发送 /help。";
    if (args.length > 10000 || task.text.length > 32000) return "消息过长，请缩短后再发送。";
    return null;
  }
}
