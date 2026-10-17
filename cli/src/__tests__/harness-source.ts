import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The harness package root the fixtures install into their generated projects.
 * The module runner cannot resolve a linked workspace package, so the
 * environment (set by vitest.config.ts) decides; `import.meta.resolve` is the
 * published-install path.
 */
export async function resolveHarnessRoot(): Promise<string> {
  const configured = process.env.STEAMHARNESS_LOCAL_HARNESS_ROOT?.trim();
  if (configured) return path.resolve(configured);
  let root = path.dirname(fileURLToPath(import.meta.resolve("steamharness")));
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = await readFile(path.join(root, "package.json"), "utf8").catch(() => "{}");
    if (JSON.parse(manifest).name === "steamharness") return root;
    root = path.dirname(root);
  }
  return root;
}
