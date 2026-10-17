import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "es2022",
  bundle: true,
  external: ["workflow-code"],
  // @workflow-code/i18n is a TypeScript-only build dependency. Inline it and
  // i18next so the published CLI has no workspace-only runtime dependency.
  noExternal: [
    "@workflow-code/auth-config",
    "@workflow-code/i18n",
    "@workflow-code/kanban-project",
    "@workflow-code/openai-responses",
    "@workflow-code/project-upload",
    "@workflow-code/workflow-mcp",
    "@workflow-code/workflow-ids",
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
