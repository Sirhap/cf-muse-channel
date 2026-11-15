import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleRequest } from "../src/index";

const key = "test-key-that-is-longer-than-thirty-two-characters";
const bindings: Env = { ...env, DEMO_KEY: key };
function request(path: string, method: string, authorization = `Bearer ${key}`) {
  return new Request(`https://demo.test${path}`, { method, headers: { Authorization: authorization } });
}
afterEach(() => vi.unstubAllGlobals());

describe("public routing and failure boundaries", () => {
  it("health is public but reveals no credential state", async () => {
    const dispatch = vi.fn();
    const response = await handleRequest(new Request("https://demo.test/health"), bindings, dispatch);
    expect(await response.json()).toEqual({ ok: true, service: "cf-muse-channel", version: "1.0.0" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["/health", "POST"], ["/probe/network", "GET"], ["/probe/cookie", "GET"],
    ["/credentials/refresh", "GET"], ["/credentials/status", "POST"], ["/ws", "POST"],
    ["/credentials/status/", "GET"], ["/unknown", "GET"], ["/credentials/status", "DELETE"],
  ])("rejects unsupported route/method %s %s without dispatch", async (path, method) => {
    const dispatch = vi.fn();
    expect((await handleRequest(request(path, method), bindings, dispatch)).status).toBe(404);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["", "Basic abc", `bearer ${key}`, `Bearer ${key} extra`, "Bearer wrong"])(
    "rejects an invalid authentication scheme/value before contacting a DO", async (authorization) => {
      const dispatch = vi.fn();
      expect((await handleRequest(request("/credentials/status", "GET", authorization), bindings, dispatch)).status).toBe(401);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["/credentials/status", "GET"], ["/credentials/refresh", "POST"], ["/probe/cookie", "POST"],
  ])("dispatches an authorized %s once", async (path, method) => {
    const expected = Response.json({ fixture: true });
    const dispatch = vi.fn(async () => expected);
    const input = request(path, method);
    expect(await handleRequest(input, bindings, dispatch)).toBe(expected);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(input);
  });

  it("requires an Upgrade header before opening an upstream connection", async () => {
    const dispatch = vi.fn();
    expect((await handleRequest(request("/ws", "GET"), bindings, dispatch)).status).toBe(426);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("sanitizes a failed credential service instead of echoing exception data", async () => {
    const dispatch = vi.fn(async () => { throw new Error("hatch_sess=private; auth_token=private"); });
    const response = await handleRequest(request("/credentials/status", "GET"), bindings, dispatch);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "credential_service_unavailable" });
  });

  it("reports a partially unavailable network without calling the credential service", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("api.muse.ai")) throw new TypeError("failed");
      return new Response(null, { status: 200 });
    }));
    const dispatch = vi.fn();
    const response = await handleRequest(request("/probe/network", "POST"), bindings, dispatch);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
