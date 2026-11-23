import type { MuseRpc } from "../noise";
import { normalizeAllowedSandboxPath } from "./media";
import { MuseOwnerUnavailable, PRIMARY_ACCOUNT_ID, type MuseOwner, type OwnedRpc } from "./muse-owner";
import { failureCode, object, string, type Channel, type ChannelConfig, type Incoming } from "./protocol";
import { channelReply } from "./reply";
import type { ManagedStore } from "./store";

const MAX_OUTBOX_CHUNK = 256 * 1024;
const CHANNELS = ["weixin", "wecom"] as const;
type Commit = (operation: () => void) => void;
type RouteLookup = (channel: Channel, account: string, chat?: string, group?: boolean) => Incoming | null;

interface ParsedOutboxItem {
  route: Incoming;
  text: string;
  files: string[];
  fingerprint: string;
}

interface MissingWeixinContextItem {
  rowId: string;
  text: string;
  files: string[];
  fingerprint: string;
}
interface OutboxPosition {
  offset: number;
  namespace: string;
}

function byteOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function outboxPath(channel: Channel) {
  return `workspace/${channel}-bot/state/outbox.jsonl`;
}

/** 仅通过 CF 侧 Noise RPC（/fs/stats + HTTP Range 206）增量消费 VM 定时任务写入的 outbox.jsonl，支持文字与文件，并在微信缺少 context_token 时自动回退企微。 */
export class OutboxRelay {
  constructor(
    private store: ManagedStore,
    private rpc: OwnedRpc,
    private commit: Commit,
    private latestRoute: RouteLookup,
  ) {}

  offset(channel: Channel): number | null {
    const owner = this.store.get<MuseOwner>("outbox-source:" + channel);
    return owner ? this.position(channel, owner)?.offset ?? null : this.legacyOffset(channel);
  }

  status(channel: Channel): string {
    return this.store.get<string>("outbox-state:" + channel)
      ?? (this.legacyOffset(channel) === null ? "uninitialized" : "legacy_offset_unverified");
  }

  private recordState(channel: Channel, state: string) {
    const key = "outbox-state:" + channel;
    if (this.store.get<string>(key) !== state) this.store.set(key, state);
  }

  private legacyOffset(channel: Channel): number | null {
    const saved = this.store.get<number>("outbox_offset:" + channel);
    return byteOffset(saved) ? saved : null;
  }

  private positionKey(channel: Channel, owner: MuseOwner) {
    return "outbox-position:" + JSON.stringify([owner.account, owner.vm, channel]);
  }

  private position(channel: Channel, owner: MuseOwner) {
    return this.store.get<OutboxPosition>(this.positionKey(channel, owner));
  }

  private fileSize(stats: unknown, channel: Channel): number | null {
    const { entries } = object(stats);
    const path = outboxPath(channel);
    const entry = Array.isArray(entries) ? entries.map(object).find((row) =>
      row.path === path || string(row.path).endsWith("/" + path)) : undefined;
    return entry?.kind === "file" && byteOffset(entry.size) ? entry.size : null;
  }

  /** Resolve the actual primary VM and the migration inputs without changing either cursor. */
  inspect() {
    return this.rpc(async (client, owner) => {
      const stats = await client.call("/fs/stats", 0, "POST", { paths: CHANNELS.map(outboxPath) }, 10_000);
      return {
        vm_id: owner.vm,
        channels: Object.fromEntries(CHANNELS.map((channel) => [channel, {
          expected_offset: this.offset(channel),
          size: this.fileSize(stats, channel),
          state: this.status(channel),
        }])),
      };
    }, { account: PRIMARY_ACCOUNT_ID });
  }

