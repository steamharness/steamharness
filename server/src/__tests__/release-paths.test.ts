import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveDocsRoot, resolveServerDataRootFromEnv } from "../release-paths";

test("server release paths keep production data on STEAMHARNESS_RELEASE_STORAGE_ROOT for issue #97", () => {
  const previousReleaseRoot = process.env.STEAMHARNESS_RELEASE_STORAGE_ROOT;
  const previousServerDataDir = process.env.STEAMHARNESS_SERVER_DATA_DIR;
  const previousServerDeployDir = process.env.STEAMHARNESS_SERVER_DEPLOY_DIR;
  const previousDocsRoot = process.env.STEAMHARNESS_DOCS_ROOT;

  try {
    const releaseRoot = path.resolve("test-release-root");
    const serverRoot = path.resolve("test-server-root");
    const customServerData = path.join(releaseRoot, "custom-server-data");
    const customDocsRoot = path.join(releaseRoot, "custom-docs-root");
    process.env.STEAMHARNESS_RELEASE_STORAGE_ROOT = releaseRoot;
    delete process.env.STEAMHARNESS_SERVER_DATA_DIR;
    delete process.env.STEAMHARNESS_SERVER_DEPLOY_DIR;
    delete process.env.STEAMHARNESS_DOCS_ROOT;

    assert.equal(
      resolveServerDataRootFromEnv({
        serverRoot,
        mode: "production",
      }),
      path.join(releaseRoot, "server-data"),
    );

    assert.equal(
      resolveServerDataRootFromEnv({
        serverRoot,
        mode: "development",
      }),
      path.join(serverRoot, ".data"),
    );

    process.env.STEAMHARNESS_SERVER_DATA_DIR = customServerData;
    assert.equal(
      resolveServerDataRootFromEnv({
        serverRoot,
        mode: "production",
      }),
      customServerData,
    );

    assert.equal(
      resolveDocsRoot(),
      path.join(releaseRoot, "published", "docs", "stable"),
    );

    process.env.STEAMHARNESS_DOCS_ROOT = customDocsRoot;
    assert.equal(resolveDocsRoot(), customDocsRoot);
  } finally {
    restoreEnv("STEAMHARNESS_RELEASE_STORAGE_ROOT", previousReleaseRoot);
    restoreEnv("STEAMHARNESS_SERVER_DATA_DIR", previousServerDataDir);
    restoreEnv("STEAMHARNESS_SERVER_DEPLOY_DIR", previousServerDeployDir);
    restoreEnv("STEAMHARNESS_DOCS_ROOT", previousDocsRoot);
  }
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
