import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, loadEnv, searchForWorkspaceRoot } from "vite";
import { checkoutServiceChannel } from "../vendor/shared/service-urls/node.mjs";
import { publicServiceUrls } from "../vendor/shared/service-urls/index";

const allowedHosts = [
  "yuhe.space",
  ".yuhe.space",
  "hookcode.win",
  ".hookcode.win",
];
const localSourceMode = process.env.STEAMHARNESS_LOCAL_SOURCE_MODE === "1";
const localSharedRoot = process.env.STEAMHARNESS_LOCAL_SHARED_ROOT?.trim()
  ? resolve(process.env.STEAMHARNESS_LOCAL_SHARED_ROOT)
  : resolve(__dirname, "..", "..", "shared");
const localSharedAliases = localSourceMode ? readLocalSharedAliases(localSharedRoot) : [];

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, __dirname, ""), ...process.env };
  const serverProxyTarget = env.STEAMHARNESS_SERVER_WEB_PROXY || publicServiceUrls(checkoutServiceChannel({ root: __dirname, mode, env })).server;
  return {
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@", replacement: resolve(__dirname, "src") },
      ...localSharedAliases,
    ],
    dedupe: ["react", "react-dom"],
  },
  server: {
    allowedHosts,
    ...(localSourceMode
      ? { fs: { allow: [searchForWorkspaceRoot(__dirname), localSharedRoot] } }
      : {}),
    proxy: {
      "/api": serverProxyTarget,
      "/health": serverProxyTarget,
    },
  },
  preview: {
    allowedHosts,
  },
  build: {
    outDir: resolve(__dirname, "../public"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
      },
      output: {
        // Split the stable vendor libraries out of the app entry so browsers can
        // cache them across deploys; this also clears Vite's 500 kB chunk warning.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@mui/x-data-grid")) return "mui-datagrid";
          if (id.includes("@mui") || id.includes("@emotion")) return "mui";
          if (id.includes("/recharts/") || id.includes("/victory-vendor/") || id.includes("/d3-")) {
            return "recharts";
          }
          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/scheduler/")) {
            return "react-vendor";
          }
          return undefined;
        },
      },
    },
  },
  };
});

export function readLocalSharedAliases(root: string): Array<{ find: RegExp; replacement: string }> {
  const aliases: Array<{ find: RegExp; replacement: string }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let manifest: { name?: unknown; types?: unknown; main?: unknown; exports?: unknown };
    try {
      manifest = JSON.parse(readFileSync(resolve(root, entry.name, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (typeof manifest.name !== "string" || !manifest.name.startsWith("@steamharness/")) continue;
    const entrypoint = typeof manifest.types === "string" ? manifest.types : manifest.main;
    if (typeof entrypoint !== "string") continue;
    const packageRoot = resolve(root, entry.name);
    aliases.push(
      { find: new RegExp(`^${escapeRegExp(manifest.name)}$`), replacement: resolve(packageRoot, entrypoint) },
      ...readPackageExportAliases(manifest.name, packageRoot, manifest.exports),
      { find: new RegExp(`^${escapeRegExp(manifest.name)}/`), replacement: `${packageRoot}/` },
    );
  }
  return aliases;
}

function readPackageExportAliases(
  packageName: string,
  packageRoot: string,
  exportsField: unknown,
): Array<{ find: RegExp; replacement: string }> {
  if (exportsField === null || typeof exportsField !== "object" || Array.isArray(exportsField)) return [];
  const aliases: Array<{ find: RegExp; replacement: string }> = [];
  for (const [exportName, definition] of Object.entries(exportsField)) {
    if (!exportName.startsWith("./") || exportName === "." || exportName.includes("*")) continue;
    const target = readPackageExportTarget(definition);
    if (target === undefined) continue;
    aliases.push({
      find: new RegExp(`^${escapeRegExp(`${packageName}/${exportName.slice(2)}`)}$`),
      replacement: resolve(packageRoot, target),
    });
  }
  return aliases;
}

function readPackageExportTarget(definition: unknown): string | undefined {
  if (typeof definition === "string") return definition;
  if (definition === null || typeof definition !== "object" || Array.isArray(definition)) return undefined;
  const conditions = definition as Record<string, unknown>;
  for (const condition of ["import", "default", "types"]) {
    if (typeof conditions[condition] === "string") return conditions[condition];
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
