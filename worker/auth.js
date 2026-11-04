/** Decode the browser-only subprotocol credential without including it in URLs. */
function browserToken(header) {
  const protocols = (header || "").split(",").map((part) => part.trim());
  const entries = protocols.filter((part) => part.startsWith("auth."));
  if (!protocols.includes("cf-muse-v1") || entries.length !== 1) return null;
  const value = entries[0].slice(5);
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) return null;
  try {
    const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(decoded, (char) => char.charCodeAt(0)));
  } catch { return null; }
}

/** Compare fixed-length hashes; never return or log credential bytes. */
async function equalToken(candidate, expected) {
  if (!candidate || !expected || candidate.length > 512 || expected.length < 32) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

/** Authorize one configured room and role, denying conflicting auth mechanisms. */
export async function authorize(request, env) {
  const url = new URL(request.url);
  const match = /^\/ws\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname) ||
    /^\/api\/rooms\/([A-Za-z0-9_-]{1,64})(?:\/.*)?$/.exec(url.pathname);
  const api = url.pathname.startsWith("/api/");
  const role = api ? "user" : url.searchParams.get("role");
  if (!match || match[1] !== env.ROOM_ID || !["user", "muse"].includes(role)) return null;
  const authorization = request.headers.get("Authorization");
  const protocolHeader = request.headers.get("Sec-WebSocket-Protocol");
  if ((authorization && protocolHeader) || (api && (!authorization || protocolHeader))) return null;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) :
    role === "user" ? browserToken(protocolHeader) : null;
  const expected = role === "user" ? env.USER_TOKEN : env.MUSE_TOKEN;
  if (!await equalToken(token, expected)) return null;
  return { role, room: match[1], browser: Boolean(protocolHeader) };
}
