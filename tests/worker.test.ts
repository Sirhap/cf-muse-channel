import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleRequest } from "../src/index";
import { CookieController, type CredentialState } from "../src/muse";

const key = "test-key-that-is-longer-than-thirty-two-characters";
const bindings: Env = {
  ...env, DEMO_KEY: key, MUSE_COOKIE: "hatch_sess=test-cookie", MUSE_VM_ID: "vm-test",
  MUSE_COOKIE_PART_1: "", MUSE_COOKIE_PART_2: "",
};

let state: CredentialState | undefined;
const worker = {
  fetch(request: Request, bindings: Env) {
    const controller = new CookieController(bindings, {
      load: () => state && structuredClone(state),
      save: (value) => { state = structuredClone(value); },
    });
    return handleRequest(request, bindings, (forwarded) => controller.fetch(forwarded));
  },
};
beforeEach(() => { state = undefined; });

function request(path: string, method = "POST", headers: HeadersInit = {}): Request {
  return new Request(`https://demo.test${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, ...headers },
  });
}

function authFetch(last: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/api/session") return Response.json({ vm_id: "vm-test" });
    if (url.pathname === "/api/auth/check") {
      expect(new Headers(init?.headers).get("Cookie")).toBe(bindings.MUSE_COOKIE);
      expect(new Headers(init?.headers).get("Sec-Fetch-Site")).toBe("same-origin");
      return Response.json({ access_token: "access-secret" });
    }
    if (url.pathname === "/api/hatch/token") {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access-secret");
      expect(JSON.parse(init?.body as string).vmName).toBe("vm-test");
      return Response.json({ token: "hatch-secret" });
    }
    return last(url, init);
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("authenticated Muse relay", () => {
  it("rejects unauthorized requests before making any upstream calls", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await worker.fetch(new Request("https://demo.test/probe/cookie", { method: "POST" }), bindings);
    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects weak or missing demo keys", async () => {
    for (const invalid of ["short", "x".repeat(513), "white space".repeat(4)]) {
      const response = await worker.fetch(request("/probe/network"), { ...bindings, DEMO_KEY: invalid });
      expect(response.status).toBe(401);
    }
  });

  it("rejects a wrong or oversized bearer before contacting Muse", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const invalid of ["wrong-token-with-thirty-two-characters", "x".repeat(513)]) {
      const response = await worker.fetch(request("/probe/cookie", "POST", { Authorization: `Bearer ${invalid}` }), bindings);
      expect(response.status).toBe(401);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not accept credentials or custom upstream destinations in query parameters", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await worker.fetch(request("/ws?target=https://other.test&token=secret", "GET"), bindings);
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports HTTP 403 as an upstream response, not a successful authentication", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));
    const response = await worker.fetch(request("/probe/network"), bindings);
    expect(response.status).toBe(502);
    const body = await response.json<{ checks: { status: number; response_received: boolean }[] }>();
    expect(body.checks).toHaveLength(3);
    expect(body.checks.every((check) => check.response_received && check.status === 403)).toBe(true);
  });

  it("fails the network probe when every destination is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network unavailable"); }));
    const response = await worker.fetch(request("/probe/network"), bindings);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it("requires a configured Cookie and never silently skips authentication", async () => {
    const response = await worker.fetch(request("/probe/cookie"), { ...bindings, MUSE_COOKIE: "" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ stage: "configuration", error: "cookie_not_configured" });
    const { MUSE_COOKIE: _cookie, ...withoutCookie } = bindings;
    // Missing production secret: the runtime can omit a binding declared by generated types.
    const missing = await worker.fetch(request("/probe/cookie"), withoutCookie as Env);
    expect(missing.status).toBe(503);
  });

  it("does not echo upstream response bodies or exception messages containing secrets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("hatch_sess=private", { status: 401 })));
    const response = await worker.fetch(request("/probe/cookie"), bindings);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, stage: "/api/auth/check", error: "upstream_http_error", upstream_status: 401 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("https://upstream/?auth_token=private"); }));
    const failed = await worker.fetch(request("/probe/cookie"), bindings);
    expect(await failed.text()).not.toContain("private");
  });

  it("refuses redirects rather than forwarding the Cookie to a different origin", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { Location: "https://other.test/" } });
    });
    vi.stubGlobal("fetch", fetcher);
    expect((await worker.fetch(request("/probe/cookie"), bindings)).status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds upstream authentication JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(256 * 1024 + 1))));
    const response = await worker.fetch(request("/probe/cookie"), bindings);
    expect(await response.json()).toMatchObject({ error: "response_too_large" });
  });

  it("discovers the VM then exchanges credentials in order, exposing only the failing stage", async () => {
    const fetcher = authFetch((url, init) => {
      expect(url.hostname).toBe("hatch.metaaivm.com");
      expect(url.searchParams.get("auth_token")).toBe("hatch-secret");
      expect(new Headers(init?.headers).get("Cookie")).toBeNull();
      return new Response("private upstream payload", { status: 403 });
    });
    vi.stubGlobal("fetch", fetcher);
    const response = await worker.fetch(request("/probe/cookie"), { ...bindings, MUSE_VM_ID: "" });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(await response.json()).toEqual({ ok: false, stage: "websocket", error: "upgrade_failed", upstream_status: 403 });
  });

  it("reassembles a Cookie split across Secrets before authentication", async () => {
    vi.stubGlobal("fetch", authFetch(() => new Response("denied", { status: 403 })));
    const response = await worker.fetch(request("/probe/cookie"), {
      ...bindings, MUSE_COOKIE: "hatch_sess=stale", MUSE_COOKIE_PART_1: "hatch_sess=", MUSE_COOKIE_PART_2: "test-cookie",
    });
    expect(await response.json()).toMatchObject({ stage: "websocket", error: "upgrade_failed" });
  });

  it("passes binary WebSocket frames without decoding or modifying Noise payloads", async () => {
    const pair = new WebSocketPair();
    pair[1].binaryType = "arraybuffer";
    pair[1].accept();
    pair[1].addEventListener("message", (event) => pair[1].send(event.data));
    vi.stubGlobal("fetch", authFetch(() => new Response(null, { status: 101, webSocket: pair[0] })));
    const response = await worker.fetch(request("/ws", "GET", { Upgrade: "websocket" }), bindings);
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.binaryType = "arraybuffer";
    socket.accept();
    const reply = new Promise<MessageEvent>((resolve) => socket.addEventListener("message", resolve, { once: true }));
    socket.send(new Uint8Array([0, 1, 128, 255]).buffer);
    expect(Array.from(new Uint8Array((await reply).data as ArrayBuffer))).toEqual([0, 1, 128, 255]);
    socket.close(1000, "Test complete");
  });
});
