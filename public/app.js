import { MAX_FRAME_BYTES, MAX_TASKS, channelUrl, errorText, isReply, mediaUrl, serverOrigin, socketProtocols, taskFrame } from "./protocol.js";

const element = (id) => document.getElementById(id);
const ui = Object.fromEntries(["server", "room", "token", "connect", "disconnect", "connection-status", "status-text", "notice", "messages", "empty-state", "message", "send"].map((id) => [id, element(id)]));
const tasks = new Map();
const pending = new Map();
const received = new Map();
let socket = null;
let settings = null;
let reconnectTimer = null;
let pingTimer = null;
let attempts = 0;
let online = false;
let sessionReady = false;
let generation = 0;
let conversationScope = null;
if (["http:", "https:"].includes(location.protocol)) ui.server.value = location.origin;

/** Display fixed application messages, never server-provided error strings. */
function notice(text = "") {
  ui.notice.textContent = text;
  ui.notice.hidden = !text;
}

/** Connection state describes CF transport availability, not Muse execution. */
function status(state, text) {
  online = state === "online";
  ui["connection-status"].dataset.state = state;
  ui["status-text"].textContent = text;
  ui.message.disabled = !online;
  ui.send.disabled = !online;
  ui.connect.disabled = Boolean(settings);
  ui.disconnect.disabled = !settings;
  for (const field of [ui.server, ui.room, ui.token]) field.disabled = Boolean(settings);
  ui.connect.textContent = online ? "已连接" : settings ? "连接中" : "连接频道 ↗";
}

/** Keep at most 200 task cards, without deleting unconfirmed outgoing tasks. */
function makeRoom() {
  if (tasks.size < MAX_TASKS) return true;
  const candidate = [...tasks.keys()].find((id) => !pending.has(id));
  if (!candidate) return false;
  tasks.get(candidate).node.remove();
  tasks.delete(candidate);
  return true;
}

/** Create all user-provided text using DOM text nodes. */
function createTask(id, content, restored = false) {
  if (!makeRoom()) throw new Error("task_limit");
  ui["empty-state"].hidden = true;
  const node = document.createElement("article");
  node.className = "task";
  const head = document.createElement("div");
  head.className = "task-head";
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.textContent = "你";
  const author = document.createElement("strong");
  author.textContent = restored ? "恢复的历史任务" : "你的任务";
  const time = document.createElement("time");
  time.className = "task-time";
  time.dateTime = new Date().toISOString();
  time.textContent = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  head.append(avatar, author, time);
  const body = document.createElement("div");
  body.className = "task-content";
  body.textContent = content;
  const state = document.createElement("p");
  state.className = "task-state";
  state.textContent = restored ? "本页没有保留原消息，正在接收历史回复。" : "等待 CF 保存…";
  node.append(head, body, state);
  ui.messages.append(node);
  const task = { node, state, progress: null, result: null };
  tasks.set(id, task);
  scrollToLatest();
  return task;
}

