import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { APPROVAL_EVENTS_HEADER } from "../src/approval-policy";
import { MuseCredentials } from "../src/credentials";
import { ManagedChannels } from "../src/managed/runtime";
import { MuseRpc } from "../src/noise";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function upstreamNoiseResponse() {
  const [client, upstream] = Object.values(new WebSocketPair());
  upstream.accept();
  return new Response(null, { status: 101, webSocket: client });
}

it("advertises approval streaming only for the selected primary account on the managed connection", async () => {
  await runInDurableObject(env.CREDENTIALS.getByName("approval-event-account"), async (_instance, state) => {
    const fetchSecondary = vi.fn(async (request: Request) => new URL(request.url).pathname === "/ws"
      ? upstreamNoiseResponse()
      : Response.json({ configured: true, needs_login: false, ok: true }));
    const credentials = new MuseCredentials(state, {
      ...env,
      AUTO_APPROVAL_ENABLED: "true",
      AUTO_APPROVAL_EVENTS_ENABLED: "true",
      MANAGED_CHANNELS_ENABLED: "true",
      CREDENTIALS: { getByName: () => ({ fetch: fetchSecondary }) },
    } as unknown as Env);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const path = new URL(input).pathname;
      if (path === "/api/auth/check") return Response.json({ access_token: "test-token" });
      if (path === "/api/hatch/token") return Response.json({ token: "test-hatch-token" });
      if (path === "/v1/noise") return upstreamNoiseResponse();
      throw new Error("unexpected request " + path);
    }));
    async function upgrade(host: string) {
      const response = await credentials.fetch(new Request(`https://${host}/ws`, {
        headers: { Upgrade: "websocket", [APPROVAL_EVENTS_HEADER]: "1" },
      }));
      expect(response.status).toBe(101);
      response.webSocket!.accept();
      response.webSocket!.close();
      return response.headers.get(APPROVAL_EVENTS_HEADER);
    }

    expect(await upgrade("internal")).toBe("1");
    expect(await upgrade("public.example")).toBeNull();
    state.storage.sql.exec("UPDATE muse_accounts SET is_default=0 WHERE id='primary-account'");
    state.storage.sql.exec(
      "INSERT INTO muse_accounts (id,label,is_default,enabled,created_at) VALUES ('secondary','Secondary',1,1,?)", Date.now(),
    );
    expect(await upgrade("internal")).toBeNull();
    expect(fetchSecondary.mock.calls.some(([request]) => new URL(request.url).pathname === "/ws")).toBe(true);
  });
});

it("watches approvals on the warm socket, deduplicates snapshots and loses readiness on disconnect", async () => {
  await runInDurableObject(env.MOBILE.getByName("approval-event-socket"), async (_instance, state) => {
    const stream = Promise.withResolvers<void>();
    let receive: (event: unknown) => void = () => { throw new Error("subscription was not started"); };
    const subscribe = vi.fn((_path, _body, onEvent) => {
      receive = onEvent;
      return stream.promise;
    });
    const checkApprovalEvent = vi.fn(async () => {});
    const fetch = vi.fn(async (request: Request) => {
      expect(request.headers.get(APPROVAL_EVENTS_HEADER)).toBe("1");
      const response = upstreamNoiseResponse();
      response.headers.set(APPROVAL_EVENTS_HEADER, "1");
      return response;
    });
    const connect = vi.spyOn(MuseRpc, "connect").mockResolvedValue({ subscribe, alive: true } as unknown as MuseRpc);
    const runtime = new ManagedChannels(state, {
      ...env,
      CREDENTIALS: { getByName: () => ({ fetch, checkApprovalEvent }) },
    } as unknown as Env);
    const warm = runtime as unknown as { rpc: (operation: (client: MuseRpc) => Promise<void>) => Promise<void> };
    const snapshot = (ids: string[]) => ({
      event: "approvals.snapshot",
      payload: { pending_approvals: ids.map((approval_id) => ({ approval_id })) },
    });

    await warm.rpc(async () => {});
    expect(connect).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith("/chat/subscribe", {}, expect.any(Function), 0);
    expect(runtime.primaryApprovalSubscriptionReady()).toBe(false);
    receive(snapshot([]));
    expect(runtime.primaryApprovalSubscriptionReady()).toBe(true);
    expect(checkApprovalEvent).not.toHaveBeenCalled();
    receive(snapshot(["one", "two"]));
    receive(snapshot(["two", "one"]));
    expect(checkApprovalEvent).toHaveBeenCalledOnce();
    receive(snapshot(["two", "three"]));
    expect(checkApprovalEvent).toHaveBeenCalledTimes(2);
    receive({ event: "approvals.snapshot", payload: { pending_approvals: [{}] } });
    expect(runtime.primaryApprovalSubscriptionReady()).toBe(false);
    receive(snapshot([]));
    expect(runtime.primaryApprovalSubscriptionReady()).toBe(true);

    stream.resolve();
    await vi.waitFor(() => expect(runtime.primaryApprovalSubscriptionReady()).toBe(false));
  });
});

