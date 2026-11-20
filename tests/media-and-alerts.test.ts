import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuseCredentials } from "../src/credentials";
import {
  aes128EcbDecrypt,
  aes128EcbEncrypt,
  aes256CbcDecrypt,
  extractOutboundFiles,
  hexToBytes,
  isAllowedTencentMediaUrl,
  md5Hex,
  normalizeAllowedSandboxPath,
  parseWeixinAesKey,
} from "../src/managed/media";
import { NativeConversations } from "../src/managed/native";
import { OutboxRelay } from "../src/managed/outbox";
import { wecomMessage, weixinMessages } from "../src/managed/protocol";
import { ManagedChannels } from "../src/managed/runtime";
import { ManagedStore } from "../src/managed/store";
import { MuseRpc } from "../src/noise";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("媒体加解密跨实现互操作与安全边界", () => {
  it("MD5、AES-128-ECB(微信)、AES-256-CBC(企微32字节填充) 与 Python cryptography 逐字节一致", async () => {
    expect(md5Hex(new TextEncoder().encode("cf-muse-media-interop-2026"))).toBe("ec02e06e68368feaa351d367e9884939");

    const k16 = hexToBytes("00112233445566778899aabbccddeeff");
    const wxPlain = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode("hello-weixin-image")]);
    const expectedWxCt = "6757603f6e91ba7c944b3c934782324a42addd79ad28530fe59398f198673697";
    const actualWxCt = aes128EcbEncrypt(wxPlain, k16);
    expect(Array.from(actualWxCt, (b) => b.toString(16).padStart(2, "0")).join("")).toBe(expectedWxCt);
    expect(aes128EcbDecrypt(hexToBytes(expectedWxCt), k16)).toEqual(wxPlain);
    expect(parseWeixinAesKey("00112233445566778899aabbccddeeff", true)).toEqual(k16);
    expect(parseWeixinAesKey(btoa("00112233445566778899aabbccddeeff"), false)).toEqual(k16);

    const wcPlain = await aes256CbcDecrypt(
      hexToBytes("0f3c4c964b06ccfbfdab759166b242dbb27e9487aef73f0fcfba81426a5bc7cf"),
      "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    );
    expect(new TextDecoder().decode(wcPlain)).toBe("%PDF-1.7\nwecom-doc");
  });

  it("严格校验腾讯媒体域名白名单与沙箱路径安全边界", () => {
    expect(isAllowedTencentMediaUrl("https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=abc")).toBe(true);
    expect(isAllowedTencentMediaUrl("https://ww-aibot-img-123.cos.ap-guangzhou.myqcloud.com/file")).toBe(true);
    expect(isAllowedTencentMediaUrl("http://novac2c.cdn.weixin.qq.com/c2c/download")).toBe(false);
    expect(isAllowedTencentMediaUrl("https://evil.cos.ap-guangzhou.myqcloud.com/x")).toBe(false);
    expect(isAllowedTencentMediaUrl("https://169.254.169.254/latest")).toBe(false);

    expect(normalizeAllowedSandboxPath("/home/hatch/workspace/charts/a.png")).toBe("workspace/charts/a.png");
    expect(normalizeAllowedSandboxPath("~/workspace/out/clip.mp4")).toBe("workspace/out/clip.mp4");
    expect(normalizeAllowedSandboxPath("/home/hatch/workspace/../.ssh/id_rsa")).toBeNull();
    expect(normalizeAllowedSandboxPath("/home/hatch/.config/weixin-bot/credentials.env")).toBeNull();
    expect(normalizeAllowedSandboxPath("workspace/secret_token.json")).toBeNull();

    const parsed = extractOutboundFiles("图表已生成\n[[FILE:/home/hatch/workspace/charts/a.png]]\n[[FILE:/etc/passwd]]\n请查收");
    expect(parsed).toEqual({ text: "图表已生成\n请查收", files: ["workspace/charts/a.png"] });
  });
});

