import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("Workspace smoke uses the package-manager version declared by Core", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

  assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal(
    manifest.scripts["test:workspace"],
    "corepack pnpm build && corepack pnpm -C workspace install --frozen-lockfile && corepack pnpm -C workspace test",
  );
});

test("published Core exports resolve only from the built package", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const publishedExports = Object.fromEntries(Object.entries(manifest.exports).map(([name, conditions]) => [
    name,
    Object.fromEntries(Object.entries(conditions).filter(([condition]) => condition !== "development")),
  ]));

  assert.deepEqual(manifest.publishConfig.exports, publishedExports);
  assert.equal(JSON.stringify(manifest.publishConfig.exports).includes("./src/"), false);
});
