import { afterEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import worker from "../src/index";
import { MuseCredentials } from "../src/credentials";
import { ManagedChannels } from "../src/managed/runtime";
import { CookieController, type CredentialState } from "../src/muse";
import { applySetCookies, cookieHeader, initialCookies } from "../src/cookies";

const bindings: Env = {
  ...env, DEMO_KEY: "test-key-that-is-longer-than-thirty-two-characters",
  MUSE_COOKIE: "hatch_sess=old; datr=keep", MUSE_VM_ID: "vm-test",
  MUSE_COOKIE_PART_1: "", MUSE_COOKIE_PART_2: "",
};

function memory() {
  let saved: CredentialState | undefined;
  return {
    load: () => saved && structuredClone(saved),
    save: (value: CredentialState) => { saved = structuredClone(value); },
  };
}

function rotated(value: string, body = JSON.stringify({ access_token: "private-access-token" })) {
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", "hatch_sess=; Max-Age=0; Path=/; Domain=.muse.ai; Secure; HttpOnly");
  headers.append("Set-Cookie", `hatch_sess=${value}; Max-Age=2592000; Path=/; Domain=.muse.ai; Secure; HttpOnly`);
  return new Response(body, { headers });
}

afterEach(() => vi.unstubAllGlobals());

describe("durable Cookie renewal", () => {
  it("applies delete-then-set in header order and preserves other cookies", () => {
    const jar = applySetCookies(initialCookies("hatch_sess=old; datr=keep"), rotated("new").headers.getSetCookie(), 1000);
    expect(cookieHeader(jar, 1001)).toBe("datr=keep; hatch_sess=new");
    expect(jar.hatch_sess.expiresAt).toBe(1000 + 2592000 * 1000);
  });

  it("honors expires and never broadens cookies from another domain or path", () => {
    const jar = applySetCookies(initialCookies("datr=keep; remove=old"), [
      "remove=gone; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
      "bad=secret; Domain=other.test; Path=/",
      "scoped=secret; Path=/private",
      "fresh=ok; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/",
    ], 1000);
    expect(cookieHeader(jar, 1001)).toBe("datr=keep; fresh=ok");
  });

  it("persists renewal and uses the new ticket after the controller is recreated", async () => {
    const store = memory();
    vi.stubGlobal("fetch", vi.fn(async () => rotated("new-ticket")));
    const first = await new CookieController(bindings, store).refresh();
    expect(first.ok).toBe(true);
    expect(first.last_rotated_at).not.toBeNull();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Cookie")).toBe("datr=keep; hatch_sess=new-ticket");
      return Response.json({ access_token: "next-token" });
    });
    vi.stubGlobal("fetch", fetcher);
    expect((await new CookieController(bindings, store).refresh()).ok).toBe(true);
  });

  it("serializes concurrent refreshes so an old cookie cannot overwrite a newer one", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("Cookie")!);
      await Promise.resolve();
      return rotated(`ticket-${seen.length}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const store = memory();
    const controller = new CookieController(bindings, store);
    const result = await Promise.all([controller.refresh(), controller.refresh()]);
    expect(result.every((item) => item.ok)).toBe(true);
    expect(seen).toEqual(["hatch_sess=old; datr=keep", "datr=keep; hatch_sess=ticket-1"]);
    expect(cookieHeader(store.load()!.cookies)).toBe("datr=keep; hatch_sess=ticket-2");
  });

  it("retains a rotated Cookie even if the auth response body is unreadable", async () => {
    const store = memory();
    vi.stubGlobal("fetch", vi.fn(async () => rotated("saved-before-json", "not json")));
    const status = await new CookieController(bindings, store).refresh();
    expect(status.ok).toBe(false);
    expect(status.last_error?.error).toBe("invalid_json");
    expect(cookieHeader(store.load()!.cookies)).toContain("hatch_sess=saved-before-json");
  });

  it.each([200, 403])("clears the request deadline after a completed auth response (%i)", async (code) => {
    vi.useFakeTimers();
    const nativeTimeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ access_token: "test-token" }, { status: code }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const pending = new CookieController(bindings, memory()).refresh();
      const result = await pending;
      expect(result.ok).toBe(code === 200);
      const signal = fetcher.mock.calls[0][1]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(signal?.aborted).toBe(false);
    } finally {
      nativeTimeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps credentials on a network error without labeling them expired", async () => {
    const store = memory();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("private-token-in-url"); }));
    const status = await new CookieController(bindings, store).refresh();
    expect(status.ok).toBe(false);
    expect(status.needs_login).toBe(false);
    expect(status.last_error?.error).toBe("network_failed");
    expect(JSON.stringify(status)).not.toContain("private-token");
    expect(cookieHeader(store.load()!.cookies)).toBe(bindings.MUSE_COOKIE);
  });

  it("stops automatic checks after an explicit auth 401 until the imported seed changes", async () => {
    const store = memory();
    const denied = vi.fn(async () => new Response("private-body", { status: 401 }));
    vi.stubGlobal("fetch", denied);
    const controller = new CookieController(bindings, store);
    expect((await controller.refresh()).needs_login).toBe(true);
    expect((await controller.refresh()).needs_login).toBe(true);
    expect(denied).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "restored" })));
    expect((await new CookieController({ ...bindings, MUSE_COOKIE: "hatch_sess=reimported" }, store).refresh()).ok).toBe(true);
  });

  it("does not classify a generic 403 as an expired Cookie", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    const status = await new CookieController(bindings, memory()).refresh();
    expect(status.needs_login).toBe(false);
    expect(status.last_error?.upstream_status).toBe(403);
  });

  it("protects manual renewal and never returns cookies or tokens in status", async () => {
    const controller = new CookieController(bindings, memory());
    const dispatch = vi.fn((request: Request) => controller.fetch(request));
    const { handleRequest } = await import("../src/index");
    const unauthorized = await handleRequest(new Request("https://demo.test/credentials/refresh", { method: "POST" }), bindings, dispatch);
    expect(unauthorized.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => rotated("hidden-cookie-value")));
    await controller.refresh();
    const status = await controller.fetch(new Request("https://demo.test/credentials/status"));
    const text = await status.text();
    expect(text).not.toContain("hidden-cookie-value");
    expect(text).not.toContain("private-access-token");
    expect(text).not.toContain("hatch_sess");
  });

  it("stores rotation in actual Durable Object SQL, with no secret returned over RPC", async () => {
    const stub = env.CREDENTIALS.getByName("renewal-sql-test");
    await runInDurableObject(stub, async (instance, state) => {
      vi.stubGlobal("fetch", vi.fn(async () => rotated("sql-cookie")));
      const result = await instance.refresh();
      expect(result.ok).toBe(true);
      const row = state.storage.sql.exec<{ value: string }>("SELECT value FROM credential_state WHERE id=1").one();
      expect(JSON.parse(row.value).cookies.hatch_sess.value).toBe("sql-cookie");
      expect(JSON.stringify(result)).not.toContain("sql-cookie");
    });
  });

  it("routes authenticated public status through the actual Worker and DO", async () => {
    const response = await SELF.fetch("https://demo.test/credentials/status", {
      headers: { Authorization: `Bearer ${bindings.DEMO_KEY}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: true, needs_login: false });
  });

  it("uses rotated cookies for the immediately following hatch-token request", async () => {
    const controller = new CookieController(bindings, memory());
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/auth/check") return rotated("fresh-for-hatch");
      expect(url.pathname).toBe("/api/hatch/token");
      expect(new Headers(init?.headers).get("Cookie")).toBe("datr=keep; hatch_sess=fresh-for-hatch");
      return new Response(null, { status: 403 });
    });
    vi.stubGlobal("fetch", fetcher);
    const response = await controller.fetch(new Request("https://demo.test/probe/cookie", { method: "POST" }));
    expect(await response.json()).toMatchObject({ stage: "/api/hatch/token", upstream_status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("the scheduled handler renews credentials without calling a chat endpoint", async () => {
    const refresh = vi.fn(async () => ({ ok: true, last_error: null }));
    const getByName = vi.fn(() => ({ scheduledRenewal: refresh }));
    const cronEnv = { CREDENTIALS: { getByName } } as Env;
    await worker.scheduled({} as ScheduledController, cronEnv);
    expect(getByName).toHaveBeenCalledWith("primary-account");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("restores lost approval and channel alarms without starting Cookie renewal", async () => {
    const approvals = env.CREDENTIALS.getByName("watchdog-approvals");
    const channels = env.MOBILE.getByName("watchdog-channels");
    const refresh = vi.fn(async () => ({ ok: true, last_error: null }));
    const enabled = { ...env, AUTO_APPROVAL_ENABLED: "true", MANAGED_CHANNELS_ENABLED: "true" };
    const cronEnv = {
      ...enabled,
      CREDENTIALS: { getByName: () => ({
        scheduledRenewal: refresh,
        ensureAlarm: () => runInDurableObject(approvals, (_instance, state) =>
          new MuseCredentials(state, enabled).ensureAlarm()),
      }) },
      MOBILE: { getByName: () => ({
        ensureAlarm: () => runInDurableObject(channels, (_instance, state) =>
          new ManagedChannels(state, enabled).ensureAlarm()),
      }) },
    } as unknown as Env;

    const event = { cron: "*/5 * * * *", scheduledTime: Date.now() } as ScheduledController;
    await runInDurableObject(channels, async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO config VALUES (?, ?)", "wecom", JSON.stringify({ enabled: true }));
    });
    const alarmTimes = () => Promise.all([
      runInDurableObject(approvals, (_instance, state) => state.storage.getAlarm()),
      runInDurableObject(channels, (_instance, state) => state.storage.getAlarm()),
    ]);
    expect(await alarmTimes()).toEqual([null, null]);

    await worker.scheduled(event, cronEnv);
    const restored = await alarmTimes();
    expect(restored.every((value) => value !== null)).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    await worker.scheduled(event, cronEnv);
    expect(await alarmTimes()).toEqual(restored);
  });

  it("a failed approval watchdog check does not prevent restoring the channel alarm", async () => {
    const ensureApprovals = vi.fn(async () => { throw new Error("approval DO unavailable"); });
    const ensureChannels = vi.fn(async () => true);
    const refresh = vi.fn(async () => ({ ok: true }));
    const cronEnv = {
      ...env, AUTO_APPROVAL_ENABLED: "true", MANAGED_CHANNELS_ENABLED: "true",
      CREDENTIALS: { getByName: () => ({ ensureAlarm: ensureApprovals, scheduledRenewal: refresh }) },
      MOBILE: { getByName: () => ({ ensureAlarm: ensureChannels }) },
    } as unknown as Env;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await worker.scheduled({ cron: "*/5 * * * *" } as ScheduledController, cronEnv);
      expect(ensureApprovals).toHaveBeenCalledOnce();
      expect(ensureChannels).toHaveBeenCalledOnce();
      expect(refresh).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("approval_alarm_watchdog_failed"));
    } finally {
      warn.mockRestore();
    }
  });
});
