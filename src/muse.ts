import { json } from "./http";
import { MuseRpc } from "./noise";
import { applySetCookies, initialCookies, cookieHeader, type CookieJar } from "./cookies";
import { MANAGED_MUSE_SOCKET, MUSE_VM_HEADER } from "./managed/muse-owner";

const MUSE_ORIGIN = "https://muse.ai";
const GATEWAY_ORIGIN = "https://hatch.metaaivm.com";
const MAX_JSON_BYTES = 256 * 1024;
/** 短效 access_token 内存缓存窗口，减少多连接并发或重连时的重复 auth/check RTT。 */
const ACCESS_TOKEN_TTL_MS = 45_000;

type SafeFailure = { stage: string; error: string; upstream_status?: number };
export interface CredentialState {
  seed: string;
  cookies: CookieJar;
  vmId?: string;
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
  setVmId?(vmId: string): void;
}

/** 负责串行保护持久化 Cookie 轮换；WebSocket 升级与 Noise RPC 移出互斥锁以避免互相阻塞。 */
export class CookieController {
  private pending: Promise<void> = Promise.resolve();
  private cachedSeed?: { key: string; cookie: string; seed: string };
  private cachedVmId?: { seed: string; id: string };
  private cachedAccess?: { seed: string; token: string; expiresAt: number };

  constructor(
    private readonly env: Env,
    private readonly store: CredentialStore,
    private readonly isIsolated: () => boolean = () => false,
  ) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private clearAuthCaches() {
    this.cachedAccess = undefined;
    this.cachedVmId = undefined;
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
    if (this.isIsolated()) {
      return { cookie: "", seed: "isolated-account-seed" };
    }
    const hasParts = Boolean(this.env.MUSE_COOKIE_PART_1);
    if (hasParts && typeof this.env.MUSE_COOKIE_PART_2 !== "string") {
      throw new ProbeError("configuration", "cookie_parts_incomplete");
    }
    const cookie = (hasParts
      ? `${this.env.MUSE_COOKIE_PART_1}${this.env.MUSE_COOKIE_PART_2}`
      : this.env.MUSE_COOKIE ?? "").trim();
    const key = JSON.stringify([cookie, this.env.MUSE_VM_ID ?? ""]);
    if (this.cachedSeed?.key === key) return { cookie: this.cachedSeed.cookie, seed: this.cachedSeed.seed };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const seed = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    this.cachedSeed = { key, cookie, seed };
    return { cookie, seed };
  }

