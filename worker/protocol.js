export const MAX_BYTES = 65536;
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const FILENAME = /^(?!.*[\\/])(?!\.{1,2}$)[^\x00-\x1f]{1,128}$/;
const MIME = /^(video|image|audio)\/[a-z0-9.+-]+$|^application\/pdf$/;

/** Validate one media attachment reference; the bytes live in Worker storage, never in the frame. */
export function validMedia(media) {
  return media && typeof media === "object" && !Array.isArray(media) &&
    typeof media.id === "string" && ID.test(media.id) &&
    typeof media.filename === "string" && FILENAME.test(media.filename) &&
    typeof media.mime === "string" && MIME.test(media.mime) &&
    Number.isInteger(media.size) && media.size >= 1 && media.size <= MAX_MEDIA_BYTES;
}

/** Canonicalize a role-bound message, rejecting unsupported semantics. */
export function normalize(frame, role) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame) ||
      typeof frame.id !== "string" || !ID.test(frame.id) ||
      frame.type !== "message" || typeof frame.content !== "string" || !frame.content.trim()) {
    throw new Error("invalid_frame");
  }
  const kind = frame.kind ?? (role === "user" ? "task" : "result");
  if (role === "user" && (kind !== "task" || frame.reply_to !== undefined || frame.media !== undefined ||
      frame.id.length > 96 || frame.id.startsWith("cancel:") || [".", ".."].includes(frame.id))) {
    throw new Error("invalid_frame");
  }
  if (role === "muse" && (!["progress", "result"].includes(kind) ||
      typeof frame.reply_to !== "string" || !ID.test(frame.reply_to) ||
      (kind === "result" && frame.id !== "result:" + frame.reply_to) ||
      (frame.media !== undefined && (kind !== "result" || !validMedia(frame.media))))) {
    throw new Error("invalid_frame");
  }
  const message = { type: "message", id: frame.id, source: role, kind, content: frame.content };
  if (role === "muse") message.reply_to = frame.reply_to;
  if (frame.media !== undefined) message.media = { id: frame.media.id, filename: frame.media.filename, mime: frame.media.mime, size: frame.media.size };
  if (new TextEncoder().encode(JSON.stringify(message)).length > MAX_BYTES) throw new Error("invalid_frame");
  return message;
}

/** Accept only the other role's stable message ID as a receipt. */
export function validReceipt(frame, role) {
  return typeof frame.id === "string" && ID.test(frame.id) &&
    frame.source === (role === "muse" ? "user" : "muse");
}
