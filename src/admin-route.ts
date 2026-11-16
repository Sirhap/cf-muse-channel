import { AdminInputError, readAdminLogin } from "./admin-input";
import { adminLoginPage, adminPage } from "./admin-page";
import { adminSessionHash, adminSessionRedirect, adminSessionToken, newAdminSessionToken, type AdminSessions } from "./admin-session";
import { authorized, json, matchesKey, validBearerKey } from "./http";

export function isAdminRoute(path: string) {
  return path === "/admin" || path.startsWith("/admin/") || path === "/channel-health" || path === "/cookie-health";
}

export async function handleAdminRoute(request: Request, env: Env, dispatch: (request: Request) => Promise<Response>, sessions?: AdminSessions) {
  const url = new URL(request.url);
  const path = url.pathname;
  const key = env.MUSE_ADMIN_KEY ?? "";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || !validBearerKey(key) || key === env.DEMO_KEY) {
    return json({ error: "not_found" }, 404);
  }
  if (path === "/channel-health" || path === "/cookie-health") {
    if (request.method !== "GET") return json({ error: "not_found" }, 404);
    return dispatch(new Request(url, { method: "GET" }));
  }

  const token = adminSessionToken(request);
  const hash = token ? await adminSessionHash(token, key) : null;
  const signedIn = async () => Boolean(hash && sessions && await sessions.hasAdminSession(hash));
  if (path === "/admin" && request.method === "GET") return adminPage(local, await signedIn());
  if (path === "/admin/login") {
    if (request.method === "GET") return await signedIn() ? adminSessionRedirect("/admin") : adminLoginPage();
    if (request.method !== "POST") return json({ error: "not_found" }, 404);
    if (request.headers.get("Origin") !== url.origin) return json({ error: "origin_not_allowed" }, 403);
    if (!sessions) return adminLoginPage("登录暂时不可用，请稍后再试。", 503);

    let password: string;
    try { password = await readAdminLogin(request); }
    catch (error) {
      return adminLoginPage("无法读取管理密钥，请重新输入。", error instanceof AdminInputError ? error.status : 400);
    }
    if (!(await matchesKey(password, key))) return adminLoginPage("管理密钥不正确。", 401);
    const newToken = newAdminSessionToken();
    await sessions.startAdminSession(await adminSessionHash(newToken, key));
    if (hash) await sessions.endAdminSession(hash);
    return adminSessionRedirect("/admin", newToken);
  }

  if (path === "/admin/logout" && request.method === "POST") {
    if (request.headers.get("Origin") !== url.origin) return json({ error: "origin_not_allowed" }, 403);
    if (hash && sessions) await sessions.endAdminSession(hash);
    return adminSessionRedirect("/admin/login", "");
  }

  const allowed = request.method === "GET" && path === "/admin/channels"
    || request.method === "POST" && path === "/admin/current-cookie"
    || ["GET", "POST"].includes(request.method) && path === "/admin/cookie";
  if (!allowed) return json({ error: "not_found" }, 404);
  if (!(await authorized(request, key)) && !(await signedIn())) return json({ error: "unauthorized" }, 401);
  if (request.method === "POST" && request.headers.get("Origin") !== url.origin) return json({ error: "origin_not_allowed" }, 403);
  const forwarded = new Request(request);
  forwarded.headers.delete("Authorization");
  forwarded.headers.delete("Cookie");
  return dispatch(forwarded);
}
