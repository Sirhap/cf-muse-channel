import { DurableObject } from "cloudflare:workers";
import { authorize } from "./auth.js";
import { MAX_BYTES, normalize, validReceipt } from "./protocol.js";
import { handleApi } from "./api.js";

/** Send only bounded protocol data; failed delivery remains queued in SQLite. */
function send(ws, payload) {
  try {
    if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(payload)); return true; }
  } catch { /* The next connection replays unacknowledged records. */ }
  return false;
}

/** A single personal room owns durable messages and a fenced connection per role. */
export class ChannelRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL,
      id TEXT NOT NULL, payload TEXT NOT NULL, received INTEGER NOT NULL DEFAULT 0,
      UNIQUE(source,id))`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS pending_messages ON messages(source,received,seq)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS peers (role TEXT PRIMARY KEY, generation TEXT NOT NULL)");
    // Media bytes are stored once, base64-encoded, and referenced by message
    // frames; frames themselves stay inside the 64 KiB protocol limit.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS media (
      room TEXT NOT NULL, id TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL,
      size INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(room,id))`);
  }

  /** Reauthenticate and fence the previous transport before replaying pending rows. */
  async fetch(request) {
    const auth = await authorize(request, this.env);
    if (!auth) return new Response("Unauthorized", { status: 401 });
    if (new URL(request.url).pathname.startsWith("/api/")) return handleApi(this, request, auth);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
    const generation = crypto.randomUUID();
    this.sql.exec("INSERT INTO peers VALUES (?,?) ON CONFLICT(role) DO UPDATE SET generation=excluded.generation", auth.role, generation);
    for (const old of this.ctx.getWebSockets(auth.role)) {
      try { old.close(4001, "replaced"); } catch { /* Already disconnected. */ }
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [auth.role]);
    server.serializeAttachment({ role: auth.role, generation, inflight: [] });
    send(server, { type: "ready", role: auth.role, room: auth.room });
    this.pump(server, auth.role);
    const headers = auth.browser ? { "Sec-WebSocket-Protocol": "cf-muse-v1" } : {};
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  /** Bound replay memory to twenty frames, refilling only after receiver ACKs. */
  pump(socket, role) {
    const attachment = socket.deserializeAttachment();
    const inflight = new Set(attachment.inflight || []);
    const source = role === "user" ? "muse" : "user";
    for (const row of this.sql.exec("SELECT id,payload FROM messages WHERE source=? AND received=0 ORDER BY seq LIMIT 20", source)) {
      if (inflight.size >= 20) break;
      if (!inflight.has(row.id) && send(socket, JSON.parse(row.payload))) inflight.add(row.id);
    }
    socket.serializeAttachment({ ...attachment, inflight: [...inflight] });
  }

  /** Ignore a superseded socket even if an old buffered callback arrives late. */
  active(socket) {
    const peer = socket.deserializeAttachment();
    if (!peer || !["user", "muse"].includes(peer.role)) return null;
    const current = this.sql.exec("SELECT generation FROM peers WHERE role=?", peer.role).toArray()[0];
    return current?.generation === peer.generation ? peer.role : null;
  }

  /** Persist before network confirmation; never turn protocol errors into execution. */
  async webSocketMessage(socket, raw) {
    const role = this.active(socket);
    if (!role) return;
    let messageId;
    try {
      if (typeof raw !== "string" || new TextEncoder().encode(raw).length > MAX_BYTES) throw new Error("invalid_frame");
      let frame;
      try { frame = JSON.parse(raw); } catch { throw new Error("invalid_json"); }
      if (typeof frame?.id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(frame.id)) messageId = frame.id;
      if (frame?.type === "ping") { send(socket, { type: "pong" }); return; }
      if (frame?.type === "received") { this.receipt(socket, role, frame); return; }
      const message = normalize(frame, role);
      if (role === "muse" && !this.sql.exec("SELECT id FROM messages WHERE source='user' AND id=?", message.reply_to).toArray().length) {
        throw new Error("unknown_task");
      }
      const payload = JSON.stringify(message);
      const existing = this.sql.exec("SELECT payload,received FROM messages WHERE source=? AND id=?", role, message.id).toArray()[0];
      if (existing && existing.payload !== payload) throw new Error("id_conflict");
      if (!existing) {
        if (this.sql.exec("SELECT COUNT(*) AS n FROM messages").one().n >= 10000) throw new Error("capacity_reached");
        this.sql.exec("INSERT INTO messages(source,id,payload) VALUES (?,?,?)", role, message.id, payload);
      }
      send(socket, { type: "stored", id: message.id, duplicate: Boolean(existing), received: Boolean(existing?.received) });
      if (!existing) {
        const other = role === "muse" ? "user" : "muse";
        for (const peer of this.ctx.getWebSockets(other)) if (this.active(peer)) this.pump(peer, other);
      }
    } catch (error) {
      const allowed = ["invalid_frame", "invalid_json", "id_conflict", "capacity_reached", "unknown_task"];
      send(socket, { type: "error", code: allowed.includes(error?.message) ? error.message : "storage_failed", ...(messageId ? { id: messageId } : {}) });
    }
  }

  /** Only an authorized recipient may advance receipt state and notify the sender. */
  receipt(socket, role, frame) {
    if (!validReceipt(frame, role)) { send(socket, { type: "error", code: "invalid_receipt" }); return; }
    const row = this.sql.exec("SELECT id FROM messages WHERE source=? AND id=?", frame.source, frame.id).toArray()[0];
    if (!row) { send(socket, { type: "error", code: "unknown_message" }); return; }
    this.sql.exec("UPDATE messages SET received=1 WHERE source=? AND id=?", frame.source, frame.id);
    const attachment = socket.deserializeAttachment();
    socket.serializeAttachment({ ...attachment, inflight: (attachment.inflight || []).filter((id) => id !== frame.id) });
    send(socket, { type: "acknowledged", id: frame.id, source: frame.source });
    this.pump(socket, role);
    for (const peer of this.ctx.getWebSockets(frame.source)) {
      if (this.active(peer)) send(peer, { type: "delivered", id: frame.id, recipient: role });
    }
  }

  /** Close without discarding messages that have not been received. */
  async webSocketClose(socket) { try { socket.close(1000, "closed"); } catch { /* Idempotent cleanup. */ } }

  /** Transport failure does not change the durable delivery state. */
  async webSocketError(socket) { try { socket.close(1011, "transport_error"); } catch { /* Already closed. */ } }
}
