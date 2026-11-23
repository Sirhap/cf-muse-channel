import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { ManagedStore } from "../src/managed/store";
import type { Incoming } from "../src/managed/protocol";

const incoming = (id: string, text = id): Incoming => ({ id, text, channel: "weixin", account: "bot", chat: "alice", sender: "alice", group: false, context: "ctx-" + id });

it("does not hold new user input behind a previous running or uncertain Muse turn", async () => {
  await runInDurableObject(env.MOBILE.getByName("native-no-turn-queue"), async (_instance, state) => {
    const store = new ManagedStore(state.storage.sql);
    const first = store.ingest(incoming("one"))!;
    state.storage.sql.exec("UPDATE tasks SET state='running' WHERE id=?", first.id);
    const second = store.ingest(incoming("two"))!;
    expect(store.candidate()?.id).toBe(second.id);
    state.storage.sql.exec("UPDATE tasks SET state='unknown' WHERE id=?", first.id);
    expect(store.candidate()?.id).toBe(second.id);
  });
});

import { NativeConversations } from "../src/managed/native";
import { MuseOwnerUnavailable, type OwnedRpc } from "../src/managed/muse-owner";
import type { MuseRpc } from "../src/noise";

function fixture(state: DurableObjectState) {
  const store = new ManagedStore(state.storage.sql);
  let history: Record<string, unknown>[] = [];
  let sessions = 0;
  const call = vi.fn(async (path: string) => {
    if (path === "/session/start") return { session_id: "session-" + (++sessions) };
    if (path.startsWith("/chat/history")) return { chat_events: history };
    return { status: "running" };
  });
  const open = vi.fn(async () => 1);
  const client = { call, open } as unknown as MuseRpc;
  const watch = vi.fn();
  const native = new NativeConversations(store, (operation) => operation(client, { account: "primary-account", vm: "fixture-vm" }), (operation) => state.storage.transactionSync(operation), watch, async () => ["primary-account"]);
  return { store, native, call, open, watch, history: (events: Record<string, unknown>[]) => { history = events; } };
}
const assistant = (seq: number, id: string, text: string, status = "completed") => ({ seq, message_id: id, event_name: "message.assistant", payload: { message_id: id, status, display_text: text } });

it("sends all consecutive inputs into the same native session before any answer exists, without merging their text", async () => {
  await runInDurableObject(env.MOBILE.getByName("native-immediate-input"), async (_instance, state) => {
    const f = fixture(state);
    const one = f.store.ingest(incoming("one", "first piece"))!;
    const two = f.store.ingest(incoming("two", "second piece"))!;
    const three = f.store.ingest(incoming("three", "/custom-native-command"))!;
    await f.native.forward(one);
    await f.native.forward(two);
    await f.native.forward(three);
    expect(f.open).toHaveBeenCalledTimes(3);
    const bodies = f.open.mock.calls.map((args) => (args as unknown as [string, number, string, { session_id: string; items: { text: string }[] }])[3]);
    expect(bodies.map((body) => body.session_id)).toEqual(["session-1", "session-1", "session-1"]);
    expect(bodies.map((body) => body.items[0].text)).toEqual(["first piece", "second piece", "/custom-native-command"]);
    expect(f.store.task(one.id).state).toBe("submitted");
    expect(f.store.task(two.id).state).toBe("submitted");
    expect(f.store.command(three)).toBeNull();
    expect(f.call.mock.calls.filter(([path]) => path === "/session/start")).toHaveLength(1);
    expect(f.store.sql.exec("SELECT * FROM outbound").toArray()).toHaveLength(0);
  });
});

it("lets Muse combine several inputs into one answer and forwards that answer once without a session-completion gate", async () => {
  await runInDurableObject(env.MOBILE.getByName("native-server-owns-merge"), async (_instance, state) => {
    const f = fixture(state);
    await f.native.forward(f.store.ingest(incoming("one"))!);
    await f.native.forward(f.store.ingest(incoming("two"))!);
    f.history([assistant(10, "answer", "one native answer for both inputs")]);
    await f.native.collect(f.native.sessions()[0]);
    await f.native.collect(f.native.sessions()[0]);
    expect(f.store.sql.exec<{ text: string }>("SELECT text FROM outbound").toArray()).toEqual([{ text: "one native answer for both inputs" }]);
    expect(f.call.mock.calls.some(([path]) => path.startsWith("/api/session/list/"))).toBe(false);
    expect(f.store.sql.exec("SELECT * FROM tasks WHERE state='submitted'").toArray()).toHaveLength(2);
    expect(f.store.candidate()).toBeNull();
  });
});

