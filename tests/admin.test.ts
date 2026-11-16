import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCookieInput } from "../src/admin-input";
import { handleRequest } from "../src/index";
import { MuseRpc } from "../src/noise";

const origin = "https://demo.test";
const adminKey = "test-admin-key-separate-from-the-channel-key";
const bindings = { ...env, MUSE_ADMIN_KEY: adminKey };

function request(cookie: string, key = adminKey, suppliedOrigin = origin) {
  return new Request(origin + "/admin/cookie", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, Origin: suppliedOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ cookie }),
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Worker Cookie management", () => {
  it("hides the page when unconfigured and never accepts the channel key for an admin operation", async () => {
    const dispatch = vi.fn();
    const page = new Request(origin + "/admin");
    expect((await handleRequest(page, { ...bindings, MUSE_ADMIN_KEY: "" }, dispatch)).status).toBe(404);
    expect((await handleRequest(page, { ...bindings, MUSE_ADMIN_KEY: bindings.DEMO_KEY }, dispatch)).status).toBe(404);
    expect((await handleRequest(request("hatch_sess=candidate", bindings.DEMO_KEY), bindings, dispatch)).status).toBe(401);
    expect((await handleRequest(request("hatch_sess=candidate", adminKey, "https://other.test"), bindings, dispatch)).status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();

    const html = await handleRequest(page, bindings, dispatch);
    expect(html.headers.get("Cache-Control")).toBe("no-store");
    expect(html.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(await html.text()).not.toContain(adminKey);
  });

  it("bounds and validates Cookie input without accepting a forged Cookie header line", async () => {
    await expect(readCookieInput(request("Cookie: token=a=b; flags=123;"))).resolves.toMatchObject({
      token: { value: "a=b" }, flags: { value: "123" },
    });
    for (const malformed of ["abc", "a=1; a=2", "a=1\r\nX-Test: fail", "a=", "a=1; invalid"]) {
      await expect(readCookieInput(request(malformed))).rejects.toMatchObject({ status: 400 });
    }
    await expect(readCookieInput(request("a=" + "b".repeat(40_000)))).rejects.toMatchObject({ status: 413 });
  });

  it("shows the persisted daily Cron and approval state only after admin authentication", async () => {
    const stub = env.CREDENTIALS.getByName("admin-dashboard-stored-status");
    await runInDurableObject(stub, async (instance) => {
      const fetcher = vi.fn(async () => Response.json({ access_token: "fixture-only" }));
      vi.stubGlobal("fetch", fetcher);
      await instance.scheduledRenewal(1794776058075, "54 20 * * *");
      const dispatch = vi.fn((forwarded: Request) => instance.fetch(forwarded));
      const endpoint = origin + "/admin/cookie";
      expect((await handleRequest(new Request(endpoint), bindings, dispatch)).status).toBe(401);
      expect(dispatch).not.toHaveBeenCalled();
      const response = await handleRequest(new Request(endpoint, {
        headers: { Authorization: "Bearer " + adminKey },
      }), bindings, dispatch);
      const payload = await response.json();
      expect(payload).toMatchObject({
        configured: true, ok: true,
        renewal: {
          daily_cron_utc: "54 20 * * *",
          last_event: { source: "cloudflare_scheduled", scheduled_time: 1794776058075, result: { ok: true } },
        },
        approval: { enabled: false, last_event: null },
      });
      expect(JSON.stringify(payload)).not.toContain("fixture-only");
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the old row byte for byte when candidate authentication or Noise validation fails", async () => {
    const stub = env.CREDENTIALS.getByName("admin-preserves-active-row");
    await runInDurableObject(stub, async (instance, state) => {
      const row = () => state.storage.sql.exec<{ value: string }>("SELECT value FROM credential_state WHERE id=1").one().value;
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "fixture" })));
      await instance.refresh();
      const before = row();

      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
      const denied = await instance.fetch(request("hatch_sess=private-candidate"));
      expect(denied.status).toBe(502);
      expect(await denied.text()).not.toContain("private-candidate");
      expect(row()).toBe(before);

      const [, server] = Object.values(new WebSocketPair());
      vi.stubGlobal("fetch", mockUpstream(server));
      vi.spyOn(MuseRpc, "connect").mockRejectedValue(new Error("secret exception"));
      const unavailable = await instance.fetch(request("hatch_sess=private-candidate"));
      expect(await unavailable.json()).toMatchObject({ ok: false, last_error: { stage: "noise_rpc" } });
      expect(row()).toBe(before);
    });
  });

  it("publishes only the verified jar, then scheduled renewal uses that same replacement", async () => {
    const stub = env.CREDENTIALS.getByName("admin-publishes-verified-jar");
    await runInDurableObject(stub, async (instance, state) => {
      const [, server] = Object.values(new WebSocketPair());
      const fetcher = mockUpstream(server, {
        "Set-Cookie": "hatch_sess=rotated-candidate; Path=/; Max-Age=3600",
      });
      vi.stubGlobal("fetch", fetcher);
      const call = vi.fn(async () => ({ sessions: [] }));
      const close = vi.fn();
      vi.spyOn(MuseRpc, "connect").mockImplementation(async (socket) => {
        socket.accept();
        return { call, close: () => { close(); socket.close(); } } as unknown as MuseRpc;
      });

      const dispatch = vi.fn((forwarded: Request) => instance.fetch(forwarded));
      const response = await handleRequest(request("hatch_sess=new-cookie"), bindings, dispatch);
      expect(dispatch.mock.calls[0][0].headers.has("Authorization")).toBe(false);
      const payload = await response.text();
      expect(response.status).toBe(200);
      expect(JSON.parse(payload)).toMatchObject({ ok: true, needs_login: false, last_imported_at: expect.any(Number) });
      for (const secret of ["new-cookie", "rotated-candidate", "fixture-token", adminKey]) expect(payload).not.toContain(secret);
      expect(call).toHaveBeenCalledWith("/api/session/list", 0);
      expect(close).toHaveBeenCalledOnce();
      const { value } = state.storage.sql.exec<{ value: string }>("SELECT value FROM credential_state WHERE id=1").one();
      expect(JSON.parse(value).cookies.hatch_sess.value).toBe("rotated-candidate");

      await instance.scheduledRenewal(1, "54 20 * * *");
      const lastAuth = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/api/auth/check")).at(-1);
      expect(new Headers(lastAuth?.[1]?.headers).get("Cookie")).toBe("hatch_sess=rotated-candidate");

      const current = origin + "/admin/current-cookie";
      const reveal = (key: string, source = origin) => handleRequest(new Request(current, {
        method: "POST", headers: { Authorization: "Bearer " + key, Origin: source },
      }), bindings, dispatch);
      expect((await reveal(bindings.DEMO_KEY)).status).toBe(401);
      expect((await reveal(adminKey, "https://other.test")).status).toBe(403);
      expect((await handleRequest(new Request(current), bindings, dispatch)).status).toBe(404);
      const exported = await reveal(adminKey);
      expect(exported.headers.get("Cache-Control")).toBe("no-store");
      expect(await exported.json()).toEqual({ cookie: "hatch_sess=rotated-candidate" });

      const callsBeforeStatus = fetcher.mock.calls.length;
      const status = await handleRequest(new Request(origin + "/cookie-health"), bindings, dispatch);
      expect(await status.json()).toEqual({ state: "healthy" });
      expect(fetcher.mock.calls).toHaveLength(callsBeforeStatus);
    });
  });
});

function mockUpstream(socket: WebSocket, headers?: HeadersInit) {
  return vi.fn(async (input: string | URL, _options?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/auth/check")) return Response.json({ access_token: "fixture-token" }, { headers });
    if (url.endsWith("/api/hatch/token")) return Response.json({ token: "fixture-hatch-token" });
    if (url.startsWith("https://hatch.metaaivm.com/v1/noise?")) return new Response(null, { status: 101, webSocket: socket });
    throw new Error("unexpected upstream");
  });
}
