/** Shared, side-effect-free browser protocol helpers. */
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_TASKS = 200;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Accept a bare HTTP origin; local development may use loopback HTTP. */
export function serverOrigin(value) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password ||
      url.search || url.hash || (url.pathname !== "/" && url.pathname !== "") ||
      (url.protocol === "http:" && !local)) throw new Error("invalid_server");
  return url.origin;
}

/** Build a role-bound URL without placing authentication in its query string. */
export function channelUrl(origin, room) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(room)) throw new Error("invalid_room");
  const url = new URL(serverOrigin(origin));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/ws/${room}`;
  url.search = "role=user";
  return url.toString();
}

/** Build an authenticated media download URL; the token travels in a header, never in the URL. */
export function mediaUrl(origin, room, mediaId) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(room) || !IDENTIFIER.test(mediaId)) throw new Error("invalid_media");
  return `${serverOrigin(origin)}/api/rooms/${room}/media/${mediaId}`;
}

/** Encode an in-memory user token into the handshake subprotocol only. */
export function socketProtocols(token) {
  if (typeof token !== "string" || !token.trim() || token.length > 1024) throw new Error("invalid_token");
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(token)));
  return ["cf-muse-v1", "auth." + encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")];
}

/** Produce a stable task frame and enforce the server's complete frame limit. */
export function taskFrame(content, id = crypto.randomUUID()) {
  if (typeof id !== "string" || !IDENTIFIER.test(id) || id.length > 96) throw new Error("invalid_id");
  if (typeof content !== "string" || !content.trim()) throw new Error("empty_message");
  const frame = { type: "message", id, kind: "task", content: content.trim() };
  if (new TextEncoder().encode(JSON.stringify(frame)).byteLength > MAX_FRAME_BYTES) throw new Error("message_too_large");
  return frame;
}

/** Validate a media reference; bytes are fetched separately, never trusted from the frame. */
export function isMedia(media) {
  return media && typeof media === "object" && !Array.isArray(media) &&
    typeof media.id === "string" && IDENTIFIER.test(media.id) &&
    typeof media.filename === "string" && /^(?!.*[\\/])(?!\.{1,2}$)[^\x00-\x1f]{1,128}$/.test(media.filename) &&
    typeof media.mime === "string" && (/^(video|image|audio)\/[a-z0-9.+-]+$/.test(media.mime) || media.mime === "application/pdf") &&
    Number.isInteger(media.size) && media.size >= 1 && media.size <= 10 * 1024 * 1024;
}

/** Validate only Muse reply events; never render untrusted objects implicitly. */
export function isReply(frame) {
  return frame && frame.type === "message" && frame.source === "muse" &&
    ["progress", "result"].includes(frame.kind) && typeof frame.id === "string" &&
    IDENTIFIER.test(frame.id) && typeof frame.reply_to === "string" && IDENTIFIER.test(frame.reply_to) &&
    typeof frame.content === "string" && frame.content.trim().length > 0 &&
    (frame.kind !== "result" || frame.id === `result:${frame.reply_to}`) &&
    (frame.media === undefined || (frame.kind === "result" && isMedia(frame.media)));
}

/** Translate allowlisted protocol errors without exposing upstream error text. */
export function errorText(code) {
  return ({ invalid_server: "服务器需填写 HTTPS 根地址；本地测试可用 localhost HTTP。",
    invalid_room: "房间名只支持字母、数字、下划线和短横线，最多 64 位。",
    invalid_token: "请填写部署时设置的用户密钥。", empty_message: "先写下要交给 Muse 的任务。",
    message_too_large: "消息超过 64 KiB，请缩短后重新发送。",
    id_conflict: "消息编号已有不同内容，已停止重试这条消息，请核对后新建消息。",
    capacity_reached: "服务端消息存储已达上限，请联系部署者处理；消息未被保存。",
    invalid_frame: "消息格式未被服务端接受。", invalid_reply: "回复无法关联到原任务。",
    invalid_room_access: "当前房间不可访问，请核对部署配置。" })[code] || "通信未完成，请核对连接与服务配置后重试。";
}