it("returns each native message as Muse produces it, including intermediate answers while work continues", async () => {
  await runInDurableObject(env.MOBILE.getByName("native-intermediate-answers"), async (_instance, state) => {
    const f = fixture(state);
    await f.native.forward(f.store.ingest(incoming("one"))!);
    f.history([assistant(10, "progress", "research is ready"), assistant(11, "final", "still writing", "running")]);
    await f.native.collect(f.native.sessions()[0]);
    expect(f.store.sql.exec<{ text: string }>("SELECT text FROM outbound").toArray()).toEqual([{ text: "research is ready" }]);
    f.history([assistant(10, "progress", "research is ready"), assistant(11, "final", "finished\n\n[[hatch_widget:widget-hidden]]")]);
    await f.native.collect(f.native.sessions()[0]);
    expect(f.store.sql.exec<{ text: string }>("SELECT text FROM outbound ORDER BY id").toArray()).toEqual([{ text: "research is ready" }, { text: "finished" }]);
  });
});

it("keeps the latest route context and never mixes different channel conversations", async () => {
  await runInDurableObject(env.MOBILE.getByName("native-route-isolation"), async (_instance, state) => {
    const f = fixture(state);
    await f.native.forward(f.store.ingest(incoming("one"))!);
    await f.native.forward(f.store.ingest(incoming("two"))!);
    await f.native.forward(f.store.ingest({ ...incoming("other"), chat: "bob", sender: "bob" })!);
    const first = f.native.sessions().find((binding) => JSON.parse(binding.route).chat === "alice")!;
    f.history([assistant(10, "answer", "hello")]);
    await f.native.collect(first);
    const route = JSON.parse(f.store.sql.exec<{ route: string }>("SELECT route FROM outbound").one().route);
    expect(route.chat).toBe("alice");
    expect(route.context).toBe("ctx-two");
    expect(f.native.sessions()).toHaveLength(2);
  });
});

it("does not replay an uncertain input and still sends later native input without waiting for reconciliation", async () => {
  await runInDurableObject(env.MOBILE.getByName("native-uncertain-input"), async (_instance, state) => {
    const f = fixture(state);
    const one = f.store.ingest(incoming("one"))!;
    f.open.mockRejectedValueOnce(new Error("socket closed after send"));
    await f.native.forward(one);
    expect(f.store.task(one.id).state).toBe("unknown");
    const two = f.store.ingest(incoming("two"))!;
    await f.native.forward(two);
    expect(f.store.task(two.id).state).toBe("submitted");
    const device = f.store.get<string>("device:" + one.id);
    f.history([{ seq: 10, event_name: "message.user", payload: { display_text: "one", metadata: { client_device_id: device } } }]);
    await f.native.recoverLegacy();
    await f.native.collect(f.native.sessions()[0]);
    expect(f.store.task(one.id).state).toBe("submitted");
    expect(f.open).toHaveBeenCalledTimes(2);
  });
});

it("passes cancellation to Muse and lets later input continue without waiting for a task terminal state", async () => {
  await runInDurableObject(env.MOBILE.getByName("native-cancel"), async (_instance, state) => {
    const f = fixture(state);
    await f.native.forward(f.store.ingest(incoming("one"))!);
    const stop = f.store.ingest(incoming("stop", "/stop"))!;
    await f.native.forward(stop);
    await f.native.forward(f.store.ingest(incoming("later"))!);
    expect(f.call.mock.calls.filter(([path]) => path === "/chat/cancel")).toHaveLength(1);
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.store.task(stop.id).result).toContain("已向 Muse");
  });
});

it("adopts an already submitted old turn on upgrade without sending it again or losing its answer", async () => {
  await runInDurableObject(env.MOBILE.getByName("native-adopt-legacy"), async (_instance, state) => {
    const f = fixture(state);
    const old = f.store.ingest(incoming("old"))!;
    state.storage.sql.exec("UPDATE tasks SET state='running',session='old-session',baseline=9 WHERE id=?", old.id);
    state.storage.sql.exec("UPDATE conversations SET session='old-session'");
    f.history([assistant(10, "old-answer", "existing result")]);
    await f.native.recoverLegacy();
    await f.native.collect(f.native.sessions()[0]);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.store.sql.exec<{ text: string }>("SELECT text FROM outbound").one().text).toBe("existing result");
    expect(f.store.task(old.id).state).toBe("submitted");
  });
});

