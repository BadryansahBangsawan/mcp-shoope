import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 30_000,
    server: {
      deps: {
        // Inline packages that import `cloudflare:workers` so the alias applies inside them.
        inline: ["@cloudflare/codemode", "@cloudflare/workers-oauth-provider"],
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "cloudflare:workers": path.resolve(import.meta.dirname, "tests/stubs/cloudflare-workers.ts"),
    },
  },
});
