import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareSharedPackages } from "../prepare-shared.mjs";
import { resolveRepositoryMode } from "../repository-mode.mjs";

test("prepare-shared copies vendored Shared package directories on development branches", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-shared-"));
  const root = path.join(parent, "cli");
  const shared = path.join(parent, "shared");
  const vendor = path.join(root, "vendor", "shared");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await Promise.all([
    createPackage(shared, "i18n", "@steamharness/i18n"),
    createPackage(shared, "project-types", "@steamharness/project-types"),
    createPackage(shared, "unrelated", "unrelated"),
    createPackage(vendor, "i18n", "@steamharness/i18n", "vendor"),
    createPackage(vendor, "project-types", "@steamharness/project-types", "vendor"),
    mkdir(path.join(shared, "coverage"), { recursive: true }),
  ]);

  const result = await prepareSharedPackages({ root, env: {}, branch: "dev" });
  assert.deepEqual(result.packages, ["i18n", "project-types"]);
  assert.equal(result.source, vendor);
  assert.equal(result.strategy, "copied");
  assert.equal((await lstat(path.join(root, ".shared", "i18n"))).isSymbolicLink(), false);
  assert.equal(JSON.parse(await readFile(path.join(root, ".shared", "i18n", "package.json"), "utf8")).name, "@steamharness/i18n");
  assert.equal(await exists(path.join(root, ".shared", "i18n", "__tests__")), false);
  assert.equal(await exists(path.join(root, ".shared", "i18n", "node_modules")), false);
  assert.equal(await readFile(path.join(root, ".shared", "i18n", "source.txt"), "utf8"), "vendor");
  assert.equal(await exists(path.join(root, ".shared", "unrelated")), false);
});

test("prepare-shared copies vendor packages on main", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-main-shared-"));
  const root = path.join(parent, "cli");
  const sibling = path.join(parent, "shared");
  const vendor = path.join(root, "vendor", "shared");
  await Promise.all([
    createPackage(sibling, "i18n", "@steamharness/i18n", "sibling"),
    createPackage(vendor, "i18n", "@steamharness/i18n", "vendor"),
  ]);
  const result = await prepareSharedPackages({ root, env: {}, branch: "main" });
  assert.equal(result.source, vendor);
  assert.equal(result.strategy, "copied");
  assert.equal((await lstat(path.join(root, ".shared", "i18n"))).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(root, ".shared", "i18n", "source.txt"), "utf8"), "vendor");
});

test("prepare-shared copies vendor packages in CI on a development branch", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-ci-shared-"));
  const root = path.join(parent, "cli");
  const sibling = path.join(parent, "shared");
  const vendor = path.join(root, "vendor", "shared");
  await Promise.all([
    createPackage(sibling, "i18n", "@steamharness/i18n", "sibling"),
    createPackage(vendor, "i18n", "@steamharness/i18n", "vendor"),
  ]);
  const result = await prepareSharedPackages({ root, env: { CI: "true" }, branch: "dev" });
  assert.equal(result.mode, "dev");
  assert.equal(result.strategy, "copied");
  assert.equal(result.source, vendor);
  assert.equal((await lstat(path.join(root, ".shared", "i18n"))).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(root, ".shared", "i18n", "source.txt"), "utf8"), "vendor");
});

test("prepare-shared preserves installed dependencies while refreshing package sources", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-refresh-shared-"));
  const root = path.join(parent, "cli");
  const vendor = path.join(root, "vendor", "shared");
  const prepared = path.join(root, ".shared");
  const legacySource = path.join(parent, "legacy-project-types");
  await Promise.all([
    createPackage(vendor, "i18n", "@steamharness/i18n", "refreshed"),
    createPackage(vendor, "project-types", "@steamharness/project-types", "refreshed"),
    mkdir(path.join(prepared, "i18n", "node_modules"), { recursive: true }),
    mkdir(path.join(prepared, "removed", "node_modules"), { recursive: true }),
    mkdir(path.join(legacySource, "node_modules"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(prepared, "i18n", "node_modules", "install.marker"), "installed"),
    writeFile(path.join(prepared, "i18n", "stale-source.ts"), "stale"),
  ]);
  await symlink(legacySource, path.join(prepared, "project-types"), process.platform === "win32" ? "junction" : "dir");

  await prepareSharedPackages({ root, env: {}, branch: "dev" });

  assert.equal(await readFile(path.join(prepared, "i18n", "node_modules", "install.marker"), "utf8"), "installed");
  assert.equal(await exists(path.join(prepared, "i18n", "stale-source.ts")), false);
  assert.equal(await exists(path.join(prepared, "removed")), false);
  assert.equal((await lstat(path.join(prepared, "project-types"))).isSymbolicLink(), false);
  assert.equal(await exists(path.join(prepared, "project-types", "node_modules")), false);
  assert.equal(await readFile(path.join(prepared, "project-types", "source.txt"), "utf8"), "refreshed");
});

test("repository mode fails closed for tags and detached checkouts", () => {
  assert.equal(resolveRepositoryMode({ env: {}, branch: "dev" }), "dev");
  assert.equal(resolveRepositoryMode({ env: {}, branch: "main" }), "main");
  assert.equal(resolveRepositoryMode({ env: { CI_COMMIT_TAG: "steamharness-cli/v1.0.0", CI_COMMIT_BRANCH: "dev" } }), "main");
  assert.equal(resolveRepositoryMode({ env: {}, branch: "" }), "main");
  assert.throws(() => resolveRepositoryMode({ env: { STEAMHARNESS_REPOSITORY_MODE: "dev" }, branch: "main" }), /only accepts main/);
});

async function createPackage(root, directory, name, source = "source") {
  const packageRoot = path.join(root, directory);
  await mkdir(path.join(packageRoot, "__tests__"), { recursive: true });
  await mkdir(path.join(packageRoot, "node_modules"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({ name })}\n`);
  await writeFile(path.join(packageRoot, "source.txt"), source);
}

async function exists(target) {
  return lstat(target).then(() => true, () => false);
}