  private async state(): Promise<CredentialState> {
    const { cookie, seed } = await this.seedConfig();
    const previous = this.store.load();
    if (previous?.seed === seed) return previous;
    this.clearAuthCaches();
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
        const now = Date.now();
        const next = { ...state, lastCheckedAt: now, lastVerifiedAt: now, lastError: null, needsLogin: false };
        checkpoint(next);
        Object.assign(state, next);
      },
      setVmId: (vmId: string) => {
        if (!vmId || state.vmId === vmId) return;
        const next = { ...state, vmId };
        checkpoint(next);
        Object.assign(state, next);
      },
    };
  }

  private status(state: CredentialState) {
    return {
      ok: state.lastVerifiedAt !== null && state.lastError === null && !state.needsLogin,
      configured: true, needs_login: state.needsLogin,
      vm_id: state.vmId ?? null,
      last_checked_at: state.lastCheckedAt, last_verified_at: state.lastVerifiedAt,
      last_rotated_at: state.lastRotatedAt, last_error: state.lastError,
      last_imported_at: state.importedAt ?? null,
    };
  }

  private failure(error: unknown): ProbeError {
    return error instanceof ProbeError ? error : new ProbeError("internal", "internal_error");
  }

  private failed(state: CredentialState, failure: ProbeError): void {
    if (failure.stage === "/api/auth/check" || failure.stage === "/api/hatch/token" || failure.stage === "/api/session") {
      this.cachedAccess = undefined;
    }
    state.lastCheckedAt = Date.now();
    state.lastError = { stage: failure.stage, error: failure.code, upstream_status: failure.upstreamStatus };
    // A generic 403 can be an origin/proxy denial; do not mislabel it as expired credentials.
    state.needsLogin = state.needsLogin || (failure.stage === "/api/auth/check" && failure.upstreamStatus === 401);
    this.persist(state);
  }

  private async recordExternalFailure(seed: string, failure: ProbeError): Promise<void> {
    await this.exclusive(async () => {
      const current = this.store.load();
      if (!current || current.seed !== seed) return;
      this.failed(current, failure);
    });
  }

  private async recordExternalSuccess(seed: string): Promise<void> {
    await this.exclusive(async () => {
      const current = this.store.load();
      if (!current || current.seed !== seed || !current.lastError) return;
      const now = Date.now();
      this.persist({ ...current, lastCheckedAt: now, lastVerifiedAt: now, lastError: null, needsLogin: false });
    });
  }

  /** 在串行边界内换取短期 Noise 建连 URL（含 Cookie 轮换落盘），之后立即释放锁。 */
  private async prepareNoiseUrl(
    session: CookieSession,
    seed: string,
    allowAccessCache: boolean,
    persistedVmId?: string,
  ): Promise<{ url: URL; vmId: string; accessToken: string; cookieHeader: string }> {
    const envVmId = this.isIsolated() ? "" : (this.env.MUSE_VM_ID ?? "");
    let vmId = envVmId || persistedVmId || (this.cachedVmId?.seed === seed ? this.cachedVmId.id : "");
    let fromCache = Boolean(vmId && !envVmId);
    if (!vmId) {
      const info = await authJson("/api/session", session);
      vmId = extractVmId(info);
      session.setVmId?.(vmId);
    }
    const cachedToken = allowAccessCache && this.cachedAccess?.seed === seed && Date.now() < this.cachedAccess.expiresAt
      ? this.cachedAccess.token : null;
    let accessToken = cachedToken;
    let hatch: Record<string, unknown>;
    if (accessToken) {
      try {
        hatch = await requestHatchToken(session, vmId, accessToken);
      } catch (error) {
        if (error instanceof ProbeError && (error.upstreamStatus === 401 || error.upstreamStatus === 403)) {
          this.cachedAccess = undefined;
          accessToken = null;
          hatch = {};
        } else if (error instanceof ProbeError && fromCache && (error.upstreamStatus === 400 || error.upstreamStatus === 404)) {
          this.cachedVmId = undefined;
          const info = await authJson("/api/session", session);
          vmId = extractVmId(info);
          session.setVmId?.(vmId);
          fromCache = false;
          hatch = await requestHatchToken(session, vmId, accessToken);
        } else {
          throw error;
        }
      }
    } else {
      hatch = {};
    }
    if (!accessToken) {
      const auth = await authJson("/api/auth/check", session, { method: "POST", body: "" });
      accessToken = requiredString(auth, "access_token", "/api/auth/check");
      session.verified();
      try {
        hatch = await requestHatchToken(session, vmId, accessToken);
      } catch (error) {
        if (error instanceof ProbeError && fromCache && (error.upstreamStatus === 400 || error.upstreamStatus === 404)) {
          this.cachedVmId = undefined;
          const info = await authJson("/api/session", session);
          vmId = extractVmId(info);
          session.setVmId?.(vmId);
          hatch = await requestHatchToken(session, vmId, accessToken);
        } else {
          throw error;
        }
      }
    }
    const url = new URL("/v1/noise", GATEWAY_ORIGIN);
    url.searchParams.set("vm_id", vmId);
    url.searchParams.set("auth_token", requiredString(hatch, "token", "/api/hatch/token"));
    return { url, vmId, accessToken, cookieHeader: session.header() };
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
        const prepared = await this.prepareNoiseUrl(this.session(candidate, () => {}), seed, false);
        let vmSleeping = false;
        try {
          const upstream = await openNoiseWithAutoWake(prepared.url, prepared.vmId, prepared.cookieHeader, prepared.accessToken);
          try {
            rpc = await MuseRpc.connect(upstream.webSocket!);
            await rpc.call("/api/session/list", 0);
          } catch {
            throw new ProbeError("noise_rpc", "verification_failed");
          }
        } catch (wsError) {
          if (isVmSleepingError(wsError)) {
            // Cookie 已通过 /api/auth/check、/api/session 与 /api/hatch/token 校验，502/503/504 仅表示该账号 VM 容器当前休眠或冷启动中
            vmSleeping = true;
          } else {
            throw wsError;
          }
        }
        candidate.vmId = prepared.vmId;
        candidate.importedAt = Date.now();
        candidate.lastCheckedAt = candidate.importedAt;
        candidate.lastVerifiedAt = candidate.importedAt;
        this.persist(candidate);
        this.cachedVmId = { seed, id: prepared.vmId };
        this.cachedAccess = { seed, token: prepared.accessToken, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS };
        return json({ ...this.status(candidate), ...(vmSleeping ? { vm_sleeping: true } : {}) });
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

  /** Public metadata only. Read the current record without initializing or renewing it. */
  async publicCookieState() {
    const { cookie, seed } = await this.seedConfig();
    const saved = this.store.load();
    if (!saved || saved.seed !== seed) return cookie ? "unverified" : "unconfigured";
    if (saved.needsLogin) return "needs_login";
    return this.status(saved).ok && cookieHeader(saved.cookies) ? "healthy" : "unverified";
  }

  /** Only the dedicated administrator route may export the Cookie used by the next connection. */
  showCurrentCookie(): Promise<Response> {
    return this.exclusive(async () => {
      try {
        const cookie = cookieHeader((await this.state()).cookies);
        return cookie ? json({ cookie }) : json({ error: "cookie_not_configured" }, 404);
      } catch (error) {
        const { code } = this.failure(error);
        return json({ error: code }, code === "cookie_not_configured" ? 404 : 503);
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
        const session = this.session(state);
        const result = await authJson("/api/auth/check", session, { method: "POST", body: "" });
        const accessToken = requiredString(result, "access_token", "/api/auth/check");
        session.verified();
        this.cachedAccess = { seed: state.seed, token: accessToken, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS };
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

  /** Worker-owned RPC：仅在 Cookie 换证阶段持有串行锁，WS 握手与业务 RPC 在锁外执行避免阻塞其他连接。 */
  async useRpc<T>(operation: (rpc: MuseRpc) => Promise<T>): Promise<T> {
    const prepared = await this.exclusive(async () => {
      let state: CredentialState | undefined;
      try {
        state = await this.state();
        if (state.needsLogin) throw new ProbeError("configuration", "cookie_requires_login");
        const result = await this.prepareNoiseUrl(this.session(state), state.seed, true, state.vmId);
        this.cachedVmId = { seed: state.seed, id: result.vmId };
        this.cachedAccess = { seed: state.seed, token: result.accessToken, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS };
        return {
          url: result.url,
          vmId: result.vmId,
          cookieHeader: result.cookieHeader,
          accessToken: result.accessToken,
          seed: state.seed,
        };
      } catch (error) {
        const failure = this.failure(error);
        if (state && failure.code !== "cookie_requires_login") this.failed(state, failure);
        if (failure.code === "cookie_requires_login") throw failure;
        throw new Error("worker_rpc_failed");
      }
    });
    let rpc: MuseRpc | undefined;
    try {
      const upstream = await openNoiseWithAutoWake(prepared.url, prepared.vmId, prepared.cookieHeader, prepared.accessToken);
      rpc = await MuseRpc.connect(upstream.webSocket!);
      const outcome = await operation(rpc);
      await this.recordExternalSuccess(prepared.seed);
      return outcome;
    } catch (error) {
      await this.recordExternalFailure(prepared.seed, this.failure(error));
      throw new Error("worker_rpc_failed");
    } finally { rpc?.close(); }
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/credentials/refresh") {
      return this.refresh().then((status) => json(status, status.ok ? 200 : 502));
    }
    const isProbe = pathname === "/probe/cookie";
    const step = await this.exclusive(async (): Promise<{ response: Response } | { url: URL; vmId: string; cookieHeader: string; accessToken: string; seed: string }> => {
      let state: CredentialState | undefined;
      try {
        state = await this.state();
        if (pathname === "/credentials/status") return { response: json(this.status(state)) };
        if (state.needsLogin) return { response: json({ ok: false, error: "cookie_requires_login", needs_login: true }, 503) };
        const result = await this.prepareNoiseUrl(this.session(state), state.seed, !isProbe, state.vmId);
        this.cachedVmId = { seed: state.seed, id: result.vmId };
        this.cachedAccess = { seed: state.seed, token: result.accessToken, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS };
        return {
          url: result.url,
          vmId: result.vmId,
          cookieHeader: result.cookieHeader,
          accessToken: result.accessToken,
          seed: state.seed,
        };
      } catch (error) {
        const failure = this.failure(error);
        if (state) this.failed(state, failure);
        return { response: json({ ok: false, stage: failure.stage, error: failure.code, upstream_status: failure.upstreamStatus },
          failure.stage === "configuration" ? 503 : 502) };
      }
    });
    if ("response" in step) return step.response;
    try {
      const upstream = await openNoiseWithAutoWake(step.url, step.vmId, step.cookieHeader, step.accessToken);
      await this.recordExternalSuccess(step.seed);
      if (isProbe) {
        upstream.webSocket!.accept();
        upstream.webSocket!.close(1000, "Probe complete");
        return json({ ok: true, stage: "cookie_and_websocket", noise_rpc_verified: false,
          note: "Cookie exchange and WebSocket upgrade passed; run the Python client to verify Noise RPC." });
      }
      const headers = pathname === MANAGED_MUSE_SOCKET ? { [MUSE_VM_HEADER]: step.vmId } : undefined;
      return new Response(null, { status: 101, webSocket: upstream.webSocket, headers });
    } catch (error) {
      const failure = this.failure(error);
      await this.recordExternalFailure(step.seed, failure);
      return json({ ok: false, stage: failure.stage, error: failure.code, upstream_status: failure.upstreamStatus },
        failure.stage === "configuration" ? 503 : 502);
    }
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

/** 构造符合 Muse 官方同源校验（含 Sec-Fetch-* 与 pinned UA）的请求头。 */
function museRequestHeaders(cookieHeaderValue: string, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Cookie", cookieHeaderValue);
  headers.set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36");
  headers.set("Origin", MUSE_ORIGIN);
  headers.set("Referer", `${MUSE_ORIGIN}/`);
  headers.set("Sec-Fetch-Site", "same-origin");
  headers.set("Sec-Fetch-Mode", "cors");
  headers.set("Sec-Fetch-Dest", "empty");
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  return headers;
}

/** Read bounded auth JSON. Upstream payloads and exception messages never leave this boundary. */
async function authJson(path: string, session: CookieSession, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const headers = museRequestHeaders(session.header(), init.headers);
  const controller = new AbortController();
  // Keep the deadline through the body read and release it when the request is done.
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    let response: Response;
    try {
      response = await fetch(`${MUSE_ORIGIN}${path}`, {
        ...init, headers, redirect: "manual", signal: controller.signal,
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
  } finally {
    clearTimeout(timeout);
  }
}

function requiredString(record: Record<string, unknown>, field: string, stage: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) throw new ProbeError(stage, `missing_${field}`);
  return value;
}

/** 从 /api/session 响应中提取 vm_id，兼容顶层 vm_id 与 vms[] 列表结构。 */
function extractVmId(record: Record<string, unknown>): string {
  if (typeof record.vm_id === "string" && record.vm_id.trim()) {
    return record.vm_id.trim();
  }
  if (Array.isArray(record.vms)) {
    const items = record.vms.filter((v): v is Record<string, unknown> => Boolean(v && typeof v === "object"));
    const preferred = items.find((v) => v.is_preferred === true) ?? items[0];
    const nested = preferred && (typeof preferred.vm_id === "string" ? preferred.vm_id : typeof preferred.id === "string" ? preferred.id : "");
    if (nested && nested.trim()) return nested.trim();
  }
  throw new ProbeError("/api/session", "missing_vm_id");
}

function isVmSleepingError(error: unknown): boolean {
  return (
    error instanceof ProbeError
    && error.stage === "websocket"
    && (error.upstreamStatus === 502 || error.upstreamStatus === 503 || error.upstreamStatus === 504)
  );
}

/** 使用 access_token 换取一次性的 Noise 网关接入令牌。 */
function requestHatchToken(session: CookieSession, vmId: string, accessToken: string) {
  return authJson("/api/hatch/token", session, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ vmAddress: `wss://${vmId}.metaaivm.com/`, vmName: vmId }),
  });
}

/** 触发 Muse 官方休眠 VM 唤醒接口（POST /api/hatch/vm/wake）。 */
async function wakeMuseVm(vmId: string, cookieHeaderValue: string, accessToken?: string): Promise<boolean> {
  if (!vmId || !cookieHeaderValue) return false;
  const headers = museRequestHeaders(cookieHeaderValue);
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(`${MUSE_ORIGIN}/api/hatch/vm/wake`, {
      method: "POST",
      headers,
      body: JSON.stringify({ vm_id: vmId }),
      redirect: "manual",
      signal: controller.signal,
    });
    await resp.body?.cancel();
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/** 仅执行不带 Cookie 的 Noise WebSocket 升级，可在互斥锁外并发进行。 */
async function openNoiseWebSocket(url: URL): Promise<Response> {
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

/** 建立 Noise WebSocket 连接；当检测到休眠 VM (502/503/504) 时自动调用官方 /api/hatch/vm/wake 唤醒并重试。 */
async function openNoiseWithAutoWake(
  url: URL,
  vmId: string,
  cookieHeaderValue: string,
  accessToken?: string,
): Promise<Response> {
  try {
    return await openNoiseWebSocket(url);
  } catch (error) {
    if (!isVmSleepingError(error)) throw error;
    const woke = await wakeMuseVm(vmId, cookieHeaderValue, accessToken);
    if (!woke) throw error;
    let lastError: unknown = error;
    for (const delayMs of [2000, 3000]) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        return await openNoiseWebSocket(url);
      } catch (retryError) {
        lastError = retryError;
        if (!isVmSleepingError(retryError)) throw retryError;
      }
    }
    throw lastError;
  }
}
