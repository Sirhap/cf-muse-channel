import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { ManagedStore } from "../src/managed/store";
import { validConfig, weixinMessages, wecomMessage, assertPlatformSuccess, type Incoming } from "../src/managed/protocol";

const config = { enabled: false, account: "test-bot", secret: "synthetic-token", allowedSenders: ["alice"] };
const message = (id: string, text = "hello"): Incoming => ({
  id, text, channel: "weixin", account: config.account, chat: "alice", sender: "alice", group: false, context: "test-context",
});

it("validates explicit account ownership and normalizes actual Tencent inbound shapes", () => {
  expect(validConfig(config)).toEqual(config);
  expect(() => validConfig({ ...config, allowedSenders: [] })).toThrow();
  const batch = { msgs: [
    { message_id: "one", from_user_id: "alice", context_token: "ctx", item_list: [{ type: 1, text_item: { text: "hello" } }] },
    { message_id: "two", from_user_id: "intruder", item_list: [{ type: 1, text_item: { text: "ignore" } }] },
  ] };
  expect(weixinMessages(batch, config)).toEqual([{ ...message("one"), context: "ctx" }]);
  expect(weixinMessages({ msgs: [{ message_id: "media", from_user_id: "alice", item_list: [{ type: 2 }] }] }, config)[0].text).toBe("/unsupported-media");
  expect(wecomMessage({ cmd: "aibot_msg_callback", body: { msgid: "three", from: { userid: "alice" }, msgtype: "text", text: { content: "hi" } } }, config))
    .toMatchObject({ channel: "wecom", id: "three", chat: "alice", text: "hi" });
  expect(() => assertPlatformSuccess({})).toThrow();
  expect(() => assertPlatformSuccess({ ret: -1 })).toThrow();
});

it("atomically deduplicates ingress, forwards without waiting for previous turns, and commits one immutable outbound", async () => {
  await runInDurableObject(env.MOBILE.getByName("queue-test"), async (_instance, state) => {
    const store = new ManagedStore(state.storage.sql);
    const one = store.ingest(message("one"))!;
    expect(store.ingest(message("one"))).toBeNull();
    const two = store.ingest(message("two"))!;
    expect(store.candidate()?.id).toBe(one.id);
    state.storage.sql.exec("UPDATE tasks SET state='unknown' WHERE id=?", one.id);
    expect(store.candidate()?.id).toBe(two.id);
    state.storage.transactionSync(() => store.complete(one, "reply"));
    expect(store.candidate()?.id).toBe(two.id);
    state.storage.transactionSync(() => store.complete(one, "reply"));
    expect(state.storage.sql.exec("SELECT * FROM outbound").toArray()).toHaveLength(1);
  });
});

it("deduplicates new-session commands while keeping uncertain submissions from being resent", async () => {
  await runInDurableObject(env.MOBILE.getByName("commands-test"), async (_instance, state) => {
    const store = new ManagedStore(state.storage.sql);
    const command = store.ingest(message("new", "/new"))!;
    state.storage.transactionSync(() => store.complete(command, store.command(command)!));
    expect(store.ingest(message("new", "/new"))).toBeNull();
    const next = store.ingest(message("after-new"))!;
    expect(next.generation).toBe(1);
    state.storage.sql.exec("UPDATE tasks SET state='unknown' WHERE id=?", next.id);
    const later = store.ingest(message("after-unknown"))!;
    expect(store.candidate()?.id).toBe(later.id);
    const help = store.ingest(message("help", "/help"))!;
    expect(store.command(help)).toContain("/stop");
  });
});

it("does not disclose channel secrets or enable an account in the disabled staging configuration", async () => {
  const stub = env.MOBILE.getByName("disabled-test");
  const response = await stub.fetch(new Request("https://internal/admin/managed/wecom", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config),
  }));
  expect(response.status).toBe(200);
  const status = await (await stub.fetch(new Request("https://internal/admin/managed/status"))).text();
  expect(status).not.toContain(config.secret);
  expect(status).not.toContain("alice");
  expect(JSON.parse(status).channels.wecom).toMatchObject({ configured: true, enabled: false });
  const enable = await stub.fetch(new Request("https://internal/admin/managed/wecom", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...config, enabled: true }),
  }));
  expect(enable.status).toBe(409);
});

it("records the durable submission boundary and never sends an uncertain turn twice", async () => {
  const { vi } = await import("vitest");
  const { ManagedChannels } = await import("../src/managed/runtime");
  const { MuseRpc } = await import("../src/noise");
  await runInDurableObject(env.MOBILE.getByName("submission-boundary"), async (_instance, state) => {
    const runtime = new ManagedChannels(state, { ...env, MANAGED_CHANNELS_ENABLED: "true" });
    const store = new ManagedStore(state.storage.sql);
    const task = store.ingest(message("uncertain"))!;
    const open = vi.fn(async () => {
      expect(store.task(task.id).state).toBe("submitting");
      throw new Error("socket closed after send");
    });
    const call = vi.fn(async (path: string) => path === "/session/start" ? { session_id: "test-session" } : { chat_events: [], has_more: false });
    const close = vi.fn();
    const rpc = { open, call, close, subscribe: vi.fn(async () => {}) };
    vi.spyOn(MuseRpc, "connect").mockResolvedValue(rpc as unknown as MuseRpc);
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (String(url).includes("/v1/noise")) {
        const [, socket] = Object.values(new WebSocketPair());
        return new Response(null, { status: 101, webSocket: socket });
      }
      return Response.json({ access_token: "synthetic-access", token: "synthetic-hatch" });
    }));
    try {
      await runtime.alarm();
      await runtime.alarm();
      expect(open).toHaveBeenCalledTimes(1);
      expect(store.task(task.id).state).toBe("unknown");
      expect(state.storage.sql.exec("SELECT * FROM outbound").toArray()).toHaveLength(0);
    } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });
});