describe("微信/企微入站媒体与语音转文字解析 + 沙箱写入", () => {
  const cfg = { enabled: true, account: "bot", secret: "sec", allowedSenders: ["alice"] };

  it("解析微信图文混发、语音转文字与空语音，以及企微 mixed/voice", () => {
    const wx = weixinMessages({
      msgs: [
        {
          message_id: "m1", from_user_id: "alice", context_token: "ctx1",
          item_list: [
            { type: 1, text_item: { text: "帮我看这张图" } },
            { type: 2, image_item: { aeskey: "00112233445566778899aabbccddeeff", media: { encrypt_query_param: "p1" } } },
          ],
        },
        { message_id: "m2", from_user_id: "alice", context_token: "ctx2", item_list: [{ type: 3, voice_item: { text: "明天天气怎样" } }] },
        { message_id: "m3", from_user_id: "alice", context_token: "ctx3", item_list: [{ type: 3, voice_item: { text: "" } }] },
      ],
    }, cfg);
    expect(wx[0].text).toBe("帮我看这张图");
    expect(wx[0].media).toHaveLength(1);
    expect(wx[0].media![0].kind).toBe("image");
    expect(wx[1].text).toBe("明天天气怎样");
    expect(wx[2].text).toBe("/voice-empty");

    const wc = wecomMessage({
      cmd: "aibot_msg_callback",
      body: {
        msgid: "wc1", from: { userid: "alice" }, msgtype: "mixed",
        mixed: {
          msg_item: [
            { msgtype: "text", text: { content: "分析这份图" } },
            { msgtype: "image", image: { url: "https://ww-aibot-img-1.cos.ap-guangzhou.myqcloud.com/1", aeskey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" } },
          ],
        },
      },
    }, cfg)!;
    expect(wc.text).toBe("分析这份图");
    expect(wc.media).toHaveLength(1);
    expect(wc.media![0].channel).toBe("wecom");
  });

  it("forward() 自动下载解密入站图片并经 /fs/write 写入 Muse 沙箱，再连同路径提交给 Muse", async () => {
    await runInDurableObject(env.MOBILE.getByName("inbound-media-stage"), async (_instance, state) => {
      const store = new ManagedStore(state.storage.sql);
      const writes: Record<string, unknown>[] = [];
      const streamBodies: Record<string, unknown>[] = [];
      const call = vi.fn(async (path: string, _svc?: number, _m?: string, body?: unknown) => {
        if (path === "/session/start") return { session_id: "sess-media" };
        if (path.startsWith("/chat/history")) return { chat_events: [] };
        if (path === "/fs/write") { writes.push(body as Record<string, unknown>); return { ok: true }; }
        return {};
      });
      const open = vi.fn(async (_p: string, _s?: number, _m?: string, body?: unknown) => {
        streamBodies.push(body as Record<string, unknown>);
        return 1;
      });
      const client = { call, open } as unknown as MuseRpc;
      const native = new NativeConversations(store, (op) => op(client), (op) => state.storage.transactionSync(op), vi.fn());

      // 返回预先用 Python AES-128-ECB 加密的 PNG 密文
      const ct = hexToBytes("6757603f6e91ba7c944b3c934782324a42addd79ad28530fe59398f198673697");
      vi.stubGlobal("fetch", vi.fn(async () => new Response(ct, { status: 200 })));

      const task = store.ingest({
        id: "img-msg-1", channel: "weixin", account: "bot", chat: "alice", sender: "alice", group: false,
        text: "看看图片内容", context: "ctx1",
        media: [{
          kind: "image", channel: "weixin",
          url: "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=abc",
          aesKey: "00112233445566778899aabbccddeeff", aesKeyHex: true,
        }],
      })!;

      await native.forward(task);
      expect(writes).toHaveLength(1);
      expect(String(writes[0].path)).toMatch(/^workspace\/cf-inbound-media\/img-msg-1_0\.png$/);
      expect(writes[0].overwrite).toBe(true);
      expect(writes[0].create_parent).toBe(true);
      const sentText = ((streamBodies[0].items as { text: string }[])[0]).text;
      expect(sentText).toContain("看看图片内容");
      expect(sentText).toContain("/home/hatch/workspace/cf-inbound-media/img-msg-1_0.png");
    });
  });
});

describe("出站媒体发送与微信 context_token 失效/缺失自动企微兜底", () => {
  it("支持 Muse 回复 [[FILE:...]] 拉取沙箱图片并经微信 getuploadurl + CDN 加密上传送达", async () => {
    await runInDurableObject(env.MOBILE.getByName("outbound-weixin-media"), async (_instance, state) => {
      const runtime = new ManagedChannels(state, { ...env, MANAGED_CHANNELS_ENABLED: "true" });
      const store = new ManagedStore(state.storage.sql);
      state.storage.sql.exec("INSERT INTO config VALUES ('weixin',?)", JSON.stringify({
        enabled: true, account: "wx-bot", secret: "wx-sec", allowedSenders: ["alice"],
      }));
      const task = store.ingest({
        id: "native:s1:ans1", channel: "weixin", account: "wx-bot", chat: "alice", sender: "alice",
        group: false, text: "已生图", context: "ctx-ok",
      })!;
      store.complete(task, "图表已生成");
      store.set("outbound-files:" + task.id, ["workspace/charts/out.png"]);

      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
      const internal = runtime as unknown as {
        rpc: <T>(op: (c: MuseRpc) => Promise<T>) => Promise<T>;
        deliver: () => Promise<void>;
      };
      vi.spyOn(internal, "rpc").mockImplementation(async (op) => {
        const fakeRpc = {
          call: async (path: string) => {
            if (path === "/fs/stat") return { kind: "file", size: pngBytes.length };
            return {};
          },
          raw: async () => ({ status: 206, body: pngBytes }),
        } as unknown as MuseRpc;
        return op(fakeRpc);
      });

      const wxSent: Record<string, unknown>[] = [];
      let uploadedCipherBytes = 0;
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/ilink/bot/getuploadurl")) {
          return Response.json({ ret: 0, upload_full_url: "https://novac2c.cdn.weixin.qq.com/c2c/upload?p=1" });
        }
        if (url.startsWith("https://novac2c.cdn.weixin.qq.com/c2c/upload")) {
          const body = init?.body as Uint8Array;
          uploadedCipherBytes = body.byteLength;
          return new Response("", { status: 200, headers: { "x-encrypted-param": "dl-param-xyz" } });
        }
        if (url.endsWith("/ilink/bot/sendmessage")) {
          wxSent.push(JSON.parse(String(init?.body)));
          return Response.json({ ret: 0, message_id: "12345" });
        }
        throw new Error("unexpected url " + url);
      }));

      await internal.deliver();
      expect(uploadedCipherBytes).toBe(16); // 12 bytes -> 16 bytes PKCS#7 AES-128-ECB
      expect(wxSent).toHaveLength(2);
      expect(((wxSent[0].msg as Record<string, unknown>).item_list as Record<string, unknown>[])[0].type).toBe(1);
      const mediaItem = ((wxSent[1].msg as Record<string, unknown>).item_list as Record<string, unknown>[])[0];
      expect(mediaItem.type).toBe(2);
      expect(((mediaItem.image_item as Record<string, unknown>).media as Record<string, unknown>).encrypt_query_param).toBe("dl-param-xyz");
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM outbound").one().state).toBe("delivered");
    });
  });

  it("OutboxRelay 在微信无 context_token 时自动企微兜底（且若企微自身已有相同正文不重复发）", async () => {
    await runInDurableObject(env.MOBILE.getByName("outbox-wx-fallback"), async (_instance, state) => {
      const store = new ManagedStore(state.storage.sql);
      const native = new NativeConversations(store, async () => { throw new Error("unused"); }, (op) => state.storage.transactionSync(op), vi.fn());
      const files: Record<string, Uint8Array> = {
        "workspace/weixin-bot/state/outbox.jsonl": new TextEncoder().encode(""),
        "workspace/wecom-bot/state/outbox.jsonl": new TextEncoder().encode(""),
      };
      const fakeRpc = {
        call: async (_p: string, _s?: number, _m?: string, body?: unknown) => ({
          entries: (body as { paths: string[] }).paths.map((p) => ({ path: "/" + p, kind: "file", size: files[p].length })),
        }),
        raw: async (p: string, _s?: number, _m?: string, h?: Record<string, string>) => {
          const m = /^bytes=(\d+)-(\d+)$/.exec(h?.range ?? "")!;
          const key = p.replace(/^\/media\/raw\//, "");
          return { status: 206, body: files[key].slice(Number(m[1]), Number(m[2]) + 1) };
        },
      } as unknown as MuseRpc;
      const relay = new OutboxRelay(store, (op) => op(fakeRpc), (op) => state.storage.transactionSync(op), (c, a, ch, g) => native.latestRoute(c, a, ch, g));
      const cfgs = {
        weixin: { enabled: true, account: "wx", secret: "s", allowedSenders: ["alice"] },
        wecom: { enabled: true, account: "wc", secret: "s", allowedSenders: ["alice"] },
      };
      await relay.sync(cfgs); // 初始高水位 = 0

      // 微信新增 2 条：一条企微也有（不重复），一条仅微信有（应自动回退企微）
      files["workspace/weixin-bot/state/outbox.jsonl"] = new TextEncoder().encode(
        '{"id":"dup1","mode":"send","to_user_id":"alice","content":"双渠道同发"}\n'
        + '{"id":"onlywx","mode":"send","to_user_id":"alice","content":"仅微信定时提醒"}\n',
      );
      files["workspace/wecom-bot/state/outbox.jsonl"] = new TextEncoder().encode(
        '{"id":"wc1","mode":"send","chatid":"alice","content":"双渠道同发"}\n',
      );
      expect(await relay.sync(cfgs)).toBe(2);
      const rows = state.storage.sql.exec<{ route: string; text: string }>("SELECT route,text FROM outbound ORDER BY id").toArray();
      expect(rows.map((r) => [JSON.parse(r.route).channel, r.text])).toEqual([
        ["wecom", "双渠道同发"],
        ["wecom", "仅微信定时提醒"],
      ]);
    });
  });

  it("主动推送发微信收到腾讯明确拒收(platform_rejected)时，自动转企微兜底补发", async () => {
    await runInDurableObject(env.MOBILE.getByName("deliver-wx-reject-fallback"), async (_instance, state) => {
      const runtime = new ManagedChannels(state, { ...env, MANAGED_CHANNELS_ENABLED: "true" });
      const store = new ManagedStore(state.storage.sql);
      state.storage.sql.exec("INSERT INTO config VALUES ('weixin',?)", JSON.stringify({
        enabled: true, account: "wx", secret: "s", allowedSenders: ["alice"],
      }));
      state.storage.sql.exec("INSERT INTO config VALUES ('wecom',?)", JSON.stringify({
        enabled: true, account: "wc", secret: "s", allowedSenders: ["alice"],
      }));
      const task = store.ingest({
        id: "push:alert-1", channel: "weixin", account: "wx", chat: "alice", sender: "alice",
        group: false, text: "重要定时提醒", context: "expired-ctx",
      })!;
      store.complete(task, "重要定时提醒");

      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ret: -100, errmsg: "context expired" })));
      const internal = runtime as unknown as {
        ensureWecom: () => Promise<void>;
        frame: (f: Record<string, unknown>) => Promise<Record<string, unknown>>;
        deliver: () => Promise<void>;
      };
      vi.spyOn(internal, "ensureWecom").mockResolvedValue(undefined);
      const wecomSent = vi.spyOn(internal, "frame").mockResolvedValue({ errcode: 0 });

      await internal.deliver();
      expect(wecomSent).toHaveBeenCalledTimes(1);
      const out = state.storage.sql.exec<{ state: string; route: string }>("SELECT state,route FROM outbound ORDER BY id").toArray();
      expect(out.map((r) => [JSON.parse(r.route).channel, r.state])).toEqual([
        ["weixin", "unknown"],
        ["wecom", "delivered"],
      ]);
    });
  });
});

