import test from "node:test";
import assert from "node:assert/strict";
import { channelUrl, errorText, isReply, serverOrigin, socketProtocols, taskFrame } from "../public/protocol.js";

test("server input rejects credentials, URLs with paths and insecure public endpoints", () => {
  for (const value of ["http://example.com", "https://user:secret@example.com", "https://example.com/chat", "https://example.com?token=secret", "https://example.com/#secret", "wss://example.com"]) {
    assert.throws(() => serverOrigin(value));
  }
  assert.equal(serverOrigin("http://localhost:8787"), "http://localhost:8787");
  assert.equal(serverOrigin("https://example.com/"), "https://example.com");
});

test("socket URL is role-bound and never contains token data", () => {
  assert.equal(channelUrl("https://example.com", "main"), "wss://example.com/ws/main?role=user");
  assert.throws(() => channelUrl("https://example.com", "../other"));
  assert.throws(() => channelUrl("https://example.com", "main?role=muse"));
});

test("handshake uses UTF-8 base64url with a separate public protocol", () => {
  const protocols = socketProtocols("中文+密钥/");
  assert.equal(protocols[0], "cf-muse-v1");
  assert.match(protocols[1], /^auth\.[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(protocols[1].slice(5), "base64url").toString("utf8"), "中文+密钥/");
  assert.throws(() => socketProtocols(""));
});

test("task frame checks UTF-8 size and creates stable identity once", () => {
  const frame = taskFrame("  <script>untrusted</script>  ", "task-1");
  assert.deepEqual(frame, { type: "message", id: "task-1", kind: "task", content: "<script>untrusted</script>" });
  assert.throws(() => taskFrame(" "));
  assert.throws(() => taskFrame("中".repeat(23000)));
  assert.throws(() => taskFrame("task", "a".repeat(97)));
});

test("only bound Muse progress and canonical result IDs are valid", () => {
  const progress = { type: "message", id: "progress:1", source: "muse", kind: "progress", content: "进行中", reply_to: "task-1" };
  assert.equal(isReply(progress), true);
  assert.equal(isReply({ ...progress, kind: "result", id: "result:task-1" }), true);
  assert.equal(isReply({ ...progress, kind: "result" }), false);
  assert.equal(isReply({ ...progress, source: "user" }), false);
  assert.equal(isReply({ ...progress, reply_to: undefined }), false);
  assert.equal(isReply({ ...progress, content: { html: "untrusted" } }), false);
});

test("unknown errors do not echo server-controlled content", () => {
  assert.equal(errorText("secret_token=123"), "通信未完成，请核对连接与服务配置后重试。");
  assert.match(errorText("id_conflict"), /停止重试/);
});
