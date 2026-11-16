import { initialCookies, type CookieJar } from "./cookies";

export const MAX_COOKIE_LENGTH = 16_384;
const MAX_BODY_BYTES = MAX_COOKIE_LENGTH * 2 + 128;
const COOKIE_PAIR = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*"|[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*)$/;

export class AdminInputError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

/** Parse only a request Cookie header; bound the stream before decoding JSON. */
export async function readCookieInput(request: Request): Promise<CookieJar> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new AdminInputError("json_required", 415);
  }
  if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) throw new AdminInputError("cookie_too_large", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AdminInputError("invalid_cookie", 400);
  const buffer = new Uint8Array(MAX_BODY_BYTES);
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > buffer.byteLength) {
        await reader.cancel();
        throw new AdminInputError("cookie_too_large", 413);
      }
      buffer.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buffer.subarray(0, size)));
    if (!payload || typeof payload !== "object" || !("cookie" in payload) || typeof payload.cookie !== "string") {
      throw new AdminInputError("invalid_cookie", 400);
    }
    const header = payload.cookie.trim().replace(/^cookie:[ \t]*/i, "").trim();
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
  } finally { reader.releaseLock(); }
}
