import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, validReceipt } from "../worker/protocol.js";

test("task messages are source-bound and canonicalized", () => {
  assert.deepEqual(normalize({ type: "message", id: "task1", content: "hello" }, "user"),
    { type: "message", id: "task1", content: "hello", kind: "task", source: "user" });
});
test("users cannot forge Muse result or cross-task routing", () => {
  for (const extra of [{ kind: "result" }, { reply_to: "other" }, { id: "cancel:reserved" }, { id: "x".repeat(97) }]) {
    assert.throws(() => normalize({ type: "message", id: "task1", content: "text", ...extra }, "user"));
  }
});
test("results require canonical task-bound ID", () => {
  assert.throws(() => normalize({ type: "message", id: "random", reply_to: "task1", kind: "result", content: "ok" }, "muse"));
  assert.equal(normalize({ type: "message", id: "result:task1", reply_to: "task1", kind: "result", content: "ok" }, "muse").source, "muse");
});
test("media references ride result frames without carrying bytes", () => {
  const media = { id: "media-1", filename: "intro.mp4", mime: "video/mp4", size: 1172525 };
  assert.deepEqual(normalize({ type: "message", id: "result:task1", reply_to: "task1", kind: "result", content: "视频已生成", media }, "muse").media, media);
  for (const bad of [{ ...media, filename: "../intro.mp4" }, { ...media, mime: "application/octet-stream" }, { ...media, size: 11 * 1024 * 1024 }]) {
    assert.throws(() => normalize({ type: "message", id: "result:task1", reply_to: "task1", kind: "result", content: "ok", media: bad }, "muse"));
  }
  assert.throws(() => normalize({ type: "message", id: "progress:1", reply_to: "task1", kind: "progress", content: "ok", media }, "muse"));
  assert.throws(() => normalize({ type: "message", id: "task1", content: "ok", media }, "user"));
});
test("empty text and UTF-8 oversized payloads are rejected", () => {
  for (const content of [" ", "汉".repeat(22000), null]) assert.throws(() => normalize({ type: "message", id: "task1", content }, "user"));
});
test("receipts cannot acknowledge the sender's own messages", () => {
  assert.equal(validReceipt({ id: "t1", source: "user" }, "muse"), true);
  assert.equal(validReceipt({ id: "t1", source: "muse" }, "muse"), false);
  assert.equal(validReceipt({ id: {}, source: "user" }, "muse"), false);
});
