export const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
const SESSION_NAME = "__Host-muse-admin";
const SESSION_ID = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

export interface AdminSessions {
  startAdminSession(hash: string): void | Promise<void>;
  hasAdminSession(hash: string): boolean | Promise<boolean>;
  endAdminSession(hash: string): void | Promise<void>;
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newAdminSessionToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function adminSessionHash(token: string, key: string) {
  // Binding the hash to the management key invalidates existing sessions on key rotation.
  const input = encoder.encode("muse-admin-session:" + key + ":" + token);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", input)));
}

export function adminSessionToken(request: Request) {
  for (const pair of (request.headers.get("Cookie") ?? "").split(";")) {
    const [name, token] = pair.trim().split("=", 2);
    if (name === SESSION_NAME && SESSION_ID.test(token ?? "")) return token;
  }
  return null;
}

export function adminSessionRedirect(path: "/admin" | "/admin/login", token?: string) {
  const headers = new Headers({ "Cache-Control": "no-store", Location: path });
  if (token !== undefined) {
    headers.set("Set-Cookie", SESSION_NAME + "=" + token
      + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + (token ? ADMIN_SESSION_SECONDS : 0));
  }
  return new Response(null, { status: 303, headers });
}
