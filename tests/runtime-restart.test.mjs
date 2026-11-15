import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Miniflare, Response } from "miniflare";
import { build, stop } from "esbuild";

const key = "runtime-test-key-that-is-longer-than-thirty-two-characters";
const headers = { Authorization: `Bearer ${key}` };
const scriptPath = resolve(".local/runtime-test-worker.mjs");
await build({ entryPoints: ["src/index.ts"], outfile: scriptPath, bundle: true,
  format: "esm", platform: "neutral", target: "es2022", external: ["cloudflare:workers"] });
stop();

function runtime(folder, outbound, cookie = "hatch_sess=seed") {
  return new Miniflare({
    name: "credential-restart-fixture", modules: true, scriptPath,
    compatibilityDate: "2026-07-01", compatibilityFlags: ["nodejs_compat"], cf: false,
    bindings: { DEMO_KEY: key, MUSE_COOKIE: cookie, MUSE_VM_ID: "vm-test", MUSE_COOKIE_PART_1: "", MUSE_COOKIE_PART_2: "" },
    durableObjects: { CREDENTIALS: { className: "MuseCredentials", useSQLite: true } },
    durableObjectsPersist: folder,
    outboundService: async (request) => {
      assert.equal(new URL(request.url).origin, "https://muse.ai");
      assert.equal(new URL(request.url).pathname, "/api/auth/check");
      return outbound(request);
    },
  });
}

async function status(mf) {
  const response = await mf.dispatchFetch("https://local.test/credentials/status", { headers });
  assert.equal(response.status, 200);
  return response.json();
}

test("complete runtime restart preserves rotated Cookie and metadata on disk", { timeout: 30_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "cf-cookie-restart-"));
  let mf;
  try {
    mf = runtime(folder, () => Response.json({ access_token: "first-token" }, {
      headers: { "Set-Cookie": "hatch_sess=rotated-on-disk; Max-Age=300; Path=/" },
    }));
    const response = await mf.dispatchFetch("https://local.test/credentials/refresh", { method: "POST", headers });
    assert.equal(response.status, 200);
    const first = await response.json();
    assert.equal(first.ok, true);
    assert.ok(first.last_rotated_at);
    await mf.dispose();
    let seen;
    mf = runtime(folder, (request) => {
      seen = request.headers.get("Cookie");
      return Response.json({ access_token: "second-token" });
    });
    const restored = await status(mf);
    assert.equal(restored.last_rotated_at, first.last_rotated_at);
    assert.equal(restored.last_verified_at, first.last_verified_at);
    assert.equal(restored.ok, true);
    const second = await mf.dispatchFetch("https://local.test/credentials/refresh", { method: "POST", headers });
    assert.equal((await second.json()).ok, true);
    assert.equal(seen, "hatch_sess=rotated-on-disk");
  } finally {
    await mf?.dispose();
    await rm(folder, { recursive: true, force: true });
  }
});

test("authentication stop survives restart and a new imported seed restores checks", { timeout: 30_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "cf-cookie-relogin-"));
  let mf;
  try {
    mf = runtime(folder, () => new Response(null, { status: 401 }));
    await mf.dispatchFetch("https://local.test/credentials/refresh", { method: "POST", headers });
    assert.equal((await status(mf)).needs_login, true);
    await mf.dispose();
    let calls = 0;
    mf = runtime(folder, () => { calls += 1; return Response.json({ access_token: "valid" }); });
    const stopped = await mf.dispatchFetch("https://local.test/credentials/refresh", { method: "POST", headers });
    assert.equal((await stopped.json()).needs_login, true);
    assert.equal(calls, 0);
    await mf.dispose();
    mf = runtime(folder, (request) => {
      assert.equal(request.headers.get("Cookie"), "hatch_sess=new-import");
      return Response.json({ access_token: "new-import-token" });
    }, "hatch_sess=new-import");
    const refreshed = await mf.dispatchFetch("https://local.test/credentials/refresh", { method: "POST", headers });
    assert.equal((await refreshed.json()).ok, true);
  } finally {
    await mf?.dispose();
    await rm(folder, { recursive: true, force: true });
  }
});

test("actual scheduled event reaches the same persistent renewal state", { timeout: 30_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "cf-cookie-cron-"));
  let mf;
  try {
    let calls = 0;
    mf = runtime(folder, () => {
      calls += 1;
      return Response.json({ access_token: "cron-token" }, {
        headers: { "Set-Cookie": "hatch_sess=cron-ticket; Max-Age=300; Path=/" },
      });
    });
    await (await mf.getWorker()).scheduled({ cron: "54 20 * * *" });
    assert.equal(calls, 1);
    const result = await status(mf);
    assert.equal(result.ok, true);
    assert.ok(result.last_verified_at);
    assert.ok(result.last_rotated_at);
  } finally {
    await mf?.dispose();
    await rm(folder, { recursive: true, force: true });
  }
});
