import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    conditions: ["development"],
  },
  test: {
    environment: "node",
    maxWorkers: 2,
    include: ["__tests__/**/*.test.ts", "workflow/**/__tests__/**/*.test.ts", "conversation/**/__tests__/**/*.test.ts"],
    setupFiles: ["test-setup.ts"],
  },
});
