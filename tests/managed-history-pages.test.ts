import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { NativeConversations } from "../src/managed/native";
import { ManagedStore } from "../src/managed/store";
import type { MuseRpc } from "../src/noise";

function assistant(seq: number, status = "completed", message = "m" + seq) {
  return { seq, event_name: "message.assistant", message_id: message, payload: { status, display_text: "output " + seq } };
}

function fixture(state: DurableObjectState) {
  const store = new ManagedStore(state.storage.sql);
  let history: Record<string, unknown>[] = [];
  type ReadPage = (after: number, limit: number) => { chat_events: Record<string, unknown>[]; has_more: boolean };
  const readPage = vi.fn<ReadPage>((after: number, limit: number) => {
    const events = history.filter(event => Number(event.seq) > after);
    return { chat_events: events.slice(0, limit), has_more: events.length > limit };
  });
  const client = {
    call: async (path: string) => {
      if (path === "/session/start") return { session_id: "test-history" };
      const query = new URL("https://muse.test" + path).searchParams;
      return readPage(Number(query.get("after_seq")), Number(query.get("limit")));
    },
    open: vi.fn(async () => 1),
  };
  const newNative = () => new NativeConversations(store,
    op => op(client as unknown as MuseRpc, { account: "primary-account", vm: "vm-a" }),
    op => state.storage.transactionSync(op), vi.fn(), async () => ["primary-account"]);
  const row = () => store.sql.exec<{ count: number; earliest: number }>(
    "SELECT COUNT(*) count, MIN(baseline) earliest FROM tasks WHERE message_id LIKE 'native:%'").one();
  const input = () => store.ingest({
    id: "input", text: "input", channel: "wecom", account: "bot", chat: "alice", sender: "alice", group: false, context: "",
  })!;
  return { store, newNative, row, readPage, open: client.open, input, history: (events: Record<string, unknown>[]) => { history = events; } };
}

it("recovers 501 replies over two turns and commits each reply once", async () => {
  await runInDurableObject(env.MOBILE.getByName("history-pages-501"), async (_, state) => {
    const f = fixture(state);
    const native = f.newNative();
    await native.forward(f.input());
    f.store.sql.exec("UPDATE native_sessions SET cursor=10");
    f.history(Array.from({ length: 501 }, (_, i) => assistant(i + 11)));
    const first = native.sessions()[0];
    await native.collect(first);
    expect(f.readPage.mock.calls).toEqual([[10, 100], [110, 100], [210, 100]]);
    expect(f.row()).toMatchObject({ count: 300, earliest: 11 });
    expect(native.session(first.session)).toMatchObject({ cursor: 310, history_more: 1 });

    const restarted = f.newNative();
    await restarted.collect(restarted.sessions()[0]);
    expect(f.row()).toMatchObject({ count: 501, earliest: 11 });
    expect(restarted.session(first.session)).toMatchObject({ cursor: 511, history_more: 0 });
    await restarted.collect(restarted.sessions()[0]);
    expect(f.row().count).toBe(501);
  });
});

it("keeps the last committed page across a transport failure and accepts gaps and repeated events", async () => {
  await runInDurableObject(env.MOBILE.getByName("history-pages-interrupted"), async (_, state) => {
    const f = fixture(state);
    const native = f.newNative();
    await native.forward(f.input());
    const first = native.sessions()[0];
    f.readPage.mockReturnValueOnce({ chat_events: [assistant(4), assistant(7), assistant(7)], has_more: true });
    f.readPage.mockImplementationOnce(() => { throw new Error("transport_closed"); });
    await expect(native.collect(first)).rejects.toThrow("transport_closed");
    expect(native.session(first.session)).toMatchObject({ cursor: 7, history_more: 1 });
    expect(f.row()).toMatchObject({ count: 2, earliest: 4 });

    const restarted = f.newNative();
    f.readPage.mockReturnValueOnce({ chat_events: [assistant(7)], has_more: true });
    await expect(restarted.collect(first)).rejects.toThrow("history_page_no_progress");
    expect(restarted.session(first.session)?.cursor).toBe(7);
    f.readPage.mockReturnValueOnce({ chat_events: [assistant(8), { seq: "invalid" }], has_more: true });
    await expect(restarted.collect(first)).rejects.toThrow("history_page_invalid");
    expect(restarted.session(first.session)?.cursor).toBe(7);
    expect(f.row().count).toBe(2);
    f.history([assistant(4), assistant(7), assistant(11)]);
    await restarted.collect(first);
    expect(restarted.session(first.session)).toMatchObject({ cursor: 11, history_more: 0 });
    expect(f.row().count).toBe(3);
  });
});

it("finds final replies updated in place or emitted at a newer sequence after the cursor passed them", async () => {
  await runInDurableObject(env.MOBILE.getByName("history-pages-immature"), async (_, state) => {
    const f = fixture(state);
    const native = f.newNative();
    await native.forward(f.input());
    const binding = native.sessions()[0];
    const unfinished = [assistant(4, "running"), assistant(8, "running")];
    f.history([...unfinished, assistant(12)]);
    await native.collect(binding);
    expect(f.row().count).toBe(1);
    expect(native.session(binding.session)?.cursor).toBe(12);

    const restarted = f.newNative();
    f.history([assistant(4), unfinished[1], assistant(12), assistant(15, "completed", "m8")]);
    await restarted.collect(binding);
    expect(f.row().count).toBe(3);
    expect(restarted.session(binding.session)?.cursor).toBe(15);
    expect(f.store.sql.exec("SELECT * FROM native_pending_assistant").toArray()).toHaveLength(0);
    expect(f.readPage.mock.calls).toContainEqual([3, 1]);
  });
});

it("checks an older uncertain input from its original baseline without resending it or lowering the output cursor", async () => {
  await runInDurableObject(env.MOBILE.getByName("history-pages-legacy-receipt"), async (_, state) => {
    const f = fixture(state);
    const native = f.newNative();
    const task = f.input();
    f.open.mockRejectedValueOnce(new Error("transport_closed"));
    await native.forward(task);
    expect(f.store.task(task.id).state).toBe("unknown");
    f.store.sql.exec("UPDATE tasks SET baseline=10 WHERE id=?", task.id);
    f.store.sql.exec("UPDATE native_sessions SET cursor=500");
    const device = f.store.get<string>("device:" + task.id);
    f.history([
      ...Array.from({ length: 100 }, (_, i) => ({ seq: 11 + i, event_name: "delta.message_start" })),
      { seq: 112, event_name: "message.user", payload: { display_text: "input", metadata: { client_device_id: device } } },
      assistant(501),
    ]);
    const binding = native.sessions()[0];
    await native.collect(binding);
    expect(f.store.task(task.id).state).toBe("unknown");
    expect(native.session(binding.session)?.cursor).toBe(501);

    const restarted = f.newNative();
    await restarted.collect(binding);
    expect(f.readPage.mock.calls).toEqual([[500, 100], [10, 100], [501, 100], [110, 100]]);
    expect(f.store.task(task.id).state).toBe("submitted");
    expect(f.store.get("native-input:" + task.id)).toMatchObject({ event_seq: 112 });
    expect(native.session(binding.session)?.cursor).toBe(501);
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.row().count).toBe(1);
  });
});
