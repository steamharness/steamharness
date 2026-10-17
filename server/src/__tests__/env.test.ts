import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { inferServerEnvMode, resolveServerEnvFiles, shouldSkipServerEnvFiles } from "../env";

test("server env resolves dev files before falling back to shared defaults", () => {
  const files = resolveServerEnvFiles({
    repoRoot: "/repo",
    serverRoot: "/repo/server",
  }, "development");

  assert.deepEqual(files, [
    path.join("/repo/server", ".env"),
    path.join("/repo", ".env"),
  ]);
});

test("server env resolves production files before dev defaults", () => {
  const files = resolveServerEnvFiles({
    repoRoot: "/repo",
    serverRoot: "/repo/server",
  }, "production");

  assert.deepEqual(files, [
    path.join("/repo/server", ".env.production"),
    path.join("/repo", ".env.production"),
    path.join("/repo/server", ".env"),
    path.join("/repo", ".env"),
  ]);
});

test("server env mode keeps release startup out of WORKFLOW_SERVER_DEV defaults", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousServerDev = process.env.WORKFLOW_SERVER_DEV;

  delete process.env.NODE_ENV;
  delete process.env.WORKFLOW_SERVER_DEV;
  assert.equal(inferServerEnvMode(), "production");

  process.env.NODE_ENV = "development";
  assert.equal(inferServerEnvMode(), "development");

  delete process.env.NODE_ENV;
  process.env.WORKFLOW_SERVER_DEV = "1";
  assert.equal(inferServerEnvMode(), "development");

  if (previousNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previousNodeEnv;
  }
  if (previousServerDev === undefined) {
    delete process.env.WORKFLOW_SERVER_DEV;
  } else {
    process.env.WORKFLOW_SERVER_DEV = previousServerDev;
  }
});

test("internal aggregate runtimes can disable checkout env files", () => {
  assert.equal(shouldSkipServerEnvFiles({ WORKFLOW_SKIP_ENV_FILES: "1" }), true);
  assert.equal(shouldSkipServerEnvFiles({ WORKFLOW_SKIP_ENV_FILES: "0" }), false);
  assert.equal(shouldSkipServerEnvFiles({}), false);
});
