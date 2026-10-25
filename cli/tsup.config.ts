import { defineConfig } from "tsup";
import { checkoutServiceChannel } from "./vendor/shared/service-urls/node.mjs";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "es2022",
  // Prefix-only built-ins such as node:sqlite cannot resolve without node:.
  removeNodeProtocol: false,
  bundle: true,
  define: { __STEAMHARNESS_SERVICE_CHANNEL__: JSON.stringify(checkoutServiceChannel({ root: import.meta.dirname })) },
  external: ["steamharness"],
  // @steamharness/i18n is a TypeScript-only build dependency. Inline it and
  // i18next so the published CLI has no workspace-only runtime dependency.
  noExternal: [
    "@steamharness/auth-config",
    "@steamharness/service-urls",
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
