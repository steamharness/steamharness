import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveDocsRoot, resolveServerDataRootFromEnv } from "../release-paths";

test("server release paths keep production data on WORKFLOW_RELEASE_STORAGE_ROOT for issue #97", () => {
  const previousReleaseRoot = process.env.WORKFLOW_RELEASE_STORAGE_ROOT;
  const previousServerDataDir = process.env.WORKFLOW_SERVER_DATA_DIR;
  const previousServerDeployDir = process.env.WORKFLOW_SERVER_DEPLOY_DIR;
  const previousDocsRoot = process.env.WORKFLOW_DOCS_ROOT;

  try {
    const releaseRoot = path.resolve("test-release-root");
    const serverRoot = path.resolve("test-server-root");
    const customServerData = path.join(releaseRoot, "custom-server-data");
    const customDocsRoot = path.join(releaseRoot, "custom-docs-root");
    process.env.WORKFLOW_RELEASE_STORAGE_ROOT = releaseRoot;
    delete process.env.WORKFLOW_SERVER_DATA_DIR;
    delete process.env.WORKFLOW_SERVER_DEPLOY_DIR;
    delete process.env.WORKFLOW_DOCS_ROOT;

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

    process.env.WORKFLOW_SERVER_DATA_DIR = customServerData;
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

    process.env.WORKFLOW_DOCS_ROOT = customDocsRoot;
    assert.equal(resolveDocsRoot(), customDocsRoot);
  } finally {
    restoreEnv("WORKFLOW_RELEASE_STORAGE_ROOT", previousReleaseRoot);
    restoreEnv("WORKFLOW_SERVER_DATA_DIR", previousServerDataDir);
    restoreEnv("WORKFLOW_SERVER_DEPLOY_DIR", previousServerDeployDir);
    restoreEnv("WORKFLOW_DOCS_ROOT", previousDocsRoot);
  }
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
