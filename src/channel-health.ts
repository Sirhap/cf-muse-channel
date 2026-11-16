import type { MuseRpc } from "./noise";

const WINDOW_MS = 150_000; // WeChat long poll is 45s; WeCom pings every 30s.
const CLOCK_SKEW_MS = 5_000;
const channels = ["weixin", "wecom"] as const;
type Channel = typeof channels[number];
type ChannelHealth = {
  state: "healthy" | "reported" | "disconnected" | "stale" | "unknown";
  observed_at: number | null;
  valid_until: number | null;
};
export type ChannelHealthReport = Record<Channel, ChannelHealth>;
const unknown = (): ChannelHealth => ({ state: "unknown", observed_at: null, valid_until: null });

export function unknownChannels(): ChannelHealthReport {
  return { weixin: unknown(), wecom: unknown() };
}

function timestamp(value: unknown, now: number): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  const millis = value * 1000;
  return millis <= now + CLOCK_SKEW_MS ? millis : null;
}

/** Accept a healthy reading only with a fresh successful Tencent acknowledgment. */
export function channelHealth(value: unknown, now = Date.now()): ChannelHealth {
  if (!value || typeof value !== "object" || !("connected" in value) || typeof value.connected !== "boolean"
      || !("updated_at" in value)) return unknown();
  const updated = timestamp(value.updated_at, now);
  if (updated === null) return unknown();
  if (now >= updated + WINDOW_MS) return { state: "stale", observed_at: updated, valid_until: null };
  if (!value.connected) return { state: "disconnected", observed_at: updated, valid_until: updated + WINDOW_MS };
  if (!("last_platform_ok_at" in value)) return { state: "reported", observed_at: updated, valid_until: updated + WINDOW_MS };
  const acknowledgment = timestamp(value.last_platform_ok_at, now);
  if (acknowledgment === null || acknowledgment > updated) return unknown();
  if (now >= acknowledgment + WINDOW_MS) return { state: "stale", observed_at: acknowledgment, valid_until: null };
  return { state: "healthy", observed_at: acknowledgment, valid_until: acknowledgment + WINDOW_MS };
}

/** Read only the two fixed gateway files. Never return the files or error text to the browser. */
export async function inspectChannels(rpc: Pick<MuseRpc, "call">): Promise<ChannelHealthReport> {
  const results = unknownChannels();
  for (const channel of channels) {
    try {
      const data = await rpc.call(`/media/raw/workspace/${channel}-bot/state/status.json`, 0, "GET", undefined, 4000);
      results[channel] = channelHealth(data);
    } catch { /* Failure to read one gateway must not hide the other. */ }
  }
  return results;
}
