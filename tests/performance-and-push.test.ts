import { x25519 } from "@noble/curves/ed25519";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";
import { ManagedChannels } from "../src/managed/runtime";
import { ManagedStore } from "../src/managed/store";
import { NativeConversations } from "../src/managed/native";
import { OutboxRelay } from "../src/managed/outbox";
import type { Incoming } from "../src/managed/protocol";
import { CookieController, type CredentialState } from "../src/muse";
import { MuseRpc } from "../src/noise";
import { bytesField as b, fields, getBytes, getNumber, join, numberField as n, utf8 } from "../src/wire";

const DEMO_KEY = "test-key-that-is-longer-than-thirty-two-characters";

async function sha256(data: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(data)));
}
async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", Uint8Array.from(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, Uint8Array.from(data)));
}
async function hkdf2(key: Uint8Array, data: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  const t = await hmac(key, data);
  const first = await hmac(t, Uint8Array.of(1));
  return [first, await hmac(t, join(first, Uint8Array.of(2)))];
}
async function aesGcm(keyBytes: Uint8Array, nonce: bigint, data: Uint8Array, ad: Uint8Array, decrypt = false) {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(keyBytes), "AES-GCM", false, [decrypt ? "decrypt" : "encrypt"]);
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, nonce, false);
  return new Uint8Array(await crypto.subtle[decrypt ? "decrypt" : "encrypt"](
    { name: "AES-GCM", iv, additionalData: Uint8Array.from(ad), tagLength: 128 },
    key,
    Uint8Array.from(data),
  ));
}

