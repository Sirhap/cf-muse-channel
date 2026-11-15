import { afterEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { CookieController, type CredentialState } from "../src/muse";

const bindings: Env = {
  ...env, MUSE_COOKIE: "hatch_sess=old", MUSE_VM_ID: "vm-test",
  MUSE_COOKIE_PART_1: "", MUSE_COOKIE_PART_2: "",
};
function memory() {
  let saved: CredentialState | undefined;
  return { load: () => saved && structuredClone(saved), save: (value: CredentialState) => { saved = structuredClone(value); } };
}
function input() { return new Request("https://demo.test/probe/cookie", { method: "POST" }); }
afterEach(() => vi.unstubAllGlobals());

describe("credential failure matrix and persistence", () => {
  it.each([
    ["null", "invalid_json"], ["[]", "invalid_json"], ["not json", "invalid_json"],
    ["{}", "missing_access_token"], ['{"access_token":0}', "missing_access_token"],
    ['{"access_token":" "}', "missing_access_token"],
  ])("classifies malformed auth JSON %s without claiming verification", async (body, code) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    const status = await new CookieController(bindings, memory()).refresh();
    expect(status.ok).toBe(false);
    expect(status.last_verified_at).toBeNull();
    expect(status.last_error?.error).toBe(code);
  });

  it.each([302, 401, 403, 429, 500, 503])("preserves the Cookie after auth HTTP %i", async (status) => {
    const store = memory();
    const headers = new Headers({ "Set-Cookie": "hatch_sess=; Max-Age=0; Path=/" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private upstream body", { status, headers })));
    const result = await new CookieController(bindings, store).refresh();
    expect(result.ok).toBe(false);
    expect(result.last_error?.upstream_status).toBe(status);
    expect(result.needs_login).toBe(status === 401);
    expect(store.load()!.cookies.hatch_sess.value).toBe("old");
    expect(JSON.stringify(result)).not.toContain("private upstream body");
  });

  it("reports a missing Cookie part before any network request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { MUSE_COOKIE_PART_2: _part, ...partial } = bindings;
    const response = await new CookieController({ ...partial, MUSE_COOKIE_PART_1: "hatch_sess=old" } as Env, memory()).fetch(input());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "cookie_parts_incomplete" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("recovers after a network failure without poisoning the serialized request queue", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(Response.json({ access_token: "valid" }));
    vi.stubGlobal("fetch", fetcher);
    const controller = new CookieController(bindings, memory());
    expect((await controller.refresh()).ok).toBe(false);
    expect((await controller.refresh()).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("serializes twenty overlapping renewals using the preceding ticket", async () => {
    let count = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Cookie")).toBe(`hatch_sess=${count ? `ticket-${count}` : "old"}`);
      count += 1;
      return Response.json({ access_token: "not-returned" }, {
        headers: { "Set-Cookie": `hatch_sess=ticket-${count}; Max-Age=60; Path=/` },
      });
    }));
    const controller = new CookieController(bindings, memory());
    const results = await Promise.all(Array.from({ length: 20 }, () => controller.refresh()));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(count).toBe(20);
  });

  it("keeps rotation if reading the response stream fails", async () => {
    const store = memory();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("private stream failure")); },
    }), { headers: { "Set-Cookie": "hatch_sess=saved; Max-Age=60; Path=/" } })));
    const result = await new CookieController(bindings, store).refresh();
    expect(result.ok).toBe(false);
    expect(store.load()!.cookies.hatch_sess.value).toBe("saved");
    expect(JSON.stringify(result)).not.toContain("private stream failure");
  });

  it("never leaks a storage exception through the renewal RPC", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "valid" })));
    const store = memory();
    await new CookieController(bindings, store).refresh();
    store.save = () => { throw new Error("hatch_sess=storage-secret"); };
    await expect(new CookieController(bindings, store).refresh()).rejects.not.toThrow("storage-secret");
  });

  it.each(["/api/session", "/api/hatch/token", "websocket"])("reports the correct failing stage %s", async (stage) => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === stage || (stage === "websocket" && path === "/v1/noise")) return new Response(null, { status: 403 });
      if (path === "/api/session") return Response.json({ vm_id: "vm-test" });
      if (path === "/api/auth/check") return Response.json({ access_token: "valid" });
      return Response.json({ token: "private-hatch-token" });
    }));
    const response = await new CookieController({ ...bindings, MUSE_VM_ID: "" }, memory()).fetch(input());
    expect(await response.json()).toMatchObject({ stage, upstream_status: 403 });
  });

  it("writes the newest ticket into real SQL before reporting success", async () => {
    const stub = env.CREDENTIALS.getByName("sql-preserves-cookie");
    await runInDurableObject(stub, async (instance, state) => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "first" }, {
        headers: { "Set-Cookie": "hatch_sess=durably-saved; Path=/; Max-Age=300" },
      })));
      expect((await instance.refresh()).ok).toBe(true);
      const rows = state.storage.sql.exec<{ value: string }>("SELECT value FROM credential_state WHERE id=1").toArray();
      expect(JSON.parse(rows[0].value).cookies.hatch_sess.value).toBe("durably-saved");
    });
  });
});
