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

it("recovers an uncertain submission by its exact device receipt, waits for the whole run, and commits once", async () => {
  await runInDurableObject(env.MOBILE.getByName("managed-recover"), async (_instance, state) => {
    const runtime = new ManagedChannels(state, env) as unknown as Harness;
    const store = new ManagedStore(state.storage.sql);
    const task = store.ingest(message("uncertain"))!;
    state.storage.sql.exec("UPDATE tasks SET state='unknown',session='remote',baseline=10 WHERE id=?", task.id);
    store.set("device:" + task.id, "our-device");
    let status = "running", device = "other-device";
    const call = vi.fn(async (path: string) => path.startsWith("/chat/history") ? { chat_events: [
      { seq: 11, event_name: "message.user", payload: { display_text: task.text, metadata: { client_device_id: device } } },
      { seq: 12, message_id: "reply", event_name: "message.assistant", payload: { status: "completed", display_text: "progress report" } },
      { seq: 13, message_id: "reply", event_name: "message.assistant", payload: { status: "completed", display_text: "final result" } },
    ] } : { status });
    vi.spyOn(runtime, "rpc").mockImplementation(async (operation) => operation({ call }));
    vi.spyOn(runtime, "watch").mockResolvedValue();
    try {
      await runtime.check(store.task(task.id));
      expect(store.task(task.id).state).toBe("unknown");
      device = "our-device";
      await runtime.check(store.task(task.id));
      expect(store.task(task.id).state).toBe("running");
      expect(state.storage.sql.exec("SELECT * FROM outbound").toArray()).toHaveLength(0);
      status = "completed";
      await runtime.check(store.task(task.id));
      expect(store.task(task.id).result).toBe("final result");
      expect(state.storage.sql.exec("SELECT * FROM outbound").toArray()).toHaveLength(1);
    } finally { vi.restoreAllMocks(); }
  });
});

it("a cancellation acknowledgement does not release the next queued task before the remote run stops", async () => {
  await runInDurableObject(env.MOBILE.getByName("managed-stop"), async (_instance, state) => {
    const runtime = new ManagedChannels(state, env) as unknown as Harness;
    const store = new ManagedStore(state.storage.sql);
    const task = store.ingest(message("first"))!;
    const next = store.ingest(message("second"))!;
    state.storage.sql.exec("UPDATE tasks SET state='running',session='remote' WHERE id=?", task.id);
    store.set("anchor:" + task.id, 10);
    store.set("cancel:" + task.conversation, true);
    let status = "running";
    const call = vi.fn(async (path: string) => path.startsWith("/chat/history") ? { chat_events: [] } : { status });
    vi.spyOn(runtime, "rpc").mockImplementation(async (operation) => operation({ call }));
    vi.spyOn(runtime, "watch").mockResolvedValue();
    try {
      await runtime.check(store.task(task.id));
      expect(store.task(task.id).state).toBe("running");
      expect(store.candidate()).toBeNull();
      status = "cancelled";
      await runtime.check(store.task(task.id));
      expect(store.task(task.id).state).toBe("cancelled");
      expect(store.candidate()?.id).toBe(next.id);
      expect(call.mock.calls.filter(([path]) => path === "/chat/cancel")).toHaveLength(1);
    } finally { vi.restoreAllMocks(); }
  });
});

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
