import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    // Pin local tests to the installed stable workerd's supported date.
    // Deployment keeps today's date from wrangler.jsonc.
    miniflare: {
      compatibilityDate: "2026-07-01",
      bindings: { DEMO_KEY: "test-key-that-is-longer-than-thirty-two-characters", MUSE_COOKIE: "hatch_sess=test-cookie", MUSE_VM_ID: "vm-test",
        MUSE_COOKIE_PART_1: "", MUSE_COOKIE_PART_2: "" },
    },
  })],
  test: { include: ["tests/**/*.test.ts"] },
});
