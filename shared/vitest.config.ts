import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["development"],
  },
  test: {
    globals: true,
    environment: "jsdom",
    fileParallelism: false,
    maxWorkers: 2,
    setupFiles: ["./tests/setup.ts"],
    // Rendering these suites through jsdom produces a large volume of library
    // console output that says nothing about the test result — mostly React
    // reporting state updates that were not wrapped in act(), each occurrence a
    // verbatim repeat of the same seven-line block. Forwarding it for passing
    // tests buried the real CI output under ~8500 lines per run, so only failing
    // tests forward their console output now. A failure still prints everything
    // it logged, including its act() warnings. Use
    // `vitest run --silent=false <file>` to see the output of a passing file.
    silent: "passed-only",
    include: ["*/**/__tests__/**/*.test.ts", "*/**/__tests__/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
    },
  },
});
