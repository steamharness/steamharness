import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSharedCompilerPaths, prepareDevelopmentSources } from "../development-sources.mjs";

test("development sources map Shared package entrypoints and subpaths to the sibling repository", async () => {
  const sharedRoot = await mkdtemp(path.join(os.tmpdir(), "steamharness-server-compiler-paths-"));
  await Promise.all([
    createPackage(sharedRoot, "i18n", { name: "@steamharness/i18n", types: "./index.ts" }),
    createPackage(sharedRoot, "project-types", { name: "@steamharness/project-types", main: "./index.ts" }),
    createPackage(sharedRoot, "release-tools", { name: "@steamharness/release-tools" }),
    createPackage(sharedRoot, "unrelated", { name: "unrelated", types: "./index.ts" }),
  ]);

  const paths = await createSharedCompilerPaths(sharedRoot);

  assert.deepEqual(paths["@steamharness/i18n"], [path.join(sharedRoot, "i18n", "index.ts")]);
  assert.deepEqual(paths["@steamharness/i18n/*"], [path.join(sharedRoot, "i18n", "*")]);
  assert.deepEqual(paths["@steamharness/project-types"], [path.join(sharedRoot, "project-types", "index.ts")]);
  assert.equal("@steamharness/release-tools" in paths, false);
  assert.equal("unrelated" in paths, false);
});

test("development sources repair the Core and Shared checkouts before generating the tsconfig", async () => {
  const splitRoot = await mkdtemp(path.join(os.tmpdir(), "steamharness-server-dev-sources-"));
  const serverRoot = path.join(splitRoot, "server");
  await mkdir(serverRoot, { recursive: true });
  await writeFile(path.join(serverRoot, "tsconfig.json"), "{}\n");
  const harnessRoot = await createSiblingRepository(splitRoot, "core", { name: "steamharness" });
  const sharedRoot = await createSiblingRepository(splitRoot, "shared", {
    name: "@steamharness/shared-workspace",
  });
  const ensured = [];

  const sources = await prepareDevelopmentSources({
    root: serverRoot,
    harnessRoot,
    sharedRoot,
    ensureSiblings: async ({ roots }) => {
      ensured.push(roots);
      return { installed: [], skipped: false };
    },
  });

  assert.deepEqual(ensured, [[sharedRoot, harnessRoot]]);
  assert.equal(sources.tsconfigPath, path.join(serverRoot, ".steamharness-local", "tsconfig.json"));
});

async function createPackage(root, directory, manifest) {
  const packageRoot = path.join(root, directory);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify(manifest)}\n`);
}

/**
 * The development branch assertion runs `git branch --show-current`, so the
 * fabricated checkout needs a HEAD symref even though it has no commits.
 */
async function createSiblingRepository(parent, directory, manifest) {
  const siblingRoot = path.join(parent, directory);
  await createPackage(parent, directory, manifest);
  execFileSync("git", ["init", "--quiet"], { cwd: siblingRoot });
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/dev"], { cwd: siblingRoot });
  return siblingRoot;
}
