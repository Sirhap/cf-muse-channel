import { weixinDownloadUrl, type InboundMedia } from "./media";

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
  media?: InboundMedia[];
}
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string { return typeof value === "string" ? value : ""; }
/** Persist only our bounded error codes, never upstream messages or credentials. */
export function failureCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  return /^(upstream_http_\d{3}|platform_rejected_-?\d+|wecom_upgrade_failed_\d{3}|wecom_not_connected|platform_response_unknown|platform_connection_lost|platform_send_unknown|configuration_changed|invalid_weixin_batch|response_too_large|empty_response|muse_owner_(unresolved|mismatch)|muse_account_(unavailable|unconfigured)|muse_connect_failed|muse_connection_replaced)$/.test(error.message)
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
    const parts: string[] = [];
    const media: InboundMedia[] = [];
    let hasVoice = false;
    let hasUnsupported = false;

    for (const rawItem of items) {
      const item = object(rawItem);
      const kind = item.type;
      if (kind === 1) {
        const t = string(object(item.text_item).text).trim();
        if (t) parts.push(t);
      } else if (kind === 3) {
        hasVoice = true;
        const vt = string(object(item.voice_item).text).trim();
        if (vt) parts.push(vt);
      } else if (kind === 2 || kind === 4 || kind === 5) {
        const nodeKey = kind === 2 ? "image_item" : kind === 4 ? "file_item" : "video_item";
        const mediaKind = kind === 2 ? "image" : kind === 4 ? "file" : "video";
        const sub = object(item[nodeKey]);
        const mediaNode = object(sub.media ?? sub.hd_media ?? sub.mid_media ?? sub.thumb_media);
        const rawFullUrl = string(mediaNode.full_url) || string(sub.url) || string(sub.mid_url);
        const url = weixinDownloadUrl(rawFullUrl, string(mediaNode.encrypt_query_param));
        const hexKey = string(sub.aeskey).trim();
        const b64Key = string(mediaNode.aes_key).trim() || string(sub.aes_key).trim();
        if (url && (hexKey || b64Key)) {
          media.push({
            kind: mediaKind,
            channel: "weixin",
            url,
            aesKey: hexKey || b64Key,
            aesKeyHex: Boolean(hexKey),
            fileName: string(sub.file_name) || undefined,
          });
        } else {
          hasUnsupported = true;
        }
      } else {
        hasUnsupported = true;
      }
    }

    let text = parts.join("\n").trim();
    if (!text && !media.length) {
      if (hasVoice && !hasUnsupported) text = "/voice-empty";
      else text = "/unsupported-media";
    } else if (!text && media.length) {
      const labels = media.map((m) => m.kind === "image" ? "[图片]" : m.kind === "video" ? "[视频]" : `[文件${m.fileName ? " " + m.fileName : ""}]`);
      text = labels.join(" ");
    }
    return [{
      id,
      channel: "weixin" as const,
      account: config.account,
      sender,
      chat: sender,
      group: false,
      text,
      context: string(row.context_token),
      ...(media.length ? { media } : {}),
    }];
  });
}
export function wecomMessage(value: unknown, config: ChannelConfig): Incoming | null {
  const frame = object(value);
  if (frame.cmd !== "aibot_msg_callback") return null;
  const body = object(frame.body);
  const id = string(body.msgid), sender = string(object(body.from).userid);
  const chat = string(body.chatid) || sender;
  if (!id || !sender || !chat || !config.allowedSenders.includes(sender)) return null;

  const msgtype = string(body.msgtype);
  const parts: string[] = [];
  const media: InboundMedia[] = [];
  const collectMedia = (kind: "image" | "file" | "video", rawNode: unknown) => {
    const node = object(rawNode);
    const url = string(node.url).trim();
    const aesKey = string(node.aeskey).trim();
    if (url && aesKey) {
      media.push({ kind, channel: "wecom", url, aesKey, fileName: string(node.filename || node.file_name) || undefined });
      return true;
    }
    return false;
  };

  if (msgtype === "mixed") {
    const msgItems = Array.isArray(object(body.mixed).msg_item) ? object(body.mixed).msg_item as unknown[] : [];
    for (const rawItem of msgItems) {
      const item = object(rawItem);
      const itype = string(item.msgtype);
      if (itype === "text") {
        const t = string(object(item.text).content).trim();
        if (t) parts.push(t);
      } else if (itype === "image") {
        collectMedia("image", item.image);
      } else if (itype === "video") {
        collectMedia("video", item.video);
      } else if (itype === "file") {
        collectMedia("file", item.file);
      }
    }
  } else if (msgtype === "text") {
    const t = string(object(body.text).content);
    if (t) parts.push(t);
  } else if (msgtype === "voice") {
    const vt = string(object(body.voice).content).trim();
    if (vt) parts.push(vt);
  } else if (msgtype === "image") {
    collectMedia("image", body.image);
  } else if (msgtype === "file") {
    collectMedia("file", body.file);
  } else if (msgtype === "video") {
    collectMedia("video", body.video);
  }

  let text = parts.join("\n").trim();
  if (!text && !media.length) {
    text = msgtype === "voice" ? "/voice-empty" : "/unsupported-media";
  } else if (!text && media.length) {
    text = media.map((m) => m.kind === "image" ? "[图片]" : m.kind === "video" ? "[视频]" : `[文件${m.fileName ? " " + m.fileName : ""}]`).join(" ");
  }

  return {
    id,
    channel: "wecom",
    account: config.account,
    sender,
    chat,
    group: body.chattype === "group" || body.chattype === 2,
    text,
    context: "",
    ...(media.length ? { media } : {}),
  };
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
  // Tencent message IDs are 64-bit JSON integers. The reviver's original source
  // preserves them before Number rounding can corrupt routing and deduplication.
  return object(JSON.parse(new TextDecoder().decode(bytes), (_key, value: unknown, context?: { source?: string }) => {
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context?.source || !/^-?\d+$/.test(context.source)) throw new Error("unsafe_json_integer");
      return context.source;
    }
    return value;
  }));
}
export function assertPlatformSuccess(result: Record<string, unknown>) {
  if (!("ret" in result || "errcode" in result) || (result.ret !== undefined && result.ret !== 0)
      || (result.errcode !== undefined && result.errcode !== 0)) {
    const code = result.ret ?? result.errcode;
    throw new Error("platform_rejected_" + (typeof code === "number" && Number.isSafeInteger(code) ? code : -999999));
  }
}
export const WEIXIN_ORIGIN = "https://ilinkai.weixin.qq.com";
export async function weixinCall(path: string, config: ChannelConfig, body: unknown, timeout = 15000, signal?: AbortSignal) {
  const uin = crypto.getRandomValues(new Uint32Array(1))[0].toString();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("iLink request timed out", "TimeoutError")), timeout);
  let result: Record<string, unknown>;
  try {
    result = await boundedJson(await fetch(WEIXIN_ORIGIN + "/ilink/bot/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.secret,
        AuthorizationType: "ilink_bot_token", "X-WECHAT-UIN": btoa(uin), "iLink-App-Id": "bot", "iLink-App-ClientVersion": "132105" },
      body: JSON.stringify(body), redirect: "manual",
      signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
    }));
  } finally {
    clearTimeout(timer);
  }
  // iLink empty long-poll replies may omit ret/errcode. They still need a valid
  // updates shape. Successful sends can omit zero and return only message_id.
  const implicitSuccess = result.ret === undefined && result.errcode === undefined
    && ((path === "getupdates" && (Array.isArray(result.msgs) || typeof result.get_updates_buf === "string"))
      || (path === "getuploadurl" && (typeof result.upload_full_url === "string" || typeof result.upload_param === "string"))
      || (path === "sendmessage" && Object.keys(result).every((key) => ["message_id", "errmsg"].includes(key))
        && (result.errmsg === undefined || result.errmsg === "")
        && (result.message_id === undefined || typeof result.message_id === "string" && /^\d+$/.test(result.message_id)
          || typeof result.message_id === "number" && Number.isSafeInteger(result.message_id) && result.message_id > 0)));
  if (!implicitSuccess) assertPlatformSuccess(result);
  return result;
}