it("event wakeups use the approval audit, with bounded reconciliation and fallback for the primary account", async () => {
  await runInDurableObject(env.CREDENTIALS.getByName("approval-event-poll"), async (_instance, state) => {
    const fetchSecondary = vi.fn(async () => Response.json({
      ok: true, pending: 0, approved: 0, held: 0, unknown: 0, accepted_total: 0,
    }));
    const ready = vi.fn(async () => true);
    const credentials = new MuseCredentials(state, {
      ...env,
      MANAGED_CHANNELS_ENABLED: "true",
      AUTO_APPROVAL_ENABLED: "true",
      AUTO_APPROVAL_EVENTS_ENABLED: "true",
      AUTO_APPROVAL_POLICY_JSON: JSON.stringify({
        rules: [{ host: "approved.example", port: 443, scheme: "https", methods: ["GET"] }],
      }),
      CREDENTIALS: { getByName: () => ({ fetch: fetchSecondary }) },
      MOBILE: {
        getByName: () => ({
          primaryApprovalSubscriptionReady: ready,
          fetch: async () => Response.json({ ok: true }),
        }),
      },
    } as unknown as Env);
    state.storage.sql.exec("INSERT INTO muse_accounts (id,label,enabled,created_at) VALUES ('secondary','Secondary',1,?)", Date.now());
    vi.stubGlobal("fetch", vi.fn(async (request: string | URL) => {
      const path = new URL(request).pathname;
      if (path === "/api/auth/check") return Response.json({ access_token: "test-token" });
      if (path === "/api/hatch/token") return Response.json({ token: "test-hatch-token" });
      if (path === "/v1/noise") return upstreamNoiseResponse();
      throw new Error("unexpected request " + path);
    }));
    const call = vi.fn(async (path: string) => {
      if (path === "/approvals") return { pending_approvals: [{ approval_id: "allowed" }, { approval_id: "held" }] };
      if (path.endsWith("/decide")) return { ok: true };
      const id = path.split("/").pop();
      return {
        approval_id: id, status: "pending", method: "GET", scheme: "https", port: 443,
        host: id === "allowed" ? "approved.example" : "held.example",
        request_expires_at_ms: Date.now() + 60_000,
      };
    });
    vi.spyOn(MuseRpc, "connect").mockImplementation(async (socket) => {
      socket.accept();
      return { call, close: () => socket.close() } as unknown as MuseRpc;
    });

    await credentials.checkApprovalEvent();
    expect(call.mock.calls.filter(([path]) => path.endsWith("/decide"))).toEqual([["/approvals/allowed/decide", 1, "POST", { decision: "allow_once" }]]);
    const checks = () => call.mock.calls.filter(([path]) => path === "/approvals").length;
    expect(checks()).toBe(1);
    expect(await credentials.poll("durable_object_alarm")).toMatchObject({ accounts_polled: 1, primary_via_events: true, total_accepted: 1 });
    expect(checks()).toBe(1);
    expect(fetchSecondary).toHaveBeenCalledOnce();

    ready.mockResolvedValueOnce(false);
    expect(await credentials.poll("durable_object_alarm")).toMatchObject({ accounts_polled: 2 });
    expect(checks()).toBe(2);
    state.storage.sql.exec("UPDATE service_events SET value=? WHERE kind='primary_approval_checked'", JSON.stringify(Date.now() - 310_000));
    expect(await credentials.poll("durable_object_alarm")).toMatchObject({ accounts_polled: 2 });
    expect(checks()).toBe(3);
    expect(call.mock.calls.filter(([path]) => path.endsWith("/decide"))).toHaveLength(1);
  });
});
