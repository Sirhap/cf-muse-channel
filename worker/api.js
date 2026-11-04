import { MAX_BYTES, normalize } from "./protocol.js";
const TASK_ID = /^[A-Za-z0-9_.:-]{1,96}$/;

/** Return private JSON without caching task contents at an intermediary. */
function reply(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

/** Bound untrusted bodies before decoding instead of buffering arbitrary uploads. */
async function bodyJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_frame");
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error("invalid_frame"); }
      chunks.push(value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } finally { reader.releaseLock(); }
}

/** Persist an idempotent task/control event before waking any Muse peer. */
function store(room, message) {
  const encoded = JSON.stringify(message);
  const previous = room.sql.exec("SELECT payload,received,seq FROM messages WHERE source='user' AND id=?", message.id).toArray()[0];
  if (previous && previous.payload !== encoded) return reply({ error: "id_conflict", id: message.id }, 409);
  if (!previous) {
    if (room.sql.exec("SELECT COUNT(*) AS n FROM messages").one().n >= 10000) return reply({ error: "capacity_reached" }, 507);
    room.sql.exec("INSERT INTO messages(source,id,payload) VALUES ('user',?,?)", message.id, encoded);
    for (const peer of room.ctx.getWebSockets("muse")) if (room.active(peer)) room.pump(peer, "muse");
  }
  return reply({ task_id: message.kind === "cancel" ? message.reply_to : message.id,
    id: message.id, cf_stored: true, muse_received: Boolean(previous?.received),
    duplicate: Boolean(previous), ...(message.kind === "cancel" ? { cancel_requested: true, stopped: false } : {}) });
}

/** Select limited progress/results while advancing a stable global sequence cursor. */
function list(room, taskId, after, limit) {
  // SQLite json_extract filters before LIMIT, so sparse task histories paginate correctly.
  const rows = taskId ? room.sql.exec(
    "SELECT seq,payload FROM messages WHERE source='muse' AND seq>? AND json_extract(payload,'$.reply_to')=? ORDER BY seq LIMIT ?",
    after, taskId, limit + 1).toArray() : room.sql.exec(
    "SELECT seq,payload FROM messages WHERE source='muse' AND seq>? ORDER BY seq LIMIT ?", after, limit + 1).toArray();
  const page = rows.slice(0, limit);
  return { messages: page.map((row) => ({ cursor: row.seq, ...JSON.parse(row.payload) })),
    next_cursor: page.length ? page.at(-1).seq : after, has_more: rows.length > limit,
    receipt_changed: false };
}

/** Authenticated HTTP access shares durable WSS state without opening a user socket. */
export async function handleApi(room, request, auth) {
  const url = new URL(request.url);
  const path = url.pathname.slice(("/api/rooms/" + auth.room).length);
  try {
    if (request.method === "POST" && path === "/tasks") {
      const input = await bodyJson(request);
      return store(room, normalize({ type: "message", id: input?.task_id, kind: "task", content: input?.content }, "user"));
    }
    const taskRoute = /^\/tasks\/([A-Za-z0-9_.:-]{1,96})(\/cancel)?$/.exec(path);
    if (taskRoute) {
      const id = taskRoute[1];
      const task = room.sql.exec("SELECT received FROM messages WHERE source='user' AND id=? AND json_extract(payload,'$.kind')='task'", id).toArray()[0];
      if (!task) return reply({ error: "unknown_task" }, 404);
      if (request.method === "POST" && taskRoute[2]) {
        if (room.sql.exec("SELECT id FROM messages WHERE source='muse' AND id=?", "result:" + id).toArray().length) {
          return reply({ error: "already_completed", task_id: id, stopped: false }, 409);
        }
        return store(room, { type: "message", id: "cancel:" + id, source: "user", kind: "cancel", content: "cancel_requested", reply_to: id });
      }
      if (request.method === "GET" && !taskRoute[2]) {
        const progress = room.sql.exec("SELECT seq,payload FROM messages WHERE source='muse' AND json_extract(payload,'$.reply_to')=? ORDER BY seq DESC LIMIT 1", id).toArray()[0];
        const result = room.sql.exec("SELECT seq,payload FROM messages WHERE source='muse' AND id=?", "result:" + id).toArray()[0];
        const cancellation = room.sql.exec("SELECT received FROM messages WHERE source='user' AND id=?", "cancel:" + id).toArray()[0];
        return reply({ task_id: id, cf_stored: true, muse_received: Boolean(task.received),
          execution_state: result ? "result_available" : "unknown", stopped: false,
          cancel_requested: Boolean(cancellation), cancel_received_by_muse: Boolean(cancellation?.received),
          latest_message: progress ? { cursor: progress.seq, ...JSON.parse(progress.payload) } : null,
          result: result ? { cursor: result.seq, ...JSON.parse(result.payload) } : null });
      }
    }
    if (request.method === "GET" && path === "/messages") {
      const afterText = url.searchParams.get("after") ?? "0";
      const limitText = url.searchParams.get("limit") ?? "20";
      const taskId = url.searchParams.get("task_id");
      const after = Number(afterText), limit = Number(limitText);
      if (!/^\d+$/.test(afterText) || !Number.isSafeInteger(after) || after < 0 ||
          !/^\d+$/.test(limitText) || !Number.isInteger(limit) || limit < 1 || limit > 50 ||
          (taskId !== null && !TASK_ID.test(taskId))) return reply({ error: "invalid_query" }, 400);
      return reply(list(room, taskId, after, limit));
    }
    return reply({ error: "not_found" }, 404);
  } catch (error) {
    return reply({ error: error?.message === "invalid_frame" ? "invalid_frame" : "request_failed" }, 400);
  }
}
