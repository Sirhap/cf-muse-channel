export type Channel = "weixin" | "wecom";
export interface ChannelConfig {
  enabled: boolean;
  account: string;
  secret: string;
  allowedSenders: string[];
  initialCursor?: string;
}
export interface Incoming {
  id: string;
  channel: Channel;
  account: string;
  chat: string;
  sender: string;
  group: boolean;
  text: string;
  context: string;
}
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string { return typeof value === "string" ? value : ""; }
/** Persist only our bounded error codes, never upstream messages or credentials. */
export function failureCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  return /^(upstream_http_\d{3}|platform_rejected_-?\d+|wecom_upgrade_failed_\d{3}|wecom_not_connected|platform_response_unknown|platform_connection_lost|platform_send_unknown|configuration_changed|invalid_weixin_batch|response_too_large|empty_response)$/.test(error.message)
    ? error.message : error.name;
}
export function validConfig(value: unknown): ChannelConfig {
  const data = object(value);
  if (typeof data.enabled !== "boolean" || !string(data.account) || !string(data.secret)
    || string(data.account).length > 512 || string(data.secret).length > 16384
    || !Array.isArray(data.allowedSenders) || !data.allowedSenders.length
    || data.allowedSenders.length > 100 || data.allowedSenders.some((item) => !string(item) || item.length > 512)
    || (data.initialCursor !== undefined && (typeof data.initialCursor !== "string" || data.initialCursor.length > 16384))) {
    throw new Error("invalid_channel_configuration");
  }
  return { enabled: data.enabled, account: String(data.account), secret: String(data.secret), allowedSenders: data.allowedSenders as string[],
    ...(data.initialCursor === undefined ? {} : { initialCursor: data.initialCursor as string }) };
}
export function weixinMessages(value: unknown, config: ChannelConfig): Incoming[] {
  const rows = object(value).msgs ?? [];
  if (!Array.isArray(rows)) throw new Error("invalid_weixin_batch");
  return rows.flatMap((entry) => {
    const row = object(entry);
    const id = string(row.message_id) || (typeof row.message_id === "number" && Number.isSafeInteger(row.message_id) ? String(row.message_id) : "");
    const sender = string(row.from_user_id);
    if (!id || !sender || !config.allowedSenders.includes(sender) || row.message_type === 2 || row.group_id) return [];
    const items = Array.isArray(row.item_list) ? row.item_list : [];
    const text = items.map((item) => string(object(object(item).text_item).text)).filter(Boolean).join("\n");
    const supported = items.length > 0 && items.every((item) => object(item).type === 1);
    return [{ id, channel: "weixin" as const, account: config.account, sender, chat: sender,
      group: false, text: supported ? text : "/unsupported-media", context: string(row.context_token) }];
  });
}
export function wecomMessage(value: unknown, config: ChannelConfig): Incoming | null {
  const frame = object(value);
  if (frame.cmd !== "aibot_msg_callback") return null;
  const body = object(frame.body);
  const id = string(body.msgid), sender = string(object(body.from).userid);
  const chat = string(body.chatid) || sender;
  if (!id || !sender || !chat || !config.allowedSenders.includes(sender)) return null;
  return { id, channel: "wecom", account: config.account, sender, chat, group: body.chattype === "group" || body.chattype === 2,
    text: body.msgtype === "text" ? string(object(body.text).content) : "/unsupported-media", context: "" };
}
export async function boundedJson(response: Response, limit = 1024 * 1024): Promise<Record<string, unknown>> {
  if (!response.ok) { await response.body?.cancel(); throw new Error("upstream_http_" + response.status); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty_response");
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new Error("response_too_large"); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return object(JSON.parse(new TextDecoder().decode(bytes)));
}
export function assertPlatformSuccess(result: Record<string, unknown>) {
  if (!("ret" in result || "errcode" in result) || (result.ret !== undefined && result.ret !== 0)
      || (result.errcode !== undefined && result.errcode !== 0)) {
    const code = result.ret ?? result.errcode;
    throw new Error("platform_rejected_" + (typeof code === "number" && Number.isSafeInteger(code) ? code : -999999));
  }
}
export const WEIXIN_ORIGIN = "https://ilinkai.weixin.qq.com";
export async function weixinCall(path: string, config: ChannelConfig, body: unknown, timeout = 15000) {
  const uin = crypto.getRandomValues(new Uint32Array(1))[0].toString();
  const result = await boundedJson(await fetch(WEIXIN_ORIGIN + "/ilink/bot/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.secret,
      AuthorizationType: "ilink_bot_token", "X-WECHAT-UIN": btoa(uin), "iLink-App-Id": "bot", "iLink-App-ClientVersion": "132105" },
    body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(timeout),
  }));
  // iLink empty long-poll replies may omit ret/errcode. They still need a valid
  // updates shape; a send acknowledgement must always carry an explicit code.
  if (!(path === "getupdates" && result.ret === undefined && result.errcode === undefined
    && (Array.isArray(result.msgs) || typeof result.get_updates_buf === "string"))) assertPlatformSuccess(result);
  return result;
}
