import { defineConfig } from "tsup";
import path from "node:path";
import { copyFile } from "node:fs/promises";
import { createRequire } from "node:module";

const codemodeRequire = createRequire(import.meta.resolve("@earendil-works/pi-codemode"));

export default defineConfig({
  entry: {
    index: "src/index.ts",
    agent: "src/agent/index.ts",
    "runtime-api": "src/runtime-api.ts",
    "node/output": "src/node/output/index.ts",
    "types/context": "src/types/context.ts",
    "executor/rules": "src/executor/rules.ts",
    "agent-codemode-worker": "src/agent/codemode-worker.ts",
  },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "es2022",
  // sqlite is available only as node:sqlite, never as a bare package import.
  removeNodeProtocol: false,
  bundle: true,
  // The pi SDK and the MCP SDK are inlined on purpose. Packaged Desktop copies
  // only this package's `dist` into `out/workflow-runtime`, with no dependency
  // tree beside it, so an external import would resolve in dev and fail in a
  // packaged build. Everything the agent layer needs therefore has to travel
  // inside `dist` — which is also why both SDKs sit in `devDependencies`
  // rather than `dependencies`: nothing installs a tree that is already here.
  external: ["typescript"],
  // tsup externalises `dependencies` on its own, which would leave the
  // `await import("@earendil-works/...")` calls in the output pointing at a
  // package tree no consumer ships.
  noExternal: [/^@earendil-works\//, /^@modelcontextprotocol\//],
  // Parts of the SDK tree are still CommonJS and call `require("process")`
  // and friends. esbuild rewrites those into a shim that throws in ESM output
  // unless a real `require` is in scope, so every emitted file gets one.
  banner: {
    js: 'import { createRequire as __projectCreateRequire } from "node:module";\nconst require = __projectCreateRequire(import.meta.url);',
  },
  splitting: true,
  clean: true,
  dts: {
    resolve: ["@steamharness/openai-responses", "@steamharness/project-types"],
    entry: { index: "src/index.ts", agent: "src/agent/index.ts", "runtime-api": "src/runtime-api.ts", "node/output": "src/node/output/index.ts",
      "types/context": "src/types/context.ts", "executor/rules": "src/executor/rules.ts" },
  },
  async onSuccess() {
    await copyFile(codemodeRequire.resolve("quickjs-wasi/quickjs.wasm"), path.resolve("dist/quickjs.wasm"));
  },
  tsconfig: "tsconfig.json",
  esbuildOptions(options) {
    options.alias = {
      "steamharness": path.resolve("src/index.ts"),
    };
  },
});
