import path from "node:path";
import { defineConfig } from "vitest/config";

const localHarnessRoot = process.env.STEAMHARNESS_LOCAL_HARNESS_ROOT?.trim();

export default defineConfig({
  resolve: {
    conditions: ["development"],
    alias: localHarnessRoot
      ? { "steamharness": path.join(path.resolve(localHarnessRoot), "src", "index.ts") }
      : undefined,
  },
  test: {
    environment: "node",
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
