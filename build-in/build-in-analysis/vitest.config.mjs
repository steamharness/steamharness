import { defineConfig } from "vitest/config";
export default defineConfig({
  cacheDir: "dist/cache/vitest",
  test: { include: ["scripts/__tests__/**/*.test.mjs"], coverage: { reportsDirectory: "dist/reports/coverage" } },
});
