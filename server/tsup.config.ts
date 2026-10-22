import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "es2022",
  bundle: true,
  // Production Node cannot load workspace packages' TypeScript-only entries.
  // Inline them so deployed releases only load built JavaScript.
  noExternal: [
    "@steamharness/project-access",
    "@steamharness/project-card-metadata",
    "@steamharness/project-configuration",
    "@steamharness/project-dependencies",
    "@steamharness/project-info",
    "@steamharness/project-types",
    "@steamharness/project-upload",
    "@steamharness/kanban-project",
    "@steamharness/runtime-compatibility",
    "@steamharness/workflow-ids",
    "@steamharness/i18n",
    "@modelcontextprotocol/sdk",
    "i18next",
    "zod",
  ],
  clean: true,
  dts: false,
});