/** 轻量 Noise XX 响应端，用于在真实 WebSocketPair 上测试 MuseRpc 多路复用与帧排空。 */
function startNoiseServer(server: WebSocket, onRequest: (streamId: number, path: string, sendFrame: (streamId: number, body: string, end?: boolean, status?: number) => Promise<void>) => Promise<void>) {
  server.binaryType = "arraybuffer";
  let stage = 0;
  let chaining = new Uint8Array();
  let transcript = new Uint8Array();
  let key: Uint8Array | null = null;
  let handshakeNonce = 0n;
  let recvKey = new Uint8Array();
  let sendKey = new Uint8Array();
  let recvNonce = 0n;
  let sendNonce = 0n;
  let sendChain: Promise<void> = Promise.resolve();
  let recvChain: Promise<void> = Promise.resolve();
  const ephemeral = crypto.getRandomValues(new Uint8Array(32));
  const staticKey = crypto.getRandomValues(new Uint8Array(32));

  const mixHash = async (data: Uint8Array) => { transcript = await sha256(join(transcript, data)); };
  const mixKey = async (data: Uint8Array) => {
    const [nextC, nextK] = await hkdf2(chaining, data);
    chaining = nextC; key = nextK; handshakeNonce = 0n;
  };
  const encryptH = async (plain: Uint8Array) => {
    const out = key ? await aesGcm(key, handshakeNonce++, plain, transcript, false) : plain;
    await mixHash(out);
    return out;
  };
  const decryptH = async (cipher: Uint8Array) => {
    const out = key ? await aesGcm(key, handshakeNonce++, cipher, transcript, true) : cipher;
    await mixHash(cipher);
    return out;
  };
  const sendFrame = (streamId: number, body: string, end = true, status = 200) => {
    const job = sendChain.then(async () => {
      const resp = join(n(1, status), b(3, body), n(4, end ? 1 : 0));
      const frame = join(n(1, streamId), b(3, resp));
      const svc = join(b(1, frame));
      const transport = join(n(1, BigInt(streamId)), n(2, 0), n(3, 1), b(4, svc));
      const encrypted = await aesGcm(sendKey, sendNonce++, transport, new Uint8Array(), false);
      server.send(Uint8Array.from(encrypted).buffer);
    });
    sendChain = job.then(() => undefined, () => undefined);
    return job;
  };

  server.addEventListener("message", (event) => {
    const raw = new Uint8Array(event.data as ArrayBuffer);
    recvChain = recvChain.then(async () => {
      if (stage === 0) {
        const name = utf8.encode("Noise_XX_25519_AESGCM_SHA256");
        transcript = name.length <= 32 ? join(name, new Uint8Array(32 - name.length)) : await sha256(name);
        chaining = transcript;
        await mixHash(new Uint8Array());
        const re = raw.slice(0, 32);
        await mixHash(re);
        await decryptH(raw.slice(32));
        const ePub = x25519.getPublicKey(ephemeral);
        await mixHash(ePub);
        await mixKey(x25519.getSharedSecret(ephemeral, re));
        const encS = await encryptH(x25519.getPublicKey(staticKey));
        await mixKey(x25519.getSharedSecret(staticKey, re));
        const encPayload = await encryptH(new Uint8Array());
        server.send(Uint8Array.from(join(ePub, encS, encPayload)).buffer);
        stage = 1;
      } else if (stage === 1) {
        const rs = await decryptH(raw.slice(0, 48));
        await mixKey(x25519.getSharedSecret(ephemeral, rs));
        await decryptH(raw.slice(48));
        // Initiator 的 [send, receive] 对应 Responder 的 [recv, send]
        const [initSend, initRecv] = await hkdf2(chaining, new Uint8Array());
        recvKey = initSend;
        sendKey = initRecv;
        stage = 2;
      } else {
        const plain = await aesGcm(recvKey, recvNonce++, raw, new Uint8Array(), true);
        const transport = fields(plain);
        const envelope = fields(getBytes(transport, 4));
        const frame = fields(getBytes(envelope, 2));
        const streamId = Number(getNumber(frame, 1));
        const req = fields(getBytes(frame, 2));
        const path = new TextDecoder().decode(getBytes(req, 2));
        void onRequest(streamId, path, sendFrame);
      }
    });
  });
  server.accept();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MuseRpc 多路复用与未消费流自动排空", () => {
  it("open(/chat/stream) 收到 300 个流式帧不撑爆连接，后续 call 立即成功且支持乱序并发", async () => {
    const [clientSocket, serverSocket] = Object.values(new WebSocketPair());
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    startNoiseServer(serverSocket, async (streamId, path, sendFrame) => {
      if (path === "/chat/stream") {
        // 模拟服务端持续推送 300 帧（远超旧上限 128 帧）
        for (let i = 0; i < 300; i++) {
          await sendFrame(streamId, JSON.stringify({ delta: i }), i === 299);
        }
        return;
      }
      if (path === "/slow") {
        await firstGate;
        await sendFrame(streamId, JSON.stringify({ ok: true, result: { which: "slow" } }), true);
        return;
      }
      if (path === "/fast") {
        await sendFrame(streamId, JSON.stringify({ ok: true, result: { which: "fast" } }), true);
        releaseFirst();
        return;
      }
      if (path === "/range-test") {
        await sendFrame(streamId, "gold", true, 206);
      }
    });

    const rpc = await MuseRpc.connect(clientSocket);
    try {
      await rpc.open("/chat/stream", 0, "POST", { text: "hello" });
      // 并发发起慢请求与快请求，服务端先回 /fast 再回 /slow
      const [slow, fast, partial] = await Promise.all([
        rpc.call("/slow", 0, "GET"),
        rpc.call("/fast", 0, "GET"),
        rpc.raw("/range-test", 0, "GET", { range: "bytes=0-3" }),
      ]);
      expect(slow).toEqual({ which: "slow" });
      expect(fast).toEqual({ which: "fast" });
      expect(partial.status).toBe(206);
      expect(new TextDecoder().decode(partial.body)).toBe("gold");
    } finally {
      rpc.close();
      serverSocket.close();
    }
  });
});

