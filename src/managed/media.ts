import type { MuseRpc } from "../noise";
import { aes128EcbDecrypt, aes128EcbEncrypt, aes256CbcDecrypt, base64ToBytes, bytesToBase64, bytesToHex, hexToBytes, md5Hex } from "./crypto";
import { string, weixinCall, type ChannelConfig } from "./protocol";

export { aes128EcbDecrypt, aes128EcbEncrypt, aes256CbcDecrypt, base64ToBytes, bytesToBase64, bytesToHex, hexToBytes, md5Hex };

export const MAX_MEDIA_BYTES = 6 * 1024 * 1024; // 6 MiB：兼顾图片/文档/小视频与 CF Workers 128MB 内存上限
const WEIXIN_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const SANDBOX_WRITE_CHUNK = 512 * 1024;
const SANDBOX_READ_CHUNK = 512 * 1024;
const WECOM_UPLOAD_CHUNK = 512 * 1024;

export interface InboundMedia {
  kind: "image" | "file" | "video";
  channel: "weixin" | "wecom";
  url: string;
  aesKey: string;
  /** 微信 image_item.aeskey 为 32 位十六进制；其余为 base64。 */
  aesKeyHex?: boolean;
  fileName?: string;
}

/** 仅允许官方微信/企业微信媒体域名，防止 SSRF 与重定向泄密。 */
export function isAllowedTencentMediaUrl(raw: string): boolean {
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { return false; }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  if (host === "weixin.qq.com" || host === "qq.com" || host.endsWith(".weixin.qq.com") || host.endsWith(".qq.com")) {
    return true;
  }
  const firstLabel = host.split(".", 1)[0];
  return firstLabel.startsWith("ww-aibot-") && host.includes(".cos.") && host.endsWith(".myqcloud.com");
}

