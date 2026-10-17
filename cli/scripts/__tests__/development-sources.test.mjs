import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSharedCompilerPaths } from "../development-sources.mjs";

test("development sources map Shared package entrypoints and subpaths to the sibling repository", async () => {
  const sharedRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-compiler-paths-"));
  await Promise.all([
    createPackage(sharedRoot, "i18n", { name: "@workflow-code/i18n", types: "./index.ts" }),
    createPackage(sharedRoot, "project-types", { name: "@workflow-code/project-types", main: "./index.ts" }),
    createPackage(sharedRoot, "release-tools", { name: "@workflow-code/release-tools" }),
    createPackage(sharedRoot, "unrelated", { name: "unrelated", types: "./index.ts" }),
  ]);

  const paths = await createSharedCompilerPaths(sharedRoot);

  assert.deepEqual(paths["@workflow-code/i18n"], [path.join(sharedRoot, "i18n", "index.ts")]);
  assert.deepEqual(paths["@workflow-code/i18n/*"], [path.join(sharedRoot, "i18n", "*")]);
  assert.deepEqual(paths["@workflow-code/project-types"], [path.join(sharedRoot, "project-types", "index.ts")]);
  assert.equal("@workflow-code/release-tools" in paths, false);
  assert.equal("unrelated" in paths, false);
});

async function createPackage(root, directory, manifest) {
  const packageRoot = path.join(root, directory);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify(manifest)}\n`);
}