describe("MuseCredentials 非白名单审批提醒与 Cookie 过期告警去重", () => {
  it("非白名单 pending approval 首次触发手机推送，再次轮询同 id 不重复刷屏", async () => {
    const pushed: Record<string, unknown>[] = [];
    const fakeMobile = {
      getByName: () => ({
        fetch: async (req: Request) => {
          pushed.push(await req.json());
          return Response.json({ ok: true });
        },
      }),
    };

    await runInDurableObject(env.CREDENTIALS.getByName("approval-alert-test"), async (_instance, state) => {
      const creds = new MuseCredentials(state, {
        ...env,
        MUSE_COOKIE: "hatch_sess=ok",
        MUSE_VM_ID: "vm-alert",
        AUTO_APPROVAL_ENABLED: "true",
        AUTO_APPROVAL_POLICY_JSON: JSON.stringify({ rules: [{ host: "allowed.test", port: 443, scheme: "https", methods: ["GET"] }] }),
        MANAGED_CHANNELS_ENABLED: "true",
        MOBILE: fakeMobile as unknown as DurableObjectNamespace,
      });

      const rpc = {
        call: async (path: string) => {
          if (path === "/approvals") return { pending_approvals: [{ approval_id: "apr-hold-1" }] };
          if (path === "/approvals/apr-hold-1") {
            return {
              approval: {
                approval_id: "apr-hold-1",
                host: "unknown-api.example.com",
                port: 443,
                method: "POST",
                scheme: "https",
                status: "pending",
                request_expires_at_ms: Date.now() + 300_000,
              },
            };
          }
          return {};
        },
        close: () => {},
      } as unknown as MuseRpc;

      vi.spyOn(MuseRpc, "connect").mockResolvedValue(rpc);
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/v1/noise")) {
          const [client, server] = Object.values(new WebSocketPair());
          server.accept();
          return new Response(null, { status: 101, webSocket: client });
        }
        return Response.json({ access_token: "acc", token: "hatch" });
      }));

      const r1 = await creds.poll("durable_object_alarm");
      const r2 = await creds.poll("durable_object_alarm");
      expect(r1.ok).toBe(true);
      expect(r1.held).toBe(1);
      expect(r2.held).toBe(1);
      expect(pushed).toHaveLength(1);
      expect(String(pushed[0].text)).toContain("unknown-api.example.com:443");
      expect(String(pushed[0].id)).toBe("approval-apr-hold-1");
    });
  });

  it("Cookie 明确 401 失效时仅推送一次过期告警，不重复刷屏", async () => {
    const pushed: Record<string, unknown>[] = [];
    const fakeMobile = {
      getByName: () => ({
        fetch: async (req: Request) => {
          pushed.push(await req.json());
          return Response.json({ ok: true });
        },
      }),
    };

    await runInDurableObject(env.CREDENTIALS.getByName("cookie-expiry-alert-test"), async (_instance, state) => {
      const creds = new MuseCredentials(state, {
        ...env,
        MUSE_COOKIE: "hatch_sess=expired",
        MUSE_VM_ID: "vm-exp",
        MANAGED_CHANNELS_ENABLED: "true",
        MOBILE: fakeMobile as unknown as DurableObjectNamespace,
      });

      vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
      await creds.scheduledRenewal(Date.now(), "54 20 * * *");
      await creds.scheduledRenewal(Date.now(), "54 20 * * *");
      expect(pushed).toHaveLength(1);
      expect(String(pushed[0].text)).toContain("Cookie 已过期");
    });
  });
});