describe("CookieController 锁粒度优化与短效 access_token 缓存", () => {
  const bindings: Env = {
    ...env,
    DEMO_KEY,
    MUSE_COOKIE: "hatch_sess=init; datr=keep",
    MUSE_VM_ID: "vm-perf",
    MUSE_COOKIE_PART_1: "",
    MUSE_COOKIE_PART_2: "",
  };

  function memoryStore() {
    let saved: CredentialState | undefined;
    return {
      load: () => saved && structuredClone(saved),
      save: (value: CredentialState) => { saved = structuredClone(value); },
    };
  }

  it("WebSocket 升级与 RPC 在互斥锁外执行，不阻塞并发 /ws，且复用短效 access_token", async () => {
    let authCalls = 0;
    let hatchCalls = 0;
    let releaseFirstWs!: () => void;
    let wsCalls = 0;
    const firstWsStarted = new Promise<void>((resolve) => {
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/auth/check") {
          authCalls++;
          return Response.json({ access_token: "token-" + authCalls });
        }
        if (url.pathname === "/api/hatch/token") {
          hatchCalls++;
          return Response.json({ token: "hatch-" + hatchCalls });
        }
        if (url.pathname === "/v1/noise") {
          wsCalls++;
          if (wsCalls === 1) {
            resolve();
            await new Promise<void>((done) => { releaseFirstWs = done; });
          }
          const [client, server] = Object.values(new WebSocketPair());
          server.accept();
          return new Response(null, { status: 101, webSocket: client });
        }
        throw new Error("unexpected url " + url);
      }));
    });

    const controller = new CookieController(bindings, memoryStore());
    const first = controller.fetch(new Request("https://internal/ws", { headers: { Upgrade: "websocket" } }));
    await firstWsStarted;
    // 第一个连接正阻塞在 WebSocket Upgrade 时，第二个 /ws 必须立刻完成，且跳过 /api/auth/check
    const second = await controller.fetch(new Request("https://internal/ws", { headers: { Upgrade: "websocket" } }));
    expect(second.status).toBe(101);
    second.webSocket?.accept();
    second.webSocket?.close();
    expect(authCalls).toBe(1);
    expect(hatchCalls).toBe(2);

    releaseFirstWs();
    const firstRes = await first;
    expect(firstRes.status).toBe(101);
    firstRes.webSocket?.accept();
    firstRes.webSocket?.close();
  });

  it("缓存的 access_token 被 hatch/token 返回 401 时自动回退重走 /api/auth/check", async () => {
    let authCalls = 0;
    let hatchCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/auth/check") {
        authCalls++;
        return Response.json({ access_token: "access-" + authCalls });
      }
      if (url.pathname === "/api/hatch/token") {
        hatchCalls++;
        const auth = new Headers(init?.headers).get("Authorization");
        if (hatchCalls === 2 && auth === "Bearer access-1") return new Response(null, { status: 401 });
        return Response.json({ token: "hatch-ok" });
      }
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      return new Response(null, { status: 101, webSocket: client });
    }));

    const controller = new CookieController(bindings, memoryStore());
    const r1 = await controller.fetch(new Request("https://internal/ws", { headers: { Upgrade: "websocket" } }));
    expect(r1.status).toBe(101);
    r1.webSocket?.accept(); r1.webSocket?.close();

    const r2 = await controller.fetch(new Request("https://internal/ws", { headers: { Upgrade: "websocket" } }));
    expect(r2.status).toBe(101);
    r2.webSocket?.accept(); r2.webSocket?.close();
    expect(authCalls).toBe(2);
    expect(hatchCalls).toBe(3);
  });
});