/** Move to new content only when useful to the current reader. */
function scrollToLatest() {
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

/** Send only while this socket has passed the application handshake. */
function send(frame) {
  if (!online || !socket || socket.readyState !== WebSocket.OPEN) return false;
  try { socket.send(JSON.stringify(frame)); return true; }
  catch { notice("连接已中断，未确认保存的消息会在重连后用原编号重试。"); return false; }
}

/** Render one progress/result under its original task, then acknowledge receipt. */
function renderReply(frame) {
  const previous = received.get(frame.id);
  if (previous && previous !== JSON.stringify(frame)) throw new Error("id_conflict");
  if (!previous) {
    const task = tasks.get(frame.reply_to) || createTask(frame.reply_to, "原任务正文不在当前页面内存中。", true);
    if (frame.kind === "progress" && !task.result) {
      if (!task.progress) {
        task.progress = document.createElement("div");
        task.progress.className = "progress";
        task.node.append(task.progress);
      }
      task.progress.textContent = "Muse 进度 · " + frame.content;
    } else if (frame.kind === "result") {
      if (!task.result) {
        task.result = document.createElement("div");
        task.result.className = "reply";
        const head = document.createElement("div");
        head.className = "reply-head";
        const mark = document.createElement("span"); mark.className = "reply-mark"; mark.textContent = "m.";
        const author = document.createElement("strong"); author.textContent = "Muse";
        const kind = document.createElement("span"); kind.className = "reply-kind"; kind.textContent = "正式回复";
        head.append(mark, author, kind);
        const body = document.createElement("div"); body.className = "reply-content";
        task.result.append(head, body);
        task.node.append(task.result);
      }
      task.result.querySelector(".reply-content").textContent = frame.content;
      if (frame.media && !task.result.querySelector(".reply-media")) {
        const mediaBox = document.createElement("div");
        mediaBox.className = "reply-media";
        const label = document.createElement("p");
        label.className = "media-label";
        label.textContent = `${frame.media.filename} · ${(frame.media.size / 1024).toFixed(0)} KiB · 正在加载…`;
        mediaBox.append(label);
        task.result.append(mediaBox);
        // Native playback handles the rest; the token is a header, never a URL part.
        fetch(mediaUrl(settings.server, settings.room, frame.media.id), { headers: { Authorization: "Bearer " + settings.token } })
          .then((response) => { if (!response.ok) throw new Error("media_download_failed"); return response.blob(); })
          .then((blob) => {
            const url = URL.createObjectURL(new Blob([blob], { type: frame.media.mime }));
            let element;
            if (frame.media.mime.startsWith("video/")) { element = document.createElement("video"); element.controls = true; }
            else if (frame.media.mime.startsWith("image/")) { element = document.createElement("img"); element.alt = frame.media.filename; }
            else if (frame.media.mime.startsWith("audio/")) { element = document.createElement("audio"); element.controls = true; }
            else { element = document.createElement("a"); element.href = url; element.download = frame.media.filename; element.textContent = "下载 " + frame.media.filename; }
            if (element.tagName !== "A") element.src = url;
            label.textContent = `${frame.media.filename} · ${(frame.media.size / 1024).toFixed(0)} KiB`;
            mediaBox.append(element);
          })
          .catch(() => { label.textContent = `${frame.media.filename} · 媒体加载失败，请保持连接后重试`; });
      }
      task.progress?.remove();
      task.progress = null;
      task.state.textContent = "已收到 Muse 的正式回复";
    }
    received.set(frame.id, JSON.stringify(frame));
    if (received.size > 2000) received.delete(received.keys().next().value);
    scrollToLatest();
  }
  send({ type: "received", id: frame.id, source: "muse" });
}

/** Handle allowlisted protocol events; malformed frames never reach the DOM. */
function handleMessage(raw) {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > MAX_FRAME_BYTES) throw new Error("invalid_frame");
  const frame = JSON.parse(raw);
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("invalid_frame");
  if (frame.type === "ready") {
    if (frame.role !== "user" || frame.room !== settings?.room) throw new Error("invalid_frame");
    sessionReady = true;
    status("online", "CF 已连接");
    notice();
    for (const message of pending.values()) send(message);
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: "ping" }), 30000);
    return;
  }
  if (!online) throw new Error("invalid_frame");
  if (frame.type === "message") {
    if (!isReply(frame)) throw new Error("invalid_frame");
    renderReply(frame);
  } else if (frame.type === "stored" || frame.type === "delivered") {
    const task = tasks.get(frame.id);
    if (!task) return;
    if (frame.type === "stored") pending.delete(frame.id);
    if (!task.result) task.state.textContent = frame.type === "delivered" || frame.received === true ? "Muse 接入器已接收 · 等待执行与回复" : "CF 已保存 · 等待 Muse 接入器接收";
  } else if (frame.type === "error") {
    const task = tasks.get(frame.id);
    const text = errorText(frame.code);
    if (task) { task.state.textContent = text; task.state.dataset.error = "true"; }
    if (frame.id && frame.code !== "internal_error" && frame.code !== "storage_failed") pending.delete(frame.id);
    notice(text);
  }
}