it("keeps an existing session and its files on its original VM after pool changes", async () => {
  await runInDurableObject(env.MOBILE.getByName("native-account-owner"), async (_, state) => {
    const store = new ManagedStore(state.storage.sql);
    const a = { account: "primary-account", vm: "vm-a" };
    const b = { account: "secondary", vm: "vm-b" };
    let poolOwner = a;
    let unavailable = false;
    const operations: [string, string][] = [];
    const rpc: OwnedRpc = async (op, target) => {
      const owner = target ? (target.account === a.account ? a : b) : poolOwner;
      if (unavailable && owner === a) throw new MuseOwnerUnavailable("muse_account_unavailable");
      const client = {
        call: async (path: string) => {
          operations.push([owner.account, path.split("?")[0]]);
          if (path === "/session/start") return { session_id: owner.vm };
          if (path.startsWith("/chat/history")) return { chat_events: [assistant(1, "attachment", "[[FILE:workspace/a.txt]]")] };
          return {};
        },
        open: async (path: string) => { operations.push([owner.account, path]); return 1; },
      } as unknown as MuseRpc;
      return op(client, owner);
    };
    const watch = vi.fn();
    const native = new NativeConversations(store, rpc, op => state.storage.transactionSync(op), watch, async () => [a.account, b.account]);
    await native.forward(store.ingest(incoming("one"))!);
    poolOwner = b;
    unavailable = true;
    const held = store.ingest(incoming("held"))!;
    await expect(native.forward(held)).rejects.toThrow("muse_account_unavailable");
    expect(store.task(held.id).state).toBe("queued");
    await native.forward(store.ingest({ ...incoming("unrelated"), chat: "bob" })!);
    unavailable = false;
    await native.forward(held);
    await native.forward(store.ingest(incoming("stop", "/stop"))!);
    await native.collect(native.session("vm-a")!);
    const output = store.sql.exec<{ task_id: number }>("SELECT task_id FROM outbound WHERE text=''").one();
    expect(store.get("outbound-owner:" + output.task_id)).toEqual(a);
    expect(watch).toHaveBeenCalledWith("vm-a", a);
    expect(operations).toEqual([
      [a.account, "/session/start"], [a.account, "/chat/stream"],
      [b.account, "/session/start"], [b.account, "/chat/stream"],
      [a.account, "/chat/stream"], [a.account, "/chat/cancel"], [a.account, "/chat/history"],
    ]);
  });
});

it("leaves a legacy session unbound until every candidate returns a definitive result", async () => {
  await runInDurableObject(env.MOBILE.getByName("native-legacy-ambiguous-owner"), async (_, state) => {
    const store = new ManagedStore(state.storage.sql);
    state.storage.sql.exec("DROP TABLE native_sessions");
    state.storage.sql.exec(`CREATE TABLE native_sessions(session TEXT PRIMARY KEY,conversation TEXT NOT NULL,generation INTEGER NOT NULL,
      route TEXT NOT NULL,cursor INTEGER NOT NULL,awaiting INTEGER NOT NULL DEFAULT 1,last_checked INTEGER NOT NULL DEFAULT 0,UNIQUE(conversation,generation))`);
    state.storage.sql.exec("INSERT INTO native_sessions(session,conversation,generation,route,cursor) VALUES ('legacy','c',0,'{}',10)");
    let otherResult = "socket_unavailable";
    const rpc: OwnedRpc = (op, target) => op({
      call: async () => {
        if (target?.account === "primary-account") throw new Error(otherResult);
        return { chat_events: [] };
      },
    } as unknown as MuseRpc, { account: target!.account, vm: "known-vm" });
    const native = new NativeConversations(store, rpc, op => state.storage.transactionSync(op), vi.fn(), async () => ["primary-account", "secondary"]);
    await expect(native.resolveOwner("legacy")).rejects.toThrow("muse_owner_unresolved");
    expect(native.session("legacy")?.muse_account).toBeNull();
    otherResult = "rpc_http_404";
    await expect(native.resolveOwner("legacy")).resolves.toEqual({ account: "secondary", vm: "known-vm" });
    expect(native.session("legacy")).toMatchObject({ muse_account: "secondary", muse_vm: "known-vm", cursor: 10 });
  });
});