  /** Attach an audited boundary to the current primary VM using the old offset as a compare-and-set guard. */
  async adopt(channel: Channel, expected: number | null, offset: number, vm: string, fileTasks: number[]) {
    const owner = { account: PRIMARY_ACCOUNT_ID, vm };
    return this.rpc(async (client) => {
      const size = this.fileSize(await client.call("/fs/stats", 0, "POST", { paths: [outboxPath(channel)] }, 10_000), channel);
      if (size === null || offset > size) return false;
      if (offset > 0) {
        const tail = await client.raw("/media/raw/" + outboxPath(channel), 0, "GET",
          { range: `bytes=${offset - 1}-${offset - 1}` }, 15_000, 4096);
        if (tail.status !== 206 || tail.body.length !== 1 || tail.body[0] !== 0x0a) return false;
      }
      let adopted = false;
      this.commit(() => {
        if (this.offset(channel) !== expected) return;
        const existing = this.store.get<MuseOwner>("outbox-source:" + channel);
        // A live source can only be replaced by a different VM, never rewound.
        if (existing?.vm === vm) return;
        const old = this.position(channel, owner);
        if (old && old.offset !== offset) return;
        for (const id of fileTasks) {
          const task = this.store.sql.exec<{ message_id: string }>(
            "SELECT t.message_id FROM tasks t JOIN outbound o ON o.task_id=t.id WHERE t.id=? AND o.state='pending'", id).toArray()[0];
          const origin = task?.message_id.replace(/^fallback:/, "") ?? "";
          if (!this.store.get<string[]>("outbound-files:" + id)?.length || this.store.get<MuseOwner>("outbound-owner:" + id)
              || !(origin.startsWith(`outbox:${channel}:`) || channel === "weixin" && origin.startsWith("outbox:wx-fallback:"))) return;
        }
        const namespace = old?.namespace ?? (!existing && this.legacyOffset(channel) !== null ? "" : crypto.randomUUID() + ":");
        this.store.set(this.positionKey(channel, owner), { offset, namespace });
        this.store.set("outbox-source:" + channel, owner);
        this.recordState(channel, "ready");
        for (const id of fileTasks) this.store.set("outbound-owner:" + id, owner);
        adopted = true;
      });
      return adopted;
    }, owner);
  }

  async sync(configs: Partial<Record<Channel, ChannelConfig | null>>): Promise<number> {
    const active = CHANNELS.filter((channel) => Boolean(configs[channel]?.enabled));
    if (!active.length) return 0;

    try {
      return await this.rpc((client, owner) => {
        if (owner.account !== PRIMARY_ACCOUNT_ID) throw new MuseOwnerUnavailable("muse_owner_mismatch");
        return this.scan(client, owner, active, configs);
      }, { account: PRIMARY_ACCOUNT_ID });
    } catch (error) {
      for (const channel of active) this.recordState(channel, failureCode(error));
      return 0;
    }
  }

  private async scan(client: MuseRpc, owner: MuseOwner, active: Channel[], configs: Partial<Record<Channel, ChannelConfig | null>>) {
    const stats = await client.call("/fs/stats", 0, "POST", { paths: active.map(outboxPath) }, 10_000);
    const batches: { channel: Channel; start: OutboxPosition; nextOffset: number; items: ParsedOutboxItem[] }[] = [];
    const weixinMissingContext: MissingWeixinContextItem[] = [];
    const wecomFingerprints = new Set<string>();

    for (const channel of active) {
      const config = configs[channel]!;
      const source = this.store.get<MuseOwner>("outbox-source:" + channel);
      if (!source && this.legacyOffset(channel) !== null) {
        this.recordState(channel, "legacy_offset_unverified");
        continue;
      }
      if (source && (source.account !== owner.account || source.vm !== owner.vm)) {
        this.recordState(channel, "muse_owner_mismatch");
        continue;
      }
      const size = this.fileSize(stats, channel);
      if (size === null) {
        this.recordState(channel, "file_unavailable");
        continue;
      }

      const key = this.positionKey(channel, owner);
      const position = this.position(channel, owner);
      this.recordState(channel, "ready");
      // 首次读取或同一 VM 文件截断时保留原有的末尾高水位语义。
      if (!position || size < position.offset) {
        this.commit(() => {
          this.store.set("outbox-source:" + channel, owner);
          this.store.set(key, { offset: size, namespace: position?.namespace ?? crypto.randomUUID() + ":" });
        });
        continue;
      }
      const saved = position.offset;
      if (size === saved) continue;

      const end = Math.min(size - 1, saved + MAX_OUTBOX_CHUNK - 1);
      const result = await client.raw("/media/raw/" + outboxPath(channel), 0, "GET",
        { range: `bytes=${saved}-${end}` }, 15_000, MAX_OUTBOX_CHUNK + 4096);
      if (result.status !== 206 && result.status !== 200) continue;

      // 服务端忽略 Range 返回整文件(200)时安全跳过，防止重放旧行。
      if (result.status === 200 && saved > 0) continue;

      const bytes = result.body;
      if (!bytes.length) continue;

      const newline = bytes.lastIndexOf(0x0a);
      if (newline < 0) {
        if (bytes.length >= MAX_OUTBOX_CHUNK) batches.push({ channel, start: position, nextOffset: saved + bytes.length, items: [] });
        continue;
      }
      const consumed = newline + 1;
      const nextOffset = saved + consumed;
      const textChunk = new TextDecoder().decode(bytes.subarray(0, consumed));
      const { items, missingContext } = this.parseLines(channel, config, textChunk, position);
      if (channel === "wecom") {
        for (const item of items) wecomFingerprints.add(item.fingerprint);
      } else {
        weixinMissingContext.push(...missingContext);
      }
      batches.push({ channel, start: position, nextOffset, items });
    }

    // 微信缺少 context_token 时，若企微已启用且本轮企微 outbox 未包含相同内容，自动经企微兜底送达。
    const wecomConfig = configs.wecom;
    const fallbackItems: ParsedOutboxItem[] = [];
    if (weixinMissingContext.length && wecomConfig?.enabled && wecomConfig.allowedSenders.length) {
      const target = wecomConfig.allowedSenders[0];
      const recentWecom = this.latestRoute("wecom", wecomConfig.account, target, false);
      for (const missed of weixinMissingContext) {
        if (wecomFingerprints.has(missed.fingerprint)) continue;
        fallbackItems.push({
          text: missed.text,
          files: missed.files,
          fingerprint: missed.fingerprint,
          route: {
            id: `outbox:wx-fallback:${missed.rowId}`,
            channel: "wecom",
            account: wecomConfig.account,
            chat: recentWecom?.chat ?? target,
            sender: recentWecom?.sender ?? target,
            group: false,
            text: missed.text || "[附件]",
            context: "",
          },
        });
      }
    }

    if (!batches.length) return 0;
    let queued = 0;
    this.commit(() => {
      if (batches.some(({ channel, start }) => this.store.get<MuseOwner>("outbox-source:" + channel)?.vm !== owner.vm
          || this.position(channel, owner)?.offset !== start.offset)) return;
      for (const batch of batches) {
        for (const item of batch.items) {
          const task = this.store.ingest(item.route);
          if (task) {
            this.store.complete(task, item.text ? channelReply(item.text) : "");
            if (item.files.length) this.store.setOutboundFiles(task.id, item.files, owner);
            queued++;
          }
        }
        this.store.set(this.positionKey(batch.channel, owner), { ...batch.start, offset: batch.nextOffset });
      }
      for (const fallback of fallbackItems) {
        const task = this.store.ingest(fallback.route);
        if (task) {
          this.store.complete(task, fallback.text ? channelReply(fallback.text) : "");
          if (fallback.files.length) this.store.setOutboundFiles(task.id, fallback.files, owner);
          this.store.set("outbox-fallback:weixin", { at: Date.now(), task_id: task.id, message_id: fallback.route.id });
          queued++;
        }
      }
    });
    return queued;
  }

