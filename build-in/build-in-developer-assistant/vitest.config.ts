import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["development"] },
  test: {
    environment: "node",
    fileParallelism: false,
    maxWorkers: 2,
    include: ["__tests__/**/*.test.ts", "scripts/__tests__/**/*.test.{ts,mjs}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
    },
  },
});