describe("ManagedChannels 主动推送 (/managed/push) 与事件唤醒优化", () => {
  it("支持 DEMO_KEY 鉴权路由、微信自动继承 context_token、幂等去重与白名单校验", async () => {
    const unauthorized = await handleRequest(
      new Request("https://demo.test/managed/push", { method: "POST", body: JSON.stringify({ text: "hi" }) }),
      { ...env, DEMO_KEY, MANAGED_CHANNELS_ENABLED: "true" },
      async () => new Response("ok"),
    );
    expect(unauthorized.status).toBe(401);

    await runInDurableObject(env.MOBILE.getByName("managed-push-test"), async (_instance, state) => {
      const runtime = new ManagedChannels(state, { ...env, MANAGED_CHANNELS_ENABLED: "true" });
      const store = new ManagedStore(state.storage.sql);
      state.storage.sql.exec("INSERT INTO config VALUES ('weixin',?)", JSON.stringify({
        enabled: true, account: "wx-bot", secret: "wx-secret", allowedSenders: ["alice"],
      }));

      // 尚无微信历史 context_token 时，明确拒绝而不是盲发空 token
      const noCtx = await runtime.fetch(new Request("https://internal/managed/push", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "weixin", text: "定时提醒：早上好" }),
      }));
      expect(noCtx.status).toBe(409);
      expect(await noCtx.json()).toEqual({ error: "weixin_context_unavailable" });

      // 模拟用户曾发过一条微信消息，留下最新 context_token
      store.ingest({
        id: "in-1", channel: "weixin", account: "wx-bot", chat: "alice", sender: "alice",
        group: false, text: "你好", context: "fresh-wx-ctx",
      });

      // 非白名单接收者被拒绝
      const denied = await runtime.fetch(new Request("https://internal/managed/push", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "weixin", chat: "stranger", text: "nope" }),
      }));
      expect(denied.status).toBe(403);

      const sentPayloads: Record<string, unknown>[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentPayloads.push(JSON.parse(String(init?.body)));
        return Response.json({ ret: 0, message_id: "9001" });
      }));

      // 正常主动推送（带幂等 id）
      const first = await runtime.fetch(new Request("https://internal/managed/push", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "cron-20261120-0800", text: "定时任务完成：一切正常" }),
      }));
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        ok: true, id: "cron-20261120-0800", channel: "weixin", deduplicated: false, delivery_state: "delivered",
      });
      expect(sentPayloads).toHaveLength(1);
      expect((sentPayloads[0].msg as Record<string, unknown>).context_token).toBe("fresh-wx-ctx");

      // 相同 id 重复推送严格幂等，不二次外发
      const dup = await runtime.fetch(new Request("https://internal/managed/push", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "cron-20261120-0800", text: "定时任务完成：一切正常" }),
      }));
      expect(dup.status).toBe(200);
      expect(await dup.json()).toMatchObject({ ok: true, deduplicated: true, delivery_state: "delivered" });
      expect(sentPayloads).toHaveLength(1);
    });
  });

  it("auto 模式在微信无 context_token 时自动回退到已启用的企微渠道", async () => {
    await runInDurableObject(env.MOBILE.getByName("managed-push-fallback"), async (_instance, state) => {
      const runtime = new ManagedChannels(state, { ...env, MANAGED_CHANNELS_ENABLED: "true" });
      state.storage.sql.exec("INSERT INTO config VALUES ('weixin',?)", JSON.stringify({
        enabled: true, account: "wx-bot", secret: "wx-secret", allowedSenders: ["alice"],
      }));
      state.storage.sql.exec("INSERT INTO config VALUES ('wecom',?)", JSON.stringify({
        enabled: true, account: "wc-bot", secret: "wc-secret", allowedSenders: ["alice"],
      }));
      const internal = runtime as unknown as {
        ensureWecom: () => Promise<void>;
        frame: (value: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      vi.spyOn(internal, "ensureWecom").mockResolvedValue(undefined);
      const frameSpy = vi.spyOn(internal, "frame").mockResolvedValue({ errcode: 0 });

      const res = await runtime.fetch(new Request("https://internal/managed/push", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "cron-fallback", text: "定时巡检正常" }),
      }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, channel: "wecom", delivery_state: "delivered" });
      expect(frameSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("awaiting=0 的闲置会话不会在 watch() 中建立幽灵订阅连接", async () => {
    await runInDurableObject(env.MOBILE.getByName("managed-no-ghost-watch"), async (_instance, state) => {
      const runtime = new ManagedChannels(state, { ...env, MANAGED_CHANNELS_ENABLED: "true" });
      const store = new ManagedStore(state.storage.sql);
      const task = store.ingest({
        id: "old-msg", channel: "weixin", account: "wx-bot", chat: "alice", sender: "alice",
        group: false, text: "旧消息", context: "ctx",
      })!;
      state.storage.sql.exec("UPDATE tasks SET state='submitted',session='idle-sess' WHERE id=?", task.id);
      state.storage.sql.exec(
        "INSERT INTO native_sessions(session,conversation,generation,route,cursor,awaiting,last_checked) VALUES (?,?,?,?,10,0,?)",
        "idle-sess", task.conversation, task.generation, task.route, Date.now(),
      );
      const subscribe = vi.fn(async () => {});
      const close = vi.fn();
      const internal = runtime as unknown as {
        socket: () => Promise<{ client: MuseRpc; owner: { account: string; vm: string }; approvalEvents: boolean }>;
        watch: (session: string, owner: { account: string; vm: string }) => Promise<void>;
      };
      vi.spyOn(internal, "socket").mockResolvedValue({ client: { subscribe, close } as unknown as MuseRpc, owner: { account: "primary-account", vm: "fixture-vm" }, approvalEvents: false });
      await internal.watch("idle-sess", { account: "primary-account", vm: "fixture-vm" });
      expect(subscribe).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it("已启用渠道但 alarm 丢失时，查询状态自动补挂 alarm 自愈", async () => {
    await runInDurableObject(env.MOBILE.getByName("managed-alarm-self-heal"), async (_instance, state) => {
      const runtime = new ManagedChannels(state, { ...env, MANAGED_CHANNELS_ENABLED: "true" });
      state.storage.sql.exec("INSERT INTO config VALUES ('wecom',?)", JSON.stringify({
        enabled: true, account: "wc-bot", secret: "wc-secret", allowedSenders: ["alice"],
      }));
      expect(await state.storage.getAlarm()).toBeNull();
      const res = await runtime.fetch(new Request("https://internal/admin/managed/status"));
      expect(res.status).toBe(200);
      const body = await res.json<{ next_alarm_at: number | null }>();
      expect(body.next_alarm_at).not.toBeNull();
    });
  });

  it("空闲断开的 MuseRpc 连接(alive=false)会在下次 rpc() 前自动重建，不误把新消息标成 unknown", async () => {
    await runInDurableObject(env.MOBILE.getByName("managed-dead-rpc-evict"), async (_instance, state) => {
      const runtime = new ManagedChannels(state, { ...env, MANAGED_CHANNELS_ENABLED: "true" });
      const internal = runtime as unknown as {
        muse: Map<string, { client: MuseRpc; owner: { account: string; vm: string }; approvalEvents: boolean }>;
        socket: () => Promise<{ client: MuseRpc; owner: { account: string; vm: string }; approvalEvents: boolean }>;
        rpc: <T>(op: (client: MuseRpc) => Promise<T>, target: { account: string }) => Promise<T>;
      };
      const deadClose = vi.fn();
      const deadCall = vi.fn(async () => { throw new Error("should_not_use_dead_socket"); });
      const owner = { account: "primary-account", vm: "fixture-vm" };
      internal.muse.set(owner.account, { client: { alive: false, close: deadClose, call: deadCall } as unknown as MuseRpc, owner, approvalEvents: false });

      const freshCall = vi.fn(async () => ({ ok: true }));
      const freshSocket = vi.spyOn(internal, "socket").mockResolvedValue({ client: { alive: true, close: vi.fn(), call: freshCall } as unknown as MuseRpc, owner, approvalEvents: false });

      const res = await internal.rpc((client) => client.call("/api/session/list", 0), owner);
      expect(res).toEqual({ ok: true });
      expect(deadClose).toHaveBeenCalledTimes(1);
      expect(deadCall).not.toHaveBeenCalled();
      expect(freshSocket).toHaveBeenCalledTimes(1);
      expect(freshCall).toHaveBeenCalledTimes(1);
    });
  });
});

describe("OutboxRelay 纯 CF 侧 Range 增量同步 VM 定时任务发件箱", () => {
  it("首次仅记高水位不重放历史，后续仅 Range 拉增量、防半行截断、严格白名单与幂等去重", async () => {
    await runInDurableObject(env.MOBILE.getByName("outbox-range-sync"), async (_instance, state) => {
      const store = new ManagedStore(state.storage.sql);
      const native = new NativeConversations(store, async () => { throw new Error("unused"); }, (op) => state.storage.transactionSync(op), vi.fn(), async () => ["primary-account"]);
      // 先留一条微信入站记录，提供最新 context_token
      store.ingest({
        id: "wx-in-1", channel: "weixin", account: "wx-bot", chat: "alice", sender: "alice",
        group: false, text: "hi", context: "ctx-latest",
      });

      const files: Record<string, Uint8Array> = {
        "workspace/weixin-bot/state/outbox.jsonl": new TextEncoder().encode('{"id":"old-1","mode":"send","to_user_id":"alice","content":"旧历史"}\n'),
        "workspace/wecom-bot/state/outbox.jsonl": new TextEncoder().encode('{"id":"old-2","mode":"send","chatid":"alice","content":"旧企微"}\n'),
      };
      const ranges: string[] = [];
      const call = vi.fn(async (path: string, _svc?: number, _method?: string, body?: unknown) => {
        expect(path).toBe("/fs/stats");
        const paths = (body as { paths: string[] }).paths;
        return {
          entries: paths.map((p) => ({ path: "/" + p, kind: "file", size: files[p].length })),
        };
      });
      const raw = vi.fn(async (path: string, _svc?: number, _method?: string, headers?: Record<string, string>) => {
        const range = headers?.range ?? "";
        ranges.push(range);
        const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
        const start = Number(match[1]), end = Number(match[2]);
        const key = path.replace(/^\/media\/raw\//, "");
        return { status: 206, body: files[key].slice(start, end + 1) };
      });
      const client = { call, raw } as unknown as MuseRpc;
      const relay = new OutboxRelay(
        store,
        (op) => op(client, { account: "primary-account", vm: "fixture-vm" }),
        (op) => state.storage.transactionSync(op),
        (ch, acc, chat, grp) => native.latestRoute(ch, acc, chat, grp),
      );
      const configs = {
        weixin: { enabled: true, account: "wx-bot", secret: "s1", allowedSenders: ["alice"] },
        wecom: { enabled: true, account: "wc-bot", secret: "s2", allowedSenders: ["alice"] },
      };

      // 1. 首次同步：仅记录高水位，0 次 raw 下载，0 条入队
      expect(await relay.sync(configs)).toBe(0);
      expect(raw).not.toHaveBeenCalled();
      expect(relay.offset("weixin")).toBe(files["workspace/weixin-bot/state/outbox.jsonl"].length);
      expect(relay.offset("wecom")).toBe(files["workspace/wecom-bot/state/outbox.jsonl"].length);

      // 2. 定时任务追加新行（含一条 reply、一条非白名单、一条完整 send 和一条未写完的半行）
      const wxAdd = [
        '{"id":"r1","mode":"reply","to_user_id":"alice","content":"忽略reply"}\n',
        '{"id":"s-bad","mode":"send","to_user_id":"stranger","content":"忽略陌生人"}\n',
        '{"id":"gold-1","mode":"send","to_user_id":"alice","content":"【黄金波动提醒】现价760"}\n',
        '{"id":"gold-half","mode":"send","to_user_id":"alice","content":"半截',
      ].join("");
      const wcAdd = '{"id":"gold-wc-1","mode":"send","chatid":"alice","chat_type":1,"content":"【黄金波动提醒】现价760"}\n';
      files["workspace/weixin-bot/state/outbox.jsonl"] = join(files["workspace/weixin-bot/state/outbox.jsonl"], new TextEncoder().encode(wxAdd));
      files["workspace/wecom-bot/state/outbox.jsonl"] = join(files["workspace/wecom-bot/state/outbox.jsonl"], new TextEncoder().encode(wcAdd));

      expect(await relay.sync(configs)).toBe(2);
      expect(ranges).toHaveLength(2);
      const outbounds = state.storage.sql.exec<{ text: string; route: string }>("SELECT text,route FROM outbound ORDER BY id").toArray();
      expect(outbounds.map((r) => r.text)).toEqual(["【黄金波动提醒】现价760", "【黄金波动提醒】现价760"]);
      expect(JSON.parse(outbounds[0].route).context).toBe("ctx-latest");

      // 3. 补全半行的剩余字节，下一次 sync 精准接续消费
      files["workspace/weixin-bot/state/outbox.jsonl"] = join(
        files["workspace/weixin-bot/state/outbox.jsonl"],
        new TextEncoder().encode('补完"}\n'),
      );
      expect(await relay.sync(configs)).toBe(1);
      const texts = state.storage.sql.exec<{ text: string }>("SELECT text FROM outbound ORDER BY id").toArray().map((r) => r.text);
      expect(texts).toEqual(["【黄金波动提醒】现价760", "【黄金波动提醒】现价760", "半截补完"]);

      // 4. 文件无新增时 0 次 raw 下载
      const prevCalls = raw.mock.calls.length;
      expect(await relay.sync(configs)).toBe(0);
      expect(raw).toHaveBeenCalledTimes(prevCalls);
    });
  });
});
