import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { OutboxRelay, outboxPath } from "../src/managed/outbox";
import { MuseOwnerUnavailable, type OwnedRpc } from "../src/managed/muse-owner";
import { ManagedStore } from "../src/managed/store";
import type { MuseRpc } from "../src/noise";

it("does not replay unchanged outbox rows after connecting to a smaller VM", async () => {
  await runInDurableObject(env.MOBILE.getByName("codegraph-outbox-repro"), async (_, state) => {
    const store = new ManagedStore(state.storage.sql);
    const row = (id: string) => JSON.stringify({ id, mode: "send", chatid: "alice", content: id }) + "\n";
    const original = row("historical-A") + row("historical-B");
    const other = row("historical-X");
    let current = original;
    const client = {
      call: async () => ({
        entries: [{ kind: "file", path: outboxPath("wecom"), size: new TextEncoder().encode(current).length }],
      }),
      raw: async (_path: string, _service: number, _method: string, headers: Record<string, string>) => {
        const match = /^bytes=(\d+)-(\d+)$/.exec(headers.range)!;
        return { status: 206, body: new TextEncoder().encode(current).slice(Number(match[1]), Number(match[2]) + 1) };
      },
    } as unknown as MuseRpc;
    const relay = new OutboxRelay(store, op => op(client, { account: "primary-account", vm: current === other ? "vm-b" : "vm-a" }), op => state.storage.transactionSync(op), () => null);
    const cfg = { wecom: { enabled: true, account: "bot", allowedSenders: ["alice"], secret: "test" } };
    expect(await relay.sync(cfg)).toBe(0);
    current = other;
    expect(await relay.sync(cfg)).toBe(0);
    expect(relay.status("wecom")).toBe("muse_owner_mismatch");
    current = original;
    expect(await relay.sync(cfg)).toBe(0);
    expect(store.sql.exec("SELECT text FROM outbound").toArray()).toHaveLength(0);
    current += row("new");
    expect(await relay.sync(cfg)).toBe(1);
    expect(store.sql.exec("SELECT text FROM outbound").toArray()).toEqual([{ text: "new" }]);
  });
});

it("pauses an unaudited legacy offset and adopts only a complete boundary on the expected VM", async () => {
  await runInDurableObject(env.MOBILE.getByName("outbox-adopt-offset"), async (_, state) => {
    const store = new ManagedStore(state.storage.sql);
    const owner = { account: "primary-account", vm: "vm-primary" };
    const old = '{"id":"old","mode":"send","content":"old"}\n';
    const next = '{"id":"new","mode":"send_file","file_path":"workspace/new.txt","content":"new"}\n';
    const file = new TextEncoder().encode(old + next);
    const rpc: OwnedRpc = (op, target) => {
      if (target && "vm" in target && target.vm !== owner.vm) throw new MuseOwnerUnavailable("muse_owner_mismatch");
      return op({
        call: async () => ({ entries: [{ kind: "file", path: outboxPath("wecom"), size: file.length }] }),
        raw: async (_path: string, _service: number, _method: string, headers: Record<string, string>) => {
          const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(headers.range)!;
          return { status: 206, body: file.slice(Number(start), Number(end) + 1) };
        },
      } as unknown as MuseRpc, owner);
    };
    const relay = new OutboxRelay(store, rpc, op => state.storage.transactionSync(op), () => null);
    const cfg = { wecom: { enabled: true, account: "bot", allowedSenders: ["alice"], secret: "test" } };
    store.set("outbox_offset:wecom", old.length);
    expect(await relay.sync(cfg)).toBe(0);
    expect(relay.status("wecom")).toBe("legacy_offset_unverified");
    await expect(relay.adopt("wecom", old.length, old.length, "wrong-vm", [])).rejects.toThrow("muse_owner_mismatch");
    expect(await relay.adopt("wecom", old.length, old.length - 1, owner.vm, [])).toBe(false);
    expect(await relay.adopt("wecom", 0, old.length, owner.vm, [])).toBe(false);
    expect(await relay.adopt("wecom", old.length, old.length, owner.vm, [])).toBe(true);
    expect(await relay.sync(cfg)).toBe(1);
    expect(await relay.sync(cfg)).toBe(0);
    const outbound = store.sql.exec<{ task_id: number; text: string }>("SELECT task_id,text FROM outbound").one();
    expect(outbound.text).toBe("new");
    expect(store.get("outbound-owner:" + outbound.task_id)).toEqual(owner);
    expect(relay.offset("wecom")).toBe(file.length);
  });
});
