import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests import via .js suffix (NodeNext) — vitest handles the mapping.
    include: ["src/**/*.test.ts"],
    // Longer timeout: token-bucket refill assertions need real elapsed time.
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // Sequential: tests share one Mongo test DB + Redis test prefix. Parallel
    // would need per-test namespacing; not worth the complexity here.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    setupFiles: ["src/test/setup.ts"],
  },
});
