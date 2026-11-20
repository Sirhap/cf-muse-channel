import { initialCookies, type CookieJar } from "./cookies";

export const MAX_COOKIE_LENGTH = 16_384;
const MAX_BODY_BYTES = MAX_COOKIE_LENGTH * 4 + 1024;
const COOKIE_PAIR = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*"|[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*)$/;

export class AdminInputError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

function mediaType(request: Request) {
  return request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
}

async function readBoundedBody(request: Request, maximum: number, tooLarge: string): Promise<string> {
  if (Number(request.headers.get("Content-Length")) > maximum) throw new AdminInputError(tooLarge, 413);
  const reader = request.body?.getReader();
  if (!reader) return "";
  const buffer = new Uint8Array(maximum);
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > buffer.byteLength) {
        await reader.cancel();
        throw new AdminInputError(tooLarge, 413);
      }
      buffer.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buffer.subarray(0, size));
  } finally { reader.releaseLock(); }
}

export async function readAdminLogin(request: Request): Promise<string> {
  if (mediaType(request) !== "application/x-www-form-urlencoded") throw new AdminInputError("form_required", 415);
  const body = await readBoundedBody(request, 2048, "login_too_large");
  return new URLSearchParams(body).get("password")?.trim() ?? "";
}

/** 从 JSON 对象或数组中提取单行 Cookie 请求头，支持直接粘贴浏览器扩展导出的 JSON。 */
function extractCookieHeader(value: unknown, depth = 0): string | null {
  if (depth > 2 || !value) return null;
  if (Array.isArray(value)) {
    const byName = new Map<string, { value: string; root: boolean }>();
    for (const item of value) {
      if (!item || typeof item !== "object") return null;
      const rec = item as Record<string, unknown>;
      if (typeof rec.name !== "string" || typeof rec.value !== "string") return null;
      const name = rec.name.trim();
      if (!name || !rec.value) continue;
      const root = rec.path === "/" || rec.path === undefined;
      const prev = byName.get(name);
      if (!prev || (root && !prev.root)) byName.set(name, { value: rec.value, root });
    }
    return byName.size ? Array.from(byName.entries()).map(([k, v]) => `${k}=${v.value}`).join("; ") : null;
  }
  if (typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.cookie === "string") {
    const raw = obj.cookie.trim();
    if (raw.startsWith("{") || raw.startsWith("[")) {
      return extractCookieHeader(JSON.parse(raw), depth + 1);
    }
    return raw;
  }
  if (obj.cookies && typeof obj.cookies === "object" && !Array.isArray(obj.cookies)) {
    const entries = Object.entries(obj.cookies as Record<string, unknown>).filter(([, v]) => typeof v === "string" && v !== "");
    if (!entries.length) return null;
    return entries.map(([k, v]) => `${k}=${v as string}`).join("; ");
  }
  const items = Array.isArray(obj.items) ? obj.items : Array.isArray(obj.cookie_items) ? obj.cookie_items : null;
  if (items) return extractCookieHeader(items, depth + 1);
  return null;
}

/** Parse a request Cookie header or extension Cookie JSON; bound the stream before decoding JSON. */
export async function readCookieInput(request: Request): Promise<CookieJar> {
  if (mediaType(request) !== "application/json") throw new AdminInputError("json_required", 415);
  try {
    const payload: unknown = JSON.parse(await readBoundedBody(request, MAX_BODY_BYTES, "cookie_too_large"));
    const extracted = extractCookieHeader(payload);
    if (typeof extracted !== "string") {
      throw new AdminInputError("invalid_cookie", 400);
    }
    const header = extracted.trim().replace(/^cookie:[ \t]*/i, "").trim();
    if (header.length > MAX_COOKIE_LENGTH) throw new AdminInputError("cookie_too_large", 413);
    const pairs = header.split(";").map((pair) => pair.trim());
    if (pairs.at(-1) === "") pairs.pop();
    if (!pairs.length || /[^\x20-\x7e]/.test(header) || !pairs.every((pair) => COOKIE_PAIR.test(pair))) {
      throw new AdminInputError("invalid_cookie", 400);
    }
    const cookies = initialCookies(pairs.join(";"));
    if (Object.keys(cookies).length !== pairs.length || !Object.values(cookies).some(({ value }) => value !== "")) {
      throw new AdminInputError("invalid_cookie", 400);
    }
    return cookies;
  } catch (error) {
    if (error instanceof AdminInputError) throw error;
    throw new AdminInputError("invalid_cookie", 400);
  }
}
