import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { ManagedChannels } from "../src/managed/runtime";
import { ManagedStore, type Task } from "../src/managed/store";
import type { Incoming } from "../src/managed/protocol";

const message = (id: string, text = "research this"): Incoming => ({
  id, text, channel: "weixin", account: "test-account", sender: "alice", chat: "alice", group: false, context: "synthetic",
});
interface Harness {
  rpc: <T>(operation: (client: { call: (path: string) => Promise<unknown> }) => Promise<T>) => Promise<T>;
  watch: (session: string) => Promise<void>;
  check: (task: Task) => Promise<void>;
  ingest: (message: Incoming) => void;
  deliver: () => Promise<void>;
}

it("does not resend a chunk after losing its platform acknowledgement or after a restart", async () => {
  await runInDurableObject(env.MOBILE.getByName("managed-outbound-recovery"), async (_instance, state) => {
    const runtime = new ManagedChannels(state, env) as unknown as Harness;
    const store = new ManagedStore(state.storage.sql);
    state.storage.sql.exec("INSERT INTO config VALUES ('weixin',?)", JSON.stringify({ enabled: true, account: "test-account", secret: "synthetic", allowedSenders: ["alice"] }));
    const task = store.ingest(message("first"))!;
    store.complete(task, "result");
    const send = vi.fn(async () => { throw new Error("acknowledgement lost"); });
    vi.stubGlobal("fetch", send);
    try {
      await runtime.deliver();
      await runtime.deliver();
      const restarted = new ManagedChannels(state, env) as unknown as Harness;
      await restarted.deliver();
      expect(send).toHaveBeenCalledTimes(1);
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM outbound").one().state).toBe("unknown");
    } finally { vi.unstubAllGlobals(); }
  });
});

it("allows stopping reception while tasks exist but blocks replacing credentials with undelivered results", async () => {
  await runInDurableObject(env.MOBILE.getByName("managed-config-fence"), async (instance, state) => {
    const config = { enabled: true, account: "test-account", secret: "synthetic", allowedSenders: ["alice"] };
    state.storage.sql.exec("INSERT INTO config VALUES ('weixin',?)", JSON.stringify(config));
    const store = new ManagedStore(state.storage.sql);
    store.complete(store.ingest(message("first"))!, "waiting for delivery");
    const set = (body: unknown) => instance.fetch(new Request("https://internal/admin/managed/weixin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    expect((await set({ ...config, secret: "replacement" })).status).toBe(409);
    expect((await set({ ...config, enabled: false })).status).toBe(200);
  });
});

it("constructs Tencent requests in the actual Workers runtime and never follows a credential-bearing redirect", async () => {
  const { weixinCall } = await import("../src/managed/protocol");
  let status = 200;
  const outbound = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.redirect).toBe("manual");
    return status === 200 ? Response.json({ ret: 0 }) : new Response(null, { status, headers: { Location: "https://untrusted.test" } });
  });
  vi.stubGlobal("fetch", outbound);
  try {
    const config = { enabled: false, account: "test-account", secret: "synthetic", allowedSenders: ["alice"] };
    await expect(weixinCall("getconfig", config, {})).resolves.toMatchObject({ ret: 0 });
    status = 302;
    await expect(weixinCall("getconfig", config, {})).rejects.toThrow("upstream_http_302");
    expect(outbound).toHaveBeenCalledTimes(2);
  } finally { vi.unstubAllGlobals(); }
});

it("preflights WeCom with a real Workers Request without subscribing to or taking over the existing bot", async () => {
  await runInDurableObject(env.MOBILE.getByName("managed-preflight"), async (instance, state) => {
    let server: WebSocket | undefined;
    const socket = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("Upgrade")).toBe("websocket");
      const pair = new WebSocketPair();
      server = pair[1]; server.accept();
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
    vi.stubGlobal("fetch", socket);
    try {
      const response = await instance.fetch(new Request("https://internal/admin/managed/connectivity", { method: "POST" }));
      expect(await response.json()).toMatchObject({ wecom: { ok: true, stage: "upgrade_only_no_subscription" } });
      expect(state.storage.sql.exec("SELECT * FROM config").toArray()).toHaveLength(0);
      expect(socket).toHaveBeenCalledTimes(1);
    } finally { server?.close(); vi.unstubAllGlobals(); }
  });
});

