import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import { adminSessionHash, ADMIN_SESSION_SECONDS } from "../src/admin-session";

const origin = "https://login.test";
const key = "a-strong-management-key-for-login-tests";
const bindings = { ...env, MUSE_ADMIN_KEY: key };

function login(password: string, source = origin) {
  return new Request(origin + "/admin/login", {
    method: "POST",
    headers: { Origin: source, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }),
  });
}

describe("administrator login sessions", () => {
  it("uses a separate login page and rejects wrong keys, cross-site submissions, and oversized bodies", async () => {
    const sessions = { startAdminSession: vi.fn(), hasAdminSession: vi.fn(), endAdminSession: vi.fn() };
    const dispatch = vi.fn();
    const page = await handleRequest(new Request(origin + "/admin/login"), bindings, dispatch, sessions);
    const html = await page.text();
    expect(html).toContain('action="/admin/login"');
    expect(html).not.toContain(key);
    expect(page.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
    expect((await handleRequest(login("wrong"), bindings, dispatch, sessions)).status).toBe(401);
    expect((await handleRequest(login(key, "https://other.test"), bindings, dispatch, sessions)).status).toBe(403);
    expect((await handleRequest(login("x".repeat(3000)), bindings, dispatch, sessions)).status).toBe(413);
    expect(sessions.startAdminSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("persists hashed sessions, authenticates management, and revokes the token on logout and key rotation", async () => {
    const stub = env.CREDENTIALS.getByName("admin-login-lifecycle");
    await runInDurableObject(stub, async (instance, state) => {
      const dispatch = vi.fn(async (request: Request) => {
        expect(request.headers.has("Cookie")).toBe(false);
        return Response.json({ fixture: true });
      });
      const signedIn = await handleRequest(login(key), bindings, dispatch, instance);
      expect(signedIn.status).toBe(303);
      expect(signedIn.headers.get("Location")).toBe("/admin");
      const cookie = signedIn.headers.get("Set-Cookie")!;
      expect(cookie).toContain("HttpOnly; Secure; SameSite=Strict");
      expect(cookie).toContain("Max-Age=" + ADMIN_SESSION_SECONDS);
      const credential = cookie.split(";")[0];
      const token = credential.split("=")[1];
      const rows = state.storage.sql.exec<{ hash: string }>("SELECT hash FROM admin_sessions").toArray();
      expect(rows[0].hash).toBe(await adminSessionHash(token, key));
      expect(rows[0].hash).not.toBe(token);
      const request = (path: string, method = "GET", source = origin) => new Request(origin + path, {
        method, headers: { Cookie: credential, Origin: source },
      });
      const admin = await handleRequest(request("/admin"), bindings, dispatch, instance);
      const html = await admin.text();
      expect(html).toContain('data-authenticated="true"');
      expect(html).toContain("退出登录");
      expect(html).not.toContain('id="key"');
      expect((await handleRequest(request("/admin/login"), bindings, dispatch, instance)).status).toBe(303);
      expect((await handleRequest(request("/admin/current-cookie", "POST"), bindings, dispatch, instance)).status).toBe(200);
      expect((await handleRequest(request("/admin/current-cookie", "POST", "https://other.test"), bindings, dispatch, instance)).status).toBe(403);
      expect((await handleRequest(request("/admin/cookie"), { ...bindings, MUSE_ADMIN_KEY: key + "-changed" }, dispatch, instance)).status).toBe(401);

      const out = await handleRequest(request("/admin/logout", "POST"), bindings, dispatch, instance);
      expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");
      expect((await handleRequest(request("/admin/cookie"), bindings, dispatch, instance)).status).toBe(401);
      expect(state.storage.sql.exec("SELECT hash FROM admin_sessions").toArray()).toHaveLength(0);
    });
  });

  it("expires stored sessions and leaves a public overview after logout", async () => {
    const stub = env.CREDENTIALS.getByName("admin-login-expiration");
    await runInDurableObject(stub, async (instance, state) => {
      const token = "a".repeat(64);
      const hash = await adminSessionHash(token, key);
      await instance.startAdminSession(hash);
      state.storage.sql.exec("UPDATE admin_sessions SET expires_at=?", Date.now() - 1);
      const response = await handleRequest(new Request(origin + "/admin/cookie", {
        headers: { Cookie: "__Host-muse-admin=" + token },
      }), bindings, vi.fn(), instance);
      expect(response.status).toBe(401);
      const page = await handleRequest(new Request(origin + "/admin"), bindings, vi.fn(), instance);
      const html = await page.text();
      expect(html).toContain("登录管理");
      expect(html).toContain("fieldset disabled");
    });
  });
});