export function weixinDownloadUrl(fullUrl: string, encryptQueryParam: string): string {
  if (fullUrl) return fullUrl;
  if (!encryptQueryParam) return "";
  return `${WEIXIN_CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

/** 解析微信 CDN 16 字节 AES-128 密钥（支持 32 位 hex、base64(16B) 或 base64(32位hex)）。 */
export function parseWeixinAesKey(raw: string, isHex = false): Uint8Array {
  if (isHex) {
    const key = hexToBytes(raw.trim());
    if (key.length !== 16) throw new Error("invalid_weixin_aes_key");
    return key;
  }
  const decoded = base64ToBytes(raw.trim());
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const asText = new TextDecoder().decode(decoded);
    if (/^[0-9a-fA-F]{32}$/.test(asText)) return hexToBytes(asText);
  }
  throw new Error("unsupported_weixin_aes_key");
}

export function sniffExtension(bytes: Uint8Array, fallbackName = ""): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 6 && (new TextDecoder().decode(bytes.subarray(0, 6)) === "GIF87a" || new TextDecoder().decode(bytes.subarray(0, 6)) === "GIF89a")) return "gif";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP") return "webp";
  if (bytes.length >= 4 && new TextDecoder().decode(bytes.subarray(0, 4)) === "%PDF") return "pdf";
  if (bytes.length >= 8 && new TextDecoder().decode(bytes.subarray(4, 8)) === "ftyp") return "mp4";
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return "zip";
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(fallbackName.trim());
  return match ? match[1].toLowerCase() : "bin";
}

export function mediaCategoryForPath(path: string): "image" | "video" | "file" {
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(path.trim())?.[1] ?? "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) return "image";
  if (["mp4", "mov", "webm", "m4v"].includes(ext)) return "video";
  return "file";
}

/** 仅允许读取 workspace/ 下的安全路径，拒绝路径穿越与凭证目录。 */
export function normalizeAllowedSandboxPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  let rel = trimmed;
  if (rel.startsWith("sandbox://")) rel = rel.slice("sandbox://".length);
  if (rel.startsWith("/home/hatch/workspace/")) rel = rel.slice("/home/hatch/".length);
  else if (rel.startsWith("~/workspace/")) rel = rel.slice("~/".length);
  else if (rel.startsWith("/workspace/")) rel = rel.slice(1);
  if (!rel.startsWith("workspace/")) return null;
  const parts = rel.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "workspace") return null;
  for (const part of parts) {
    if (part === "." || part === ".." || part.startsWith(".ssh")) return null;
  }
  const lower = parts.join("/").toLowerCase();
  if (/(credentials\.env|cookie|secret|token\.json|\.pem$|\.key$)/.test(lower)) return null;
  return parts.join("/");
}

/** 从 Muse 回复正文中提取独占一行的 [[FILE:/path]] 标记，返回清洗后的正文与安全路径列表。 */
export function extractOutboundFiles(text: string): { text: string; files: string[] } {
  const kept: string[] = [];
  const files: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*\[\[FILE:([^\]]+)\]\]\s*$/.exec(line);
    if (match) {
      const safe = normalizeAllowedSandboxPath(match[1]);
      if (safe && files.length < 6) files.push(safe);
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), files };
}

/** 有界下载腾讯媒体密文（绝不跟随跨站重定向，超限立即中断）。 */
export async function downloadBounded(url: string, maxBytes = MAX_MEDIA_BYTES, timeout = 30_000): Promise<Uint8Array> {
  if (!isAllowedTencentMediaUrl(url)) throw new Error("media_url_not_allowed");
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("media_download_http_" + response.status);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new Error("media_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("media_empty_body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("media_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** 将解密后的入站媒体分片写入 Muse 沙箱（POST /fs/write，单块 <= 512KB，绝不触碰 2MB RPC 上限）。 */
export async function writeSandboxFile(
  rpc: <T>(operation: (client: MuseRpc) => Promise<T>) => Promise<T>,
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  if (!bytes.length) {
    await rpc((client) => client.call("/fs/write", 0, "POST", {
      path: relativePath, data_base64: "", overwrite: true, append: false, create_parent: true,
    }, 20_000));
    return;
  }
  for (let offset = 0; offset < bytes.length; offset += SANDBOX_WRITE_CHUNK) {
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + SANDBOX_WRITE_CHUNK));
    const first = offset === 0;
    await rpc((client) => client.call("/fs/write", 0, "POST", {
      path: relativePath,
      data_base64: bytesToBase64(slice),
      overwrite: first,
      append: !first,
      create_parent: first,
    }, 30_000));
  }
}

/** 通过 /fs/stat + HTTP Range 206 分段从 Muse 沙箱拉取待外发文件（严格校验路径与 6 MiB 上限）。 */
export async function readSandboxFile(
  rpc: <T>(operation: (client: MuseRpc) => Promise<T>) => Promise<T>,
  relativePath: string,
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const safe = normalizeAllowedSandboxPath(relativePath);
  if (!safe) throw new Error("outbound_file_not_allowed");
  const stat = await rpc((client) => client.call("/fs/stat", 0, "POST", { path: safe }, 15_000)) as Record<string, unknown>;
  if (stat.kind !== "file") throw new Error("outbound_file_not_found");
  const size = typeof stat.size === "number" && Number.isSafeInteger(stat.size) ? stat.size : -1;
  if (size <= 0) throw new Error("outbound_file_empty");
  if (size > MAX_MEDIA_BYTES) throw new Error("media_too_large");

  const out = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const end = Math.min(size - 1, offset + SANDBOX_READ_CHUNK - 1);
    const result = await rpc((client) => client.raw(
      "/media/raw/" + safe, 0, "GET", { range: `bytes=${offset}-${end}` }, 30_000, SANDBOX_READ_CHUNK + 4096,
    ));
    if (result.status !== 206 && result.status !== 200) throw new Error("sandbox_read_failed_" + result.status);
    if (!result.body.length) break;
    const copyLen = Math.min(result.body.length, size - offset);
    out.set(result.body.subarray(0, copyLen), offset);
    offset += copyLen;
  }
  if (offset !== size) throw new Error("sandbox_read_incomplete");
  const fileName = safe.split("/").pop() || "attachment.bin";
  return { bytes: out, fileName };
}

/** 微信出站媒体：AES-128-ECB 加密 → getuploadurl → 上传 CDN → 返回 sendmessage item。 */
export async function uploadWeixinMedia(
  config: ChannelConfig,
  toUserId: string,
  bytes: Uint8Array,
  fileName: string,
): Promise<Record<string, unknown>> {
  const category = mediaCategoryForPath(fileName);
  const mediaType = category === "image" ? 1 : category === "video" ? 2 : 3;
  const filekey = crypto.randomUUID().replace(/-/g, "");
  const aesKey = crypto.getRandomValues(new Uint8Array(16));
  const aesKeyHex = bytesToHex(aesKey);
  const cipher = aes128EcbEncrypt(bytes, aesKey);

  const resp = await weixinCall("getuploadurl", config, {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize: bytes.length,
    rawfilemd5: md5Hex(bytes),
    filesize: cipher.length,
    no_need_thumb: true,
    aeskey: aesKeyHex,
    base_info: { channel_version: "2.4.9", bot_agent: "Muse/1.0" },
  }, 15_000);

  let uploadUrl = string(resp.upload_full_url).trim();
  const uploadParam = string(resp.upload_param).trim();
  if (!uploadUrl && uploadParam) {
    uploadUrl = `${WEIXIN_CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${filekey}`;
  }
  if (!uploadUrl || !isAllowedTencentMediaUrl(uploadUrl)) throw new Error("weixin_upload_url_invalid");

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Uint8Array.from(cipher),
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
  await uploadRes.body?.cancel();
  if (!uploadRes.ok) throw new Error("weixin_cdn_upload_" + uploadRes.status);
  const downloadParam = uploadRes.headers.get("x-encrypted-param") ?? "";
  if (!downloadParam) throw new Error("weixin_cdn_missing_param");

  const media = {
    encrypt_query_param: downloadParam,
    aes_key: bytesToBase64(new TextEncoder().encode(aesKeyHex)),
    encrypt_type: 1,
  };
  if (category === "image") return { type: 2, image_item: { media, mid_size: cipher.length } };
  if (category === "video") return { type: 5, video_item: { media, video_size: cipher.length } };
  return { type: 4, file_item: { media, file_name: fileName, len: String(bytes.length) } };
}

/** 企业微信出站媒体：init → 512KB base64 chunk → finish，返回 media_id 与 msgtype。 */
export async function uploadWecomMedia(
  sendFrame: (frame: Record<string, unknown>) => Promise<Record<string, unknown>>,
  bytes: Uint8Array,
  fileName: string,
): Promise<{ mediaId: string; msgType: "image" | "video" | "file" }> {
  const msgType = mediaCategoryForPath(fileName);
  const totalChunks = Math.max(1, Math.ceil(bytes.length / WECOM_UPLOAD_CHUNK));
  const initResp = await sendFrame({
    cmd: "aibot_upload_media_init",
    headers: { req_id: "cf-upinit-" + crypto.randomUUID() },
    body: {
      type: msgType,
      filename: fileName,
      total_size: bytes.length,
      total_chunks: totalChunks,
      md5: md5Hex(bytes),
    },
  });
  if (initResp.errcode !== 0) throw new Error("wecom_upload_init_" + String(initResp.errcode ?? "err"));
  const uploadId = string((initResp.body as Record<string, unknown> | undefined)?.upload_id);
  if (!uploadId) throw new Error("wecom_upload_missing_id");

  for (let idx = 0; idx < totalChunks; idx++) {
    const slice = bytes.subarray(idx * WECOM_UPLOAD_CHUNK, Math.min(bytes.length, (idx + 1) * WECOM_UPLOAD_CHUNK));
    const chunkResp = await sendFrame({
      cmd: "aibot_upload_media_chunk",
      headers: { req_id: "cf-upchunk-" + crypto.randomUUID() },
      body: {
        upload_id: uploadId,
        chunk_index: idx,
        base64_data: bytesToBase64(slice),
      },
    });
    if (chunkResp.errcode !== 0) throw new Error("wecom_upload_chunk_" + String(chunkResp.errcode ?? "err"));
  }

  const finishResp = await sendFrame({
    cmd: "aibot_upload_media_finish",
    headers: { req_id: "cf-upfin-" + crypto.randomUUID() },
    body: { upload_id: uploadId },
  });
  if (finishResp.errcode !== 0) throw new Error("wecom_upload_finish_" + String(finishResp.errcode ?? "err"));
  const mediaId = string((finishResp.body as Record<string, unknown> | undefined)?.media_id);
  if (!mediaId) throw new Error("wecom_upload_missing_media_id");
  return { mediaId, msgType };
}

/** 下载并解密一条入站媒体（微信 AES-128-ECB / 企微 AES-256-CBC）。 */
export async function downloadAndDecryptInbound(media: InboundMedia): Promise<{ bytes: Uint8Array; ext: string }> {
  const cipher = await downloadBounded(media.url, MAX_MEDIA_BYTES + 64, 30_000);
  const plain = media.channel === "weixin"
    ? aes128EcbDecrypt(cipher, parseWeixinAesKey(media.aesKey, Boolean(media.aesKeyHex)))
    : await aes256CbcDecrypt(cipher, media.aesKey);
  if (plain.length > MAX_MEDIA_BYTES) throw new Error("media_too_large");
  return { bytes: plain, ext: sniffExtension(plain, media.fileName ?? "") };
}
