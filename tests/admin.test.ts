import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCookieInput } from "../src/admin-input";
import { MuseCredentials } from "../src/credentials";
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
    const extJson = JSON.stringify({
      cookie: "token=a=b; flags=123",
      cookies: { token: "a=b", flags: "123" },
      items: [{ name: "token", value: "a=b" }, { name: "flags", value: "123" }],
    });
    await expect(readCookieInput(request(extJson))).resolves.toMatchObject({
      token: { value: "a=b" }, flags: { value: "123" },
    });
    await expect(readCookieInput(request(JSON.stringify({ cookies: { token: "a=b", flags: "123" } })))).resolves.toMatchObject({
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

      vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/auth/check")) return Response.json({ access_token: "fixture-token" });
        if (url.endsWith("/api/hatch/token")) return Response.json({ token: "fixture-hatch-token" });
        if (url.startsWith("https://hatch.metaaivm.com/v1/noise?")) return new Response(null, { status: 502 });
        throw new Error("unexpected upstream");
      }));
      const sleepingVm = await instance.fetch(request("hatch_sess=sleeping-vm-cookie"));
      expect(sleepingVm.status).toBe(200);
      expect(await sleepingVm.json()).toMatchObject({ ok: true, vm_sleeping: true });
      expect(JSON.parse(row()).cookies.hatch_sess.value).toBe("sleeping-vm-cookie");
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

  it("supports enabling multiple accounts concurrently with strategy rotation and failover", async () => {
    const stub = env.CREDENTIALS.getByName("admin-multi-account-pool");
    await runInDurableObject(stub, async (instance) => {
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const cookieHeader = new Headers(init?.headers).get("Cookie") ?? "";
        if (url.endsWith("/api/session")) {
          const vmId = cookieHeader.includes("acc-two") ? "vm-two" : "vm-one";
          return Response.json({ vm_id: vmId });
        }
        if (url.endsWith("/api/auth/check")) {
          if (cookieHeader.includes("fail-once")) return new Response(null, { status: 500 });
          return Response.json({ access_token: "fixture-token" });
        }
        if (url.endsWith("/api/hatch/token")) return Response.json({ token: "fixture-hatch-token" });
        if (url.startsWith("https://hatch.metaaivm.com/v1/noise?")) {
          const [, server] = Object.values(new WebSocketPair());
          return new Response(null, { status: 101, webSocket: server });
        }
        throw new Error("unexpected upstream: " + url);
      }));
      vi.spyOn(MuseRpc, "connect").mockImplementation(async (socket) => {
        socket.accept();
        return { call: vi.fn(async () => ({ sessions: [] })), close: () => socket.close() } as unknown as MuseRpc;
      });

      const postAccounts = (payload: Record<string, unknown>) => instance.fetch(new Request(origin + "/admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }));

      // 1. 批量导入两个账号并自动全部开启
      const batchRes = await postAccounts({
        action: "batch_create",
        items: [
          { label: "二号账号", id: "acc-two", cookie: "hatch_sess=acc-two-cookie", enabled: true },
          { label: "三号账号", id: "acc-three", cookie: "hatch_sess=acc-three-cookie", enabled: true },
        ],
      });
      expect(batchRes.status).toBe(200);
      const batchData = await batchRes.json<{
        pool_strategy: string;
        stats: { total: number; enabled: number; healthy: number };
        accounts: Array<{ id: string; enabled: boolean }>;
        batch_result: { created: Array<{ id: string }>; failed: unknown[] };
      }>();
      expect(batchData.batch_result.created).toHaveLength(2);
      expect(batchData.stats.total).toBe(3);
      expect(batchData.stats.enabled).toBe(3);
      expect(batchData.accounts.every((a) => a.enabled)).toBe(true);

      // 2. 切换为轮询策略并触发池调用，验证同时开启的多个账号可正常分流和记录调用统计
      const stratRes = await postAccounts({ action: "set_strategy", strategy: "round_robin" });
      expect((await stratRes.json<{ pool_strategy: string }>()).pool_strategy).toBe("round_robin");

      for (let i = 0; i < 3; i++) {
        const rpcRes = await instance.fetch(new Request(origin + "/probe/worker-rpc", { method: "POST" }));
        expect(rpcRes.status).toBe(200);
      }

      const listAfterRpc = await (await instance.fetch(new Request(origin + "/admin/accounts"))).json<{
        accounts: Array<{ id: string; enabled: boolean; success_count: number }>;
      }>();
      const totalSuccess = listAfterRpc.accounts.reduce((acc, a) => acc + a.success_count, 0);
      expect(totalSuccess).toBe(3);

      // 3. 停用其中一个账号不影响其他已开启账号继续服务
      const toggleRes = await postAccounts({ action: "toggle", id: "acc-three", enabled: false });
      const toggledData = await toggleRes.json<{ stats: { enabled: number } }>();
      expect(toggledData.stats.enabled).toBe(2);
    });
  });

  it("wakes sleeping VMs via /api/hatch/vm/wake and persists discovered vmId", async () => {
    const stub = env.CREDENTIALS.getByName("admin-auto-wake-vm");
    await runInDurableObject(stub, async (instance, state) => {
      let wsAttempts = 0;
      let wakeCalled = false;
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/session")) {
          return Response.json({ vms: [{ vm_id: "vm-discovered", is_preferred: true }] });
        }
        if (url.endsWith("/api/auth/check")) return Response.json({ access_token: "fixture-token" });
        if (url.endsWith("/api/hatch/token")) return Response.json({ token: "fixture-hatch-token" });
        if (url.endsWith("/api/hatch/vm/wake")) {
          wakeCalled = true;
          expect(JSON.parse(String(init?.body))).toEqual({ vm_id: "vm-discovered" });
          return Response.json({ status: "wake_requested" });
        }
        if (url.startsWith("https://hatch.metaaivm.com/v1/noise?")) {
          wsAttempts += 1;
          if (wsAttempts === 1) return new Response(null, { status: 502 });
          const [, server] = Object.values(new WebSocketPair());
          return new Response(null, { status: 101, webSocket: server });
        }
        throw new Error("unexpected upstream: " + url);
      }));
      vi.spyOn(MuseRpc, "connect").mockImplementation(async (socket) => {
        socket.accept();
        return { call: vi.fn(async () => ({ sessions: [] })), close: () => socket.close() } as unknown as MuseRpc;
      });

      const req = request("hatch_sess=wake-test");
      req.headers.set("X-Muse-Internal-Isolated", "1");
      const res = await instance.fetch(req);
      expect(res.status).toBe(200);
      expect(wakeCalled).toBe(true);
      expect(wsAttempts).toBe(2);
      const body = await res.json<{ ok: boolean; vm_id: string | null }>();
      expect(body).toMatchObject({ ok: true, vm_id: "vm-discovered" });
      const { value } = state.storage.sql.exec<{ value: string }>("SELECT value FROM credential_state WHERE id=1").one();
      expect(JSON.parse(value).vmId).toBe("vm-discovered");
    });
  });

  it("supports multi-account auto-approval and auto-renewal while skipping disabled accounts and avoiding isolated alarms", async () => {
    const pushedAlerts: Array<Record<string, unknown>> = [];
    const internalPollsCalled: string[] = [];
    const internalRenewsCalled: string[] = [];

    // 1. 测试协调器：全池审批轮询、跳过停用账号、全局统计聚合及多账号续期分发
    await runInDurableObject(env.CREDENTIALS.getByName("multi-pool-coord-main"), async (_s, coordState) => {
      const baseEnv = {
        ...env,
        MUSE_ADMIN_KEY: adminKey,
        AUTO_APPROVAL_ENABLED: "true",
        MANAGED_CHANNELS_ENABLED: "true",
        AUTO_APPROVAL_POLICY_JSON: JSON.stringify({
          rules: [{ host: "muse-demo.sirhao.top", port: 443, scheme: "https", methods: ["GET", "CONNECT"] }],
        }),
      } as unknown as Env;

      const coordEnv = {
        ...baseEnv,
        CREDENTIALS: {
          getByName(name: string) {
            return {
              async fetch(req: Request) {
                const p = new URL(req.url).pathname;
                if (p === "/admin/cookie" && req.method === "POST") {
                  return Response.json({ configured: true, ok: true, needs_login: false, vm_id: "vm-" + name });
                }
                if (p === "/admin/internal-poll-approvals") {
                  internalPollsCalled.push(name);
                  return Response.json({
                    ok: true,
                    enabled: true,
                    pending: 1,
                    approved: 1,
                    held: 0,
                    unknown: 0,
                    accepted_total: 1,
                  });
                }
                if (p === "/admin/internal-scheduled-renew") {
                  internalRenewsCalled.push(name);
                  return Response.json({ ok: name !== "sec-enabled" });
                }
                return Response.json({ configured: true, ok: true });
              },
            };
          },
        },
        MOBILE: {
          getByName() {
            return {
              async fetch(req: Request) {
                if (new URL(req.url).pathname === "/managed/push") {
                  pushedAlerts.push(await req.json<Record<string, unknown>>());
                }
                return Response.json({ ok: true });
              },
            };
          },
        },
      } as unknown as Env;

      const coordDo = new MuseCredentials(coordState, coordEnv);

      vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/auth/check")) return Response.json({ access_token: "tok-main", vm_id: "vm-main" });
        if (url.endsWith("/api/hatch/token")) return Response.json({ token: "hatch-main" });
        if (url.startsWith("https://hatch.metaaivm.com/v1/noise?")) {
          const [, server] = Object.values(new WebSocketPair());
          return new Response(null, { status: 101, webSocket: server });
        }
        throw new Error("unexpected fetch url: " + url);
      }));

      vi.spyOn(MuseRpc, "connect").mockImplementation(async (socket) => {
        socket.accept();
        return {
          call: vi.fn(async (rpcPath: string) => {
            if (rpcPath === "/approvals") return { pending_approvals: [{ approval_id: "main-req-1" }] };
            if (rpcPath.endsWith("/decide")) return { ok: true };
            return {
              approval: {
                approval_id: "main-req-1",
                host: "muse-demo.sirhao.top",
                port: 443,
                scheme: "wss",
                method: "GET",
                status: "pending",
                request_expires_at_ms: Date.now() + 60_000,
              },
            };
          }),
          close: () => socket.close(),
        } as unknown as MuseRpc;
      });

      expect((await coordDo.fetch(request("hatch_sess=main-cookie"))).status).toBe(200);
      expect((await coordDo.fetch(new Request("https://internal/admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", id: "sec-enabled", label: "备用自动审批", cookie: "hatch_sess=sec-cookie", enabled: true }),
      }))).status).toBe(200);
      expect((await coordDo.fetch(new Request("https://internal/admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", id: "sec-disabled", label: "停用账号", cookie: "hatch_sess=dis-cookie", enabled: false }),
      }))).status).toBe(200);

      await coordDo.alarm();
      expect(internalPollsCalled).toEqual(["sec-enabled"]);
      expect(await coordState.storage.getAlarm()).not.toBeNull();

      const appStatus = await (await coordDo.fetch(new Request("https://internal/approvals/status"))).json<{
        enabled: boolean;
        decisions: Array<{ state: string; count: number }>;
        last_event: { ok: boolean; accounts_polled: number; accounts_ok: number; approved: number; per_account: Array<{ id: string }> };
      }>();
      expect(appStatus.enabled).toBe(true);
      expect(appStatus.last_event).toMatchObject({ ok: true, accounts_polled: 2, accounts_ok: 2, approved: 2 });
      expect(appStatus.last_event.per_account.map((a) => a.id)).toEqual(["primary-account", "sec-enabled"]);
      expect(appStatus.decisions.find((d) => d.state === "rpc_accepted")?.count).toBe(2);

      const renewRes = await coordDo.scheduledRenewal(1795000000000, "54 20 * * *");
      expect(internalRenewsCalled).toEqual(["sec-enabled"]);
      expect(renewRes).toMatchObject({ ok: false, accounts_total: 2, accounts_ok: 1 });
    });

    // 2. 测试隔离副账号 DO：独立审批、不设 DO Alarm、401 过期发出带账号标识的推送告警
    await runInDurableObject(env.CREDENTIALS.getByName("multi-pool-sec-isolated"), async (_s, secState) => {
      let authFail = false;
      const secAlerts: Array<Record<string, unknown>> = [];
      const secEnv = {
        ...env,
        MUSE_ADMIN_KEY: adminKey,
        AUTO_APPROVAL_ENABLED: "true",
        MANAGED_CHANNELS_ENABLED: "true",
        AUTO_APPROVAL_POLICY_JSON: JSON.stringify({
          rules: [{ host: "muse-demo.sirhao.top", port: 443, scheme: "https", methods: ["GET", "CONNECT"] }],
        }),
        MOBILE: {
          getByName() {
            return {
              async fetch(req: Request) {
                if (new URL(req.url).pathname === "/managed/push") {
                  secAlerts.push(await req.json<Record<string, unknown>>());
                }
                return Response.json({ ok: true });
              },
            };
          },
        },
      } as unknown as Env;

      const secDo = new MuseCredentials(secState, secEnv);
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/auth/check")) {
          if (authFail) return new Response(null, { status: 401 });
          return Response.json({ access_token: "tok-sec", vm_id: "vm-sec" });
        }
        if (url.endsWith("/api/session")) return Response.json({ vm_id: "vm-sec" });
        if (url.endsWith("/api/hatch/token")) return Response.json({ token: "hatch-sec" });
        if (url.startsWith("https://hatch.metaaivm.com/v1/noise?")) {
          const [, server] = Object.values(new WebSocketPair());
          return new Response(null, { status: 101, webSocket: server });
        }
        throw new Error("unexpected fetch url: " + url);
      }));

      vi.spyOn(MuseRpc, "connect").mockImplementation(async (socket) => {
        socket.accept();
        return {
          call: vi.fn(async (rpcPath: string) => {
            if (rpcPath === "/approvals") return { pending_approvals: [{ approval_id: "sec-req-1" }] };
            if (rpcPath.endsWith("/decide")) return { ok: true };
            return {
              approval: {
                approval_id: "sec-req-1",
                host: "muse-demo.sirhao.top",
                port: 443,
                scheme: "wss",
                method: "GET",
                status: "pending",
                request_expires_at_ms: Date.now() + 60_000,
              },
            };
          }),
          close: () => socket.close(),
        } as unknown as MuseRpc;
      });

      const saveSec = new Request("https://internal/admin/cookie", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Muse-Internal-Isolated": "1" },
        body: JSON.stringify({ cookie: "hatch_sess=sec-cookie" }),
      });
      expect((await secDo.fetch(saveSec)).status).toBe(200);
      expect(await secState.storage.getAlarm()).toBeNull();

      const pollSec = new Request("https://internal/admin/internal-poll-approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Muse-Internal-Isolated": "1" },
        body: JSON.stringify({ source: "durable_object_alarm", accountLabel: "备用自动审批" }),
      });
      const pollPayload = await (await secDo.fetch(pollSec)).json<{ ok: boolean; approved: number; accepted_total: number }>();
      expect(pollPayload).toMatchObject({ ok: true, approved: 1, accepted_total: 1 });
      expect(await secState.storage.getAlarm()).toBeNull();

      authFail = true;
      const renewSec = new Request("https://internal/admin/internal-scheduled-renew", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Muse-Internal-Isolated": "1" },
        body: JSON.stringify({ scheduledTime: 1795000000000, cron: "54 20 * * *", accountLabel: "备用自动审批" }),
      });
      const renewSecPayload = await (await secDo.fetch(renewSec)).json<{ ok: boolean }>();
      expect(renewSecPayload.ok).toBe(false);
      expect(secAlerts.some((a) => String(a.text).includes("Cookie 已过期") && String(a.text).includes("备用自动审批"))).toBe(true);
      expect(await secState.storage.getAlarm()).toBeNull();
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