/** Establish a role-bound socket with a finite session retry budget. */
function openSocket() {
  if (!settings) return;
  const current = ++generation;
  let readyThisConnection = false;
  status("connecting", attempts ? `重新连接 ${attempts}/8` : "正在连接 CF");
  try { socket = new WebSocket(channelUrl(settings.server, settings.room), socketProtocols(settings.token)); }
  catch { disconnect("连接无法建立，请检查服务器、房间和用户密钥。"); return; }
  const activeSocket = socket;
  activeSocket.addEventListener("message", (event) => {
    if (current !== generation) return;
    try { handleMessage(event.data); readyThisConnection ||= online; }
    catch (error) { notice(errorText(error.message)); activeSocket.close(1002, "invalid_protocol"); }
  });
  activeSocket.addEventListener("error", () => {
    if (current === generation) notice("连接未完成。请检查地址、网络、房间与用户密钥。");
  });
  activeSocket.addEventListener("close", (event) => {
    if (current !== generation || !settings) return;
    clearInterval(pingTimer);
    online = false;
    if (event.code === 4001) { disconnect("此频道已在其他页面连接，当前页面已停止重连。"); return; }
    if (!sessionReady || (!readyThisConnection && [1002, 1008].includes(event.code))) {
      disconnect("连接未通过，请核对服务器、房间、用户密钥和服务配置后重新连接。"); return;
    }
    if (attempts >= 8) { disconnect("已尝试重连 8 次。请检查服务后手动连接；未确认消息保留在本页。"); return; }
    attempts += 1;
    status("connecting", `等待重连 ${attempts}/8`);
    notice("连接中断，未确认保存的消息会使用原编号重试。请保留当前页面。");
    reconnectTimer = setTimeout(openSocket, Math.min(1000 * 2 ** (attempts - 1), 30000));
  });
}

/** Explicit disconnect clears secrets and stops every automatic retry. */
function disconnect(reason = "已断开连接，密钥已清除。") {
  generation += 1;
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  settings = null;
  sessionReady = false;
  ui.token.value = "";
  if (socket) { try { socket.close(1000, "user_disconnect"); } catch { /* Already closed. */ } }
  socket = null;
  status("offline", "未连接");
  notice(reason);
}

element("connection-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (settings) return;
  try {
    const next = { server: serverOrigin(ui.server.value.trim()), room: ui.room.value.trim(), token: ui.token.value };
    channelUrl(next.server, next.room);
    socketProtocols(next.token);
    const scope = `${next.server}/${next.room}`;
    if (conversationScope && conversationScope !== scope && pending.size) {
      notice("还有未确认保存的消息，请先连接原服务器和房间完成确认，再切换频道。");
      return;
    }
    if (conversationScope !== scope) {
      for (const task of tasks.values()) task.node.remove();
      tasks.clear(); received.clear();
      ui["empty-state"].hidden = false;
      conversationScope = scope;
    }
    settings = next;
    ui.token.value = "";
    ui.token.placeholder = "密钥已载入当前连接";
    attempts = 0;
    sessionReady = false;
    openSocket();
  } catch (error) { settings = null; notice(errorText(error.message)); }
});
ui.disconnect.addEventListener("click", () => disconnect());
element("message-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!online) return;
  try {
    const frame = taskFrame(ui.message.value);
    createTask(frame.id, frame.content);
    pending.set(frame.id, frame);
    send(frame);
    ui.message.value = "";
    ui.message.style.height = "auto";
    notice();
    ui.message.focus();
  } catch (error) { notice(error.message === "task_limit" ? "当前页面已有 200 条未确认任务，请等待接收确认。" : errorText(error.message)); }
});
ui.message.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); element("message-form").requestSubmit(); }
});
ui.message.addEventListener("input", () => { ui.message.style.height = "auto"; ui.message.style.height = Math.min(ui.message.scrollHeight, 180) + "px"; });
window.addEventListener("beforeunload", () => { settings = null; ui.token.value = ""; socket?.close(1000, "page_closed"); });
