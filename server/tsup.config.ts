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
    "@workflow-code/project-card-metadata",
    "@workflow-code/project-dependencies",
    "@workflow-code/project-info",
    "@workflow-code/project-types",
    "@workflow-code/project-upload",
    "@workflow-code/kanban-project",
    "@workflow-code/runtime-compatibility",
    "@workflow-code/workflow-ids",
    "@workflow-code/i18n",
    "@modelcontextprotocol/sdk",
    "i18next",
    "zod",
  ],
  clean: true,
  dts: false,
});