  private parseLines(channel: Channel, config: ChannelConfig, chunk: string, position: OutboxPosition) {
    const items: ParsedOutboxItem[] = [];
    const missingContext: MissingWeixinContextItem[] = [];
    const lines = chunk.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const rawLine = lines[index].trim();
      if (!rawLine) continue;
      let parsed: Record<string, unknown>;
      try { parsed = object(JSON.parse(rawLine)); }
      catch { continue; }

      const mode = string(parsed.mode);
      if (mode !== "send" && mode !== "send_file") continue;

      const text = (string(parsed.content) || string(parsed.text)).trim();
      if (text.length > 16000) continue;

      const files: string[] = [];
      if (mode === "send_file") {
        const safePath = normalizeAllowedSandboxPath(string(parsed.file_path));
        if (safePath) files.push(safePath);
      }
      if (!text && !files.length) continue;

      const rowId = position.namespace + (string(parsed.id) || `${position.offset}-${index}`);
      const group = channel === "wecom" && (parsed.chat_type === 2 || parsed.chattype === "group");
      const rawTarget = channel === "weixin" ? string(parsed.to_user_id) : string(parsed.chatid);
      const target = rawTarget || config.allowedSenders[0];
      if (!target) continue;

      const recent = this.latestRoute(channel, config.account, target, group);
      if (group) {
        if (!recent) continue;
      } else if (!config.allowedSenders.includes(target)) {
        continue;
      }

      const fingerprint = `${text}\u0000${files.join(",")}`;
      const context = channel === "weixin" ? (recent?.context ?? "") : "";
      if (channel === "weixin" && !context) {
        this.store.set("outbox-skip:weixin", { at: Date.now(), reason: "weixin_context_unavailable", id: rowId });
        missingContext.push({ rowId, text, files, fingerprint });
        continue;
      }

      items.push({
        text,
        files,
        fingerprint,
        route: {
          id: `outbox:${channel}:${rowId}`,
          channel,
          account: config.account,
          chat: target,
          sender: recent?.sender ?? config.allowedSenders[0],
          group,
          text: text || "[附件]",
          context,
        },
      });
    }
    return { items, missingContext };
  }
}
