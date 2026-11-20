import type { MuseRpc } from "../noise";
import { normalizeAllowedSandboxPath } from "./media";
import { object, string, type Channel, type ChannelConfig, type Incoming } from "./protocol";
import { channelReply } from "./reply";
import type { ManagedStore } from "./store";

const MAX_OUTBOX_CHUNK = 256 * 1024;
type Rpc = <T>(operation: (client: MuseRpc) => Promise<T>) => Promise<T>;
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

export function outboxPath(channel: Channel) {
  return `workspace/${channel}-bot/state/outbox.jsonl`;
}

/** 仅通过 CF 侧 Noise RPC（/fs/stats + HTTP Range 206）增量消费 VM 定时任务写入的 outbox.jsonl，支持文字与文件，并在微信缺少 context_token 时自动回退企微。 */
export class OutboxRelay {
  constructor(
    private store: ManagedStore,
    private rpc: Rpc,
    private commit: Commit,
    private latestRoute: RouteLookup,
  ) {}

  offset(channel: Channel): number | null {
    const saved = this.store.get<number>("outbox_offset:" + channel);
    return typeof saved === "number" && Number.isSafeInteger(saved) && saved >= 0 ? saved : null;
  }

  async sync(configs: Partial<Record<Channel, ChannelConfig | null>>): Promise<number> {
    const active = (["weixin", "wecom"] as const).filter((channel) => Boolean(configs[channel]?.enabled));
    if (!active.length) return 0;

    let stats: Record<string, unknown>;
    try {
      stats = object(await this.rpc((client) => {
        if (typeof client.raw !== "function") return Promise.resolve({});
        return client.call("/fs/stats", 0, "POST", { paths: active.map(outboxPath) }, 10_000);
      }));
    } catch {
      return 0;
    }

    const entries = Array.isArray(stats.entries) ? stats.entries.map(object) : [];
    if (!entries.length) return 0;

    const batches: { channel: Channel; nextOffset: number; items: ParsedOutboxItem[] }[] = [];
    const weixinMissingContext: MissingWeixinContextItem[] = [];
    const wecomFingerprints = new Set<string>();

    for (const channel of active) {
      const config = configs[channel]!;
      const suffix = "/" + outboxPath(channel);
      const entry = entries.find((row) => {
        const path = string(row.path);
        return path === outboxPath(channel) || path.endsWith(suffix);
      });
      if (!entry || entry.kind !== "file") continue;
      const size = typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : null;
      if (size === null) continue;

      const saved = this.offset(channel);
      // 首次初始化或文件截断/轮转时，仅记录当前末尾为高水位，绝不重放历史旧行。
      if (saved === null || size < saved) {
        this.store.set("outbox_offset:" + channel, size);
        continue;
      }
      if (size === saved) continue;

      const end = Math.min(size - 1, saved + MAX_OUTBOX_CHUNK - 1);
      const result = await this.rpc((client) =>
        client.raw("/media/raw/" + outboxPath(channel), 0, "GET", { range: `bytes=${saved}-${end}` }, 15_000, MAX_OUTBOX_CHUNK + 4096));
      if (result.status !== 206 && result.status !== 200) continue;

      // 服务端忽略 Range 返回整文件(200)时安全跳过，防止重放旧行。
      if (result.status === 200 && saved > 0) continue;

      const bytes = result.body;
      if (!bytes.length) continue;

      const newline = bytes.lastIndexOf(0x0a);
      if (newline < 0) {
        if (bytes.length >= MAX_OUTBOX_CHUNK) this.store.set("outbox_offset:" + channel, saved + bytes.length);
        continue;
      }
      const consumed = newline + 1;
      const nextOffset = saved + consumed;
      const textChunk = new TextDecoder().decode(bytes.subarray(0, consumed));
      const { items, missingContext } = this.parseLines(channel, config, textChunk, saved);
      if (channel === "wecom") {
        for (const item of items) wecomFingerprints.add(item.fingerprint);
      } else {
        weixinMissingContext.push(...missingContext);
      }
      batches.push({ channel, nextOffset, items });
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
      for (const batch of batches) {
        for (const item of batch.items) {
          const task = this.store.ingest(item.route);
          if (task) {
            this.store.complete(task, item.text ? channelReply(item.text) : "");
            if (item.files.length) this.store.set("outbound-files:" + task.id, item.files);
            queued++;
          }
        }
        this.store.set("outbox_offset:" + batch.channel, batch.nextOffset);
      }
      for (const fallback of fallbackItems) {
        const task = this.store.ingest(fallback.route);
        if (task) {
          this.store.complete(task, fallback.text ? channelReply(fallback.text) : "");
          if (fallback.files.length) this.store.set("outbound-files:" + task.id, fallback.files);
          this.store.set("outbox-fallback:weixin", { at: Date.now(), task_id: task.id, message_id: fallback.route.id });
          queued++;
        }
      }
    });
    return queued;
  }

  private parseLines(channel: Channel, config: ChannelConfig, chunk: string, baseOffset: number) {
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

      const rowId = string(parsed.id) || `${baseOffset}-${index}`;
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
