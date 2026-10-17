import path from "node:path";
import { defineConfig } from "vitest/config";

const localCoreRoot = process.env.WORKFLOW_LOCAL_CORE_ROOT?.trim();

export default defineConfig({
  resolve: {
    conditions: ["development"],
    alias: localCoreRoot
      ? { "workflow-code": path.join(path.resolve(localCoreRoot), "src", "index.ts") }
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
