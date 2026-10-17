import path from "node:path";
import { defineConfig } from "vitest/config";

// The harness lives next to this package in the monorepo, so the tests always
// run against the local sources unless a caller points them elsewhere.
const localHarnessRoot = process.env.STEAMHARNESS_LOCAL_HARNESS_ROOT?.trim()
  ?? path.resolve(import.meta.dirname, "..", "harness");

export default defineConfig({
  resolve: {
    conditions: ["development"],
    alias: localHarnessRoot
      ? { "steamharness": path.join(path.resolve(localHarnessRoot), "src", "index.ts") }
      : undefined,
  },
  test: {
    environment: "node",
    // Resolving the harness through the module runner is not supported; point
    // the CLI at the monorepo sources, which is what it runs against here.
    env: { STEAMHARNESS_LOCAL_HARNESS_ROOT: path.resolve(localHarnessRoot) },
    fileParallelism: false,
    maxWorkers: 2,
    include: ["src/**/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
    },
  },
});
