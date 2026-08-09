import { defineConfig } from "vitest/config";

/**
 * Separate from vite.config.ts on purpose: Vitest prefers this file, so the
 * `reactRouter()` plugin never loads. That plugin exists to drive the framework
 * build, and pulling it into a test run only gets in the way — the loaders here
 * are imported as plain modules.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          environment: "node",
          // Each file boots a real server behind a proxy, and they'd fight over
          // the same build output if they ran at once.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
