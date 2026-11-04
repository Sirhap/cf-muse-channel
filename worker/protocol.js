export const MAX_BYTES = 65536;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Canonicalize a role-bound message, rejecting unsupported semantics. */
export function normalize(frame, role) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame) ||
      typeof frame.id !== "string" || !ID.test(frame.id) ||
      frame.type !== "message" || typeof frame.content !== "string" || !frame.content.trim()) {
    throw new Error("invalid_frame");
  }
  const kind = frame.kind ?? (role === "user" ? "task" : "result");
  if (role === "user" && (kind !== "task" || frame.reply_to !== undefined || frame.id.length > 96 || frame.id.startsWith("cancel:") || [".", ".."].includes(frame.id))) {
    throw new Error("invalid_frame");
  }
  if (role === "muse" && (!["progress", "result"].includes(kind) ||
      typeof frame.reply_to !== "string" || !ID.test(frame.reply_to) ||
      (kind === "result" && frame.id !== "result:" + frame.reply_to))) {
    throw new Error("invalid_frame");
  }
  const message = { type: "message", id: frame.id, source: role, kind, content: frame.content };
  if (role === "muse") message.reply_to = frame.reply_to;
  if (new TextEncoder().encode(JSON.stringify(message)).length > MAX_BYTES) throw new Error("invalid_frame");
  return message;
}

/** Accept only the other role's stable message ID as a receipt. */
export function validReceipt(frame, role) {
  return typeof frame.id === "string" && ID.test(frame.id) &&
    frame.source === (role === "muse" ? "user" : "muse");
}
