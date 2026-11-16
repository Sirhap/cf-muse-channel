import { json } from "./http";
import { MuseRpc } from "./noise";
import { applySetCookies, initialCookies, cookieHeader, type CookieJar } from "./cookies";

const MUSE_ORIGIN = "https://muse.ai";
const GATEWAY_ORIGIN = "https://hatch.metaaivm.com";
const MAX_JSON_BYTES = 256 * 1024;

type SafeFailure = { stage: string; error: string; upstream_status?: number };
export interface CredentialState {
  seed: string;
  cookies: CookieJar;
  importedAt?: number;
  lastCheckedAt: number | null;
  lastVerifiedAt: number | null;
  lastRotatedAt: number | null;
  lastError: SafeFailure | null;
  needsLogin: boolean;
}

export interface CredentialStore {
  load(): CredentialState | undefined;
  save(state: CredentialState): void;
}

interface CookieSession {
  header(): string;
  apply(headers: string[]): void;
  verified(): void;
}

/** Own serialized access to a durable credential store; no CF admin token is needed. */
export class CookieController {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly env: Env, private readonly store: CredentialStore) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private persist(state: CredentialState): void {
    try {
      this.store.save(state);
    } catch {
      // SQLite/adapter errors may include bound credential values.
      throw new ProbeError("storage", "persistence_failed");
    }
  }

  private async seedConfig() {
    const hasParts = Boolean(this.env.MUSE_COOKIE_PART_1);
    if (hasParts && typeof this.env.MUSE_COOKIE_PART_2 !== "string") {
      throw new ProbeError("configuration", "cookie_parts_incomplete");
    }
    const cookie = (hasParts
      ? `${this.env.MUSE_COOKIE_PART_1}${this.env.MUSE_COOKIE_PART_2}`
      : this.env.MUSE_COOKIE ?? "").trim();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([cookie, this.env.MUSE_VM_ID ?? ""])));
    const seed = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { cookie, seed };
  }

  private async state(): Promise<CredentialState> {
    const { cookie, seed } = await this.seedConfig();
    const previous = this.store.load();
    if (previous?.seed === seed) return previous;
    if (!cookie) throw new ProbeError("configuration", "cookie_not_configured");
    const state: CredentialState = {
      seed, cookies: initialCookies(cookie), lastCheckedAt: null, lastVerifiedAt: null,
      lastRotatedAt: null, lastError: null, needsLogin: false,
    };
    this.persist(state);
    return state;
  }

  private session(state: CredentialState, checkpoint = (next: CredentialState) => this.persist(next)): CookieSession {
    return {
      header: () => cookieHeader(state.cookies),
      apply: (headers) => {
        const cookies = applySetCookies(state.cookies, headers);
        if (JSON.stringify(cookies) === JSON.stringify(state.cookies)) return;
        const next = { ...state, cookies, lastRotatedAt: Date.now() };
        checkpoint(next);
        Object.assign(state, next);
      },
      verified: () => {
        const next = { ...state, lastVerifiedAt: Date.now(), lastError: null, needsLogin: false };
        checkpoint(next);
        Object.assign(state, next);
      },
    };
  }

  private status(state: CredentialState) {
    return {
      ok: state.lastVerifiedAt !== null && state.lastError === null && !state.needsLogin,
      configured: true, needs_login: state.needsLogin,
      last_checked_at: state.lastCheckedAt, last_verified_at: state.lastVerifiedAt,
      last_rotated_at: state.lastRotatedAt, last_error: state.lastError,
      last_imported_at: state.importedAt ?? null,
    };
  }

  private failure(error: unknown): ProbeError {
    return error instanceof ProbeError ? error : new ProbeError("internal", "internal_error");
  }

  private failed(state: CredentialState, failure: ProbeError): void {
    state.lastError = { stage: failure.stage, error: failure.code, upstream_status: failure.upstreamStatus };
    // A generic 403 can be an origin/proxy denial; do not mislabel it as expired credentials.
    state.needsLogin = state.needsLogin || (failure.stage === "/api/auth/check" && failure.upstreamStatus === 401);
    this.persist(state);
  }

  /** Verify the candidate in memory. Publish the entire new jar in one write after a real RPC. */
  replaceCookies(cookies: CookieJar): Promise<Response> {
    return this.exclusive(async () => {
      let rpc: MuseRpc | undefined;
      try {
        const { seed } = await this.seedConfig();
        const candidate: CredentialState = {
          seed, cookies, lastCheckedAt: Date.now(), lastVerifiedAt: null,
          lastRotatedAt: null, lastError: null, needsLogin: false,
        };
        const upstream = await connectMuse(this.session(candidate, () => {}), this.env);
        try {
          rpc = await MuseRpc.connect(upstream.webSocket!);
          await rpc.call("/api/session/list", 0);
        } catch {
          throw new ProbeError("noise_rpc", "verification_failed");
        }
        candidate.importedAt = Date.now();
        candidate.lastVerifiedAt = candidate.importedAt;
        this.persist(candidate);
        return json(this.status(candidate));
      } catch (error) {
        const failure = this.failure(error);
        return json({ ok: false, error: "cookie_not_saved",
          last_error: { stage: failure.stage, error: failure.code, upstream_status: failure.upstreamStatus } }, 502);
      } finally { rpc?.close(); }
    });
  }

  adminStatus(): Promise<Response> {
    return this.exclusive(async () => {
      try { return json(this.status(await this.state())); }
      catch (error) {
        const failure = this.failure(error);
        if (failure.code === "cookie_not_configured") return json({ ok: false, configured: false, needs_login: false });
        return json({ ok: false, error: failure.code }, 503);
      }
    });
  }

  /** Daily renewal and authenticated manual checks share the exact rotation path. */
  refresh() {
    return this.exclusive(async () => {
      let state: CredentialState | undefined;
      try {
        state = await this.state();
        if (state.needsLogin) return this.status(state);
        state.lastCheckedAt = Date.now();
        this.persist(state);
        const session = this.session(state);
        const result = await authJson("/api/auth/check", session, { method: "POST", body: "" });
        requiredString(result, "access_token", "/api/auth/check");
        session.verified();
        return this.status(state);
      } catch (error) {
        const failure = this.failure(error);
        if (state) {
          this.failed(state, failure);
          return this.status(state);
        }
        return { ok: false, configured: false, needs_login: false, last_checked_at: null,
          last_verified_at: null, last_rotated_at: null,
          last_error: { stage: failure.stage, error: failure.code } };
      }
    });
  }

  /** Worker-owned RPC shares the same serialized Cookie rotation boundary. */
  useRpc<T>(operation: (rpc: MuseRpc) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const state = await this.state();
      if (state.needsLogin) throw new ProbeError("configuration", "cookie_requires_login");
      state.lastCheckedAt = Date.now(); this.persist(state);
      let rpc: MuseRpc | undefined;
      try {
        const upstream = await connectMuse(this.session(state), this.env);
        rpc = await MuseRpc.connect(upstream.webSocket!);
        return await operation(rpc);
      } catch (error) {
        this.failed(state, this.failure(error));
        throw new Error("worker_rpc_failed");
      } finally { rpc?.close(); }
    });
  }

  fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/credentials/refresh") {
      return this.refresh().then((status) => json(status, status.ok ? 200 : 502));
    }
    return this.exclusive(async () => {
      let state: CredentialState | undefined;
      try {
        state = await this.state();
        if (new URL(request.url).pathname === "/credentials/status") return json(this.status(state));
        if (state.needsLogin) return json({ ok: false, error: "cookie_requires_login", needs_login: true }, 503);
        state.lastCheckedAt = Date.now();
        this.persist(state);
        const upstream = await connectMuse(this.session(state), this.env);
        if (new URL(request.url).pathname === "/probe/cookie") {
          upstream.webSocket!.accept();
          upstream.webSocket!.close(1000, "Probe complete");
          return json({ ok: true, stage: "cookie_and_websocket", noise_rpc_verified: false,
            note: "Cookie exchange and WebSocket upgrade passed; run the Python client to verify Noise RPC." });
        }
        return new Response(null, { status: 101, webSocket: upstream.webSocket });
      } catch (error) {
        const failure = this.failure(error);
        if (state) this.failed(state, failure);
        return json({ ok: false, stage: failure.stage, error: failure.code, upstream_status: failure.upstreamStatus },
          failure.stage === "configuration" ? 503 : 502);
      }
    });
  }
}

