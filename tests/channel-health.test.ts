import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { channelHealth, inspectChannels } from "../src/channel-health";
import { handleRequest } from "../src/index";

const now = 1794811000000;
const seconds = now / 1000;

it("requires a fresh platform acknowledgment and does not extend its age on unrelated status writes", () => {
  expect(channelHealth({ connected: true, updated_at: seconds, last_platform_ok_at: seconds - 30 }, now))
    .toEqual({ state: "healthy", observed_at: now - 30000, valid_until: now + 120000 });
  expect(channelHealth({ connected: true, updated_at: seconds, last_platform_ok_at: seconds - 151 }, now).state).toBe("stale");
  expect(channelHealth({ connected: true, updated_at: seconds, last_platform_ok_at: null }, now).state).toBe("unknown");
  expect(channelHealth({ connected: true, updated_at: seconds, last_platform_ok_at: seconds + 1 }, now).state).toBe("unknown");
});

it("distinguishes an explicit disconnect and a recent legacy report from an expired or invalid record", () => {
  expect(channelHealth({ connected: false, updated_at: seconds - 20 }, now).state).toBe("disconnected");
  expect(channelHealth({ connected: true, updated_at: seconds - 20 }, now).state).toBe("reported");
  expect(channelHealth({ connected: true, updated_at: seconds - 150 }, now).state).toBe("stale");
  expect(channelHealth({ connected: false, updated_at: seconds + 50 }, now).state).toBe("unknown");
  expect(channelHealth({ connected: "true", updated_at: seconds }, now).state).toBe("unknown");
});

it("probes both fixed files independently and returns only whitelisted summary fields", async () => {
  const stamp = Math.floor(Date.now() / 1000);
  const call = vi.fn(async (path: string) => {
    if (path.includes("weixin-bot")) throw new Error("private exception");
    return { connected: true, updated_at: stamp, last_platform_ok_at: stamp, last_error: "private error" };
  });
  const report = await inspectChannels({ call });
  expect(report.weixin.state).toBe("unknown");
  expect(report.wecom.state).toBe("healthy");
  expect(JSON.stringify(report)).not.toContain("private");
  expect(call.mock.calls).toEqual([
    ["/media/raw/workspace/weixin-bot/state/status.json", 0, "GET", undefined, 4000],
    ["/media/raw/workspace/wecom-bot/state/status.json", 0, "GET", undefined, 4000],
  ]);
});

it("requires the admin key and does not offer a caller-selected status path", async () => {
  const admin = "a-different-test-admin-key-of-sufficient-length";
  const bindings = { ...env, MUSE_ADMIN_KEY: admin };
  const dispatch = vi.fn(async () => Response.json({ fixture: true }));
  const make = (path: string, key: string, method = "GET") => new Request("https://live.test" + path, {
    method, headers: { Authorization: "Bearer " + key },
  });
  expect((await handleRequest(make("/admin/channels", env.DEMO_KEY), bindings, dispatch)).status).toBe(401);
  expect((await handleRequest(make("/admin/channels?path=other", admin), bindings, dispatch)).status).toBe(400);
  expect((await handleRequest(make("/admin/channels", admin, "POST"), bindings, dispatch)).status).toBe(404);
  expect(dispatch).not.toHaveBeenCalled();
  expect((await handleRequest(make("/admin/channels", admin), bindings, dispatch)).status).toBe(200);
  expect(dispatch.mock.calls).toHaveLength(1);
});

it("publishes only cached labels without authentication, upstream access, or alarm scheduling", async () => {
  const bindings = { ...env, MUSE_ADMIN_KEY: "a-different-test-admin-key-of-sufficient-length" };
  const stub = env.CREDENTIALS.getByName("public-channel-health");
  await runInDurableObject(stub, async (instance, state) => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    try {
      const dispatch = vi.fn((forwarded: Request) => instance.fetch(forwarded));
      const url = "https://live.test/channel-health";
      const read = (path = url, method = "GET") => handleRequest(new Request(path, { method }), bindings, dispatch);
      expect((await read(url + "?path=other")).status).toBe(400);
      expect((await read(url, "POST")).status).toBe(404);
      expect(dispatch).not.toHaveBeenCalled();
      expect(await (await read()).json()).toEqual({ weixin: "unknown", wecom: "unknown" });

      const at = Date.now();
      state.storage.sql.exec("INSERT INTO service_events VALUES (?,?)", "channel_health", JSON.stringify({
        at, data: {
          weixin: { state: "healthy", observed_at: at - 30_000, valid_until: at + 120_000 },
          wecom: { state: "healthy", observed_at: at - 180_000, valid_until: at - 30_000 },
        },
      }));
      expect(await (await read()).json()).toEqual({ weixin: "healthy", wecom: "stale" });
      expect(upstream).not.toHaveBeenCalled();
      expect(await state.storage.getAlarm()).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });
});
