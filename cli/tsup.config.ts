import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "es2022",
  bundle: true,
  external: ["steamharness"],
  // @steamharness/i18n is a TypeScript-only build dependency. Inline it and
  // i18next so the published CLI has no workspace-only runtime dependency.
  noExternal: [
    "@steamharness/auth-config",
    "@steamharness/i18n",
    "@steamharness/kanban-project",
    "@steamharness/openai-responses",
    "@steamharness/project-upload",
    "@steamharness/workflow-mcp",
    "@steamharness/workflow-ids",
    "@modelcontextprotocol/sdk",
    "i18next",
    "ignore",
    "zod",
  ],
  clean: true,
  dts: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