export class ProbeError extends Error {
  constructor(
    readonly stage: string,
    readonly code: string,
    readonly upstreamStatus?: number,
  ) {
    super(code);
  }
}

/** Read bounded auth JSON. Upstream payloads and exception messages never leave this boundary. */
async function authJson(path: string, session: CookieSession, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", session.header());
  // Match the existing pinned Muse client's HTTP contract.
  headers.set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36");
  headers.set("Origin", MUSE_ORIGIN);
  headers.set("Referer", `${MUSE_ORIGIN}/`);
  headers.set("Sec-Fetch-Site", "same-origin");
  headers.set("Sec-Fetch-Mode", "cors");
  headers.set("Sec-Fetch-Dest", "empty");
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${MUSE_ORIGIN}${path}`, {
      ...init, headers, redirect: "manual", signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ProbeError(path, "network_failed");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProbeError(path, "upstream_http_error", response.status);
  }
  // Persist rotation immediately: a later JSON/read failure must not lose a new ticket.
  session.apply(response.headers.getSetCookie());
  const reader = response.body?.getReader();
  if (!reader) throw new ProbeError(path, "empty_response");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new ProbeError(path, "response_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError(path, "invalid_json");
  } finally {
    reader.releaseLock();
  }
}

function requiredString(record: Record<string, unknown>, field: string, stage: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) throw new ProbeError(stage, `missing_${field}`);
  return value;
}

/** Exchange credentials and open the real Noise WebSocket without submitting a user task. */
async function connectMuse(session: CookieSession, env: Env): Promise<Response> {
  let vmId = env.MUSE_VM_ID;
  if (!vmId) {
    const info = await authJson("/api/session", session);
    vmId = requiredString(info, "vm_id", "/api/session");
  }
  const auth = await authJson("/api/auth/check", session, { method: "POST", body: "" });
  const accessToken = requiredString(auth, "access_token", "/api/auth/check");
  session.verified();
  const hatch = await authJson("/api/hatch/token", session, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ vmAddress: `wss://${vmId}.metaaivm.com/`, vmName: vmId }),
  });
  const url = new URL("/v1/noise", GATEWAY_ORIGIN);
  url.searchParams.set("vm_id", vmId);
  url.searchParams.set("auth_token", requiredString(hatch, "token", "/api/hatch/token"));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { Upgrade: "websocket", Origin: MUSE_ORIGIN },
      redirect: "manual", signal: controller.signal,
    });
  } catch {
    throw new ProbeError("websocket", "network_failed");
  } finally {
    clearTimeout(timeout);
  }
  if (upstream.status !== 101 || !upstream.webSocket) {
    await upstream.body?.cancel();
    throw new ProbeError("websocket", "upgrade_failed", upstream.status);
  }
  return upstream;
}