it("accepts an empty iLink update checkpoint without ret while requiring explicit send acknowledgement", async () => {
  const { weixinCall } = await import("../src/managed/protocol");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ msgs: [], get_updates_buf: "synthetic-cursor" })));
  const config = { enabled: false, account: "test-account", secret: "synthetic", allowedSenders: ["alice"] };
  try {
    await expect(weixinCall("getupdates", config, {})).resolves.toMatchObject({ msgs: [] });
    await expect(weixinCall("sendmessage", config, {})).rejects.toThrow("platform_rejected");
  } finally { vi.unstubAllGlobals(); }
});

it("preserves Tencent's 64-bit message IDs before JavaScript can round them or discard the message", async () => {
  const { boundedJson, weixinMessages } = await import("../src/managed/protocol");
  const response = new Response('{"ret":0,"msgs":[{"message_id":7527655115952555016,"from_user_id":"alice","item_list":[{"type":1,"text_item":{"text":"CF test"}}]}]}');
  const data = await boundedJson(response);
  expect(weixinMessages(data, { enabled: true, account: "test", secret: "synthetic", allowedSenders: ["alice"] })[0]?.id)
    .toBe("7527655115952555016");
});

it("removes the handshake deadline after upgrading a persistent WeCom connection", async () => {
  await runInDurableObject(env.MOBILE.getByName("managed-handshake-deadline"), async (_instance, state) => {
    const config = { enabled: true, account: "test-account", secret: "synthetic", allowedSenders: ["alice"] };
    state.storage.sql.exec("INSERT INTO config VALUES ('wecom',?)", JSON.stringify(config));
    const runtime = new ManagedChannels(state, env) as unknown as {
      connectWecom: (settings: typeof config) => Promise<void>;
      frame: () => Promise<Record<string, unknown>>;
      closeWecom: () => void;
    };
    let peer: WebSocket | undefined;
    let signal: AbortSignal | undefined;
    const timers = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    vi.spyOn(runtime, "frame").mockResolvedValue({ errcode: 0 });
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      const pair = new WebSocketPair(); peer = pair[1]; peer.accept();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }));
    try {
      await runtime.connectWecom(config);
      const timerIndex = timers.mock.calls.findIndex(([, milliseconds]) => milliseconds === 15000);
      expect(timerIndex).toBeGreaterThanOrEqual(0);
      expect(clear).toHaveBeenCalledWith(timers.mock.results[timerIndex].value);
      expect(signal?.aborted).toBe(false);
    } finally { runtime.closeWecom(); peer?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });
});

it("resolves a recipient-confirmed ambiguous bubble without sending and rejects a mismatched message", async () => {
  await runInDurableObject(env.MOBILE.getByName("managed-recipient-receipt"), async (instance, state) => {
    const store = new ManagedStore(state.storage.sql);
    const task = store.ingest(message("confirmed-bubble"))!;
    store.complete(task, "received");
    state.storage.sql.exec("UPDATE outbound SET state='unknown'");
    const request = (id: string) => instance.fetch(new Request("https://internal/admin/managed/confirm-delivery", {
      method: "POST", body: JSON.stringify({ received: true, task_id: task.id, message_id: id }),
    }));
    expect((await request("different-message")).status).toBe(409);
    expect((await request(task.message_id)).status).toBe(200);
    expect((await request(task.message_id)).status).toBe(200);
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM outbound").one().state).toBe("delivered");
    expect(state.storage.sql.exec("SELECT * FROM outbound").toArray()).toHaveLength(1);
  });
});

it("accepts Tencent's omitted default success code but rejects explicit send errors and arbitrary payloads", async () => {
  const { weixinCall } = await import("../src/managed/protocol");
  const config = { enabled: false, account: "test", secret: "synthetic", allowedSenders: ["alice"] };
  let response: unknown = {};
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(response)));
  try {
    await expect(weixinCall("sendmessage", config, {})).resolves.toEqual({});
    response = { ret: -2 };
    await expect(weixinCall("sendmessage", config, {})).rejects.toThrow("platform_rejected_-2");
    response = { error: "denied" };
    await expect(weixinCall("sendmessage", config, {})).rejects.toThrow("platform_rejected");
  } finally { vi.unstubAllGlobals(); }
});

it("recognizes a lossless Tencent send message ID even when the zero ret field is omitted", async () => {
  const { weixinCall } = await import("../src/managed/protocol");
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"message_id":7528384617896807432}')));
  try {
    await expect(weixinCall("sendmessage", { enabled: false, account: "test", secret: "synthetic", allowedSenders: ["alice"] }, {}))
      .resolves.toEqual({ message_id: "7528384617896807432" });
  } finally { vi.unstubAllGlobals(); }
});
