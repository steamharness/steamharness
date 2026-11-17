import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * Guard for the published @steamharness/cli manifest.
 *
 * `dependencies` in the packed tarball is installed by npm. Anything listed
 * there that is a private workspace package (private: true, never published)
 * makes the tarball uninstallable: npm resolves it against the registry and
 * fails with E404. Workspace internals that are bundled into `dist/` by tsup
 * (see `noExternal` in tsup.config.ts) belong to `devDependencies`.
 */

const cliRoot = path.resolve(import.meta.dirname, "../..");
const workspaceRoot = path.resolve(cliRoot, "..");

async function readManifest(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

/** Every workspace package that declares `private: true`, by name. */
async function privateWorkspacePackages() {
  const privatePackages = new Set();
  const roots = ["shared", "harness", "cli", "server", "server/web"];
  for (const root of roots) {
    const manifestPath = path.join(workspaceRoot, root, "package.json");
    try {
      const manifest = await readManifest(manifestPath);
      if (manifest.private === true) privatePackages.add(manifest.name);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const sharedDir = path.join(workspaceRoot, "shared");
  for (const entry of await readdir(sharedDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(sharedDir, entry.name, "package.json");
    try {
      const manifest = await readManifest(manifestPath);
      if (manifest.private === true) privatePackages.add(manifest.name);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return privatePackages;
}

test("published CLI runtime dependencies exclude private workspace packages", async () => {
  const manifest = await readManifest(path.join(cliRoot, "package.json"));
  const privatePackages = await privateWorkspacePackages();
  assert.ok(privatePackages.has("@steamharness/server-auth"), "fixture check: server-auth must be private");
  assert.ok(privatePackages.has("@steamharness/avatar-fallback"), "fixture check: avatar-fallback must be private");
  const offenders = Object.keys(manifest.dependencies ?? {})
    .filter((name) => privatePackages.has(name));
  assert.deepEqual(
    offenders,
    [],
    "private workspace packages cannot be published runtime dependencies; "
    + "bundle them with tsup noExternal and declare them in devDependencies instead",
  );
});

test("bundled workspace internals stay in the tsup noExternal list", async () => {
  const manifest = await readManifest(path.join(cliRoot, "package.json"));
  const config = await readFile(path.join(cliRoot, "tsup.config.ts"), "utf8");
  const noExternalBlock = /noExternal:\s*\[([^\]]*)\]/u.exec(config);
  assert.ok(noExternalBlock, "tsup.config.ts must declare a noExternal list");
  const bundled = new Set(
    [...noExternalBlock[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]),
  );
  for (const name of ["@steamharness/server-auth", "@steamharness/avatar-fallback"]) {
    assert.ok(
      bundled.has(name),
      `${name} must remain in tsup noExternal while it is a devDependency`,
    );
    assert.ok(
      !(name in (manifest.dependencies ?? {})),
      `${name} must not be a runtime dependency of the published manifest`,
    );
  }
});
