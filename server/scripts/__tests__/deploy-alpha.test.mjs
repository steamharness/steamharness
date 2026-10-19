import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAlphaDeploymentCanAdvance,
  recoverAlphaRelease,
  resolveAlphaDeploymentPaths,
  runCommand,
  selectAlphaReleasesToPrune,
} from "../deploy-alpha.mjs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("alpha deployment isolates code, runtime state and cache from stable", () => {
  const paths = resolveAlphaDeploymentPaths("/srv/steamharness-release");
  assert.equal(paths.currentLink, "/srv/steamharness-release/deployments/server/alpha/current");
  assert.equal(paths.dataRoot, "/srv/steamharness-release/server-data/alpha");
  assert.equal(paths.runRoot, "/srv/steamharness-release/deployments/server/alpha/run");
});

test("alpha deployment retention keeps the newest three versions", async () => {
  assert.deepEqual(await selectAlphaReleasesToPrune({
    releases: [
      "0.1.5-20260814004",
      "0.1.5-20260814001",
      ".staging-incomplete",
      "0.1.5-20260814003",
      "0.1.5-20260814002",
    ],
    currentVersion: "0.1.5-20260814004",
  }), ["0.1.5-20260814001"]);
});

test("alpha deployment retries the same version but rejects an older queued pipeline", () => {
  assert.doesNotThrow(() => assertAlphaDeploymentCanAdvance(
    "0.1.5-20260814004",
    "0.1.5-20260814004",
  ));
  assert.throws(() => assertAlphaDeploymentCanAdvance(
    "0.1.5-20260814004",
    "0.1.5-20260814003",
  ), /superseded by the deployed version/);
});

test("alpha deployment command runner reports non-zero exits", async () => {
  await assert.doesNotReject(runCommand(process.execPath, ["-e", "process.exit(0)"]));
  await assert.rejects(
    runCommand(process.execPath, ["-e", "process.exit(7)"]),
    /exited 7/,
  );
});

test("alpha recovery restarts the deployed current release without reserving a new version", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "steamharness-alpha-recovery-")));
  const paths = resolveAlphaDeploymentPaths(root);
  const version = "0.1.5-20260815001";
  const releaseDir = path.join(paths.releasesRoot, version);
  await mkdir(releaseDir, { recursive: true });
  await writeFile(path.join(releaseDir, "alpha-release.json"), JSON.stringify({ channel: "alpha", version }));
  await symlink(path.relative(path.dirname(paths.currentLink), releaseDir), paths.currentLink);
  const calls = [];
  const result = await recoverAlphaRelease({
    releaseRoot: root,
    stopProcess: async () => calls.push("stop"),
    startProcess: async (_paths, options) => calls.push(options.expectedVersion),
  });
  assert.deepEqual(calls, ["stop", version]);
  assert.equal(result.version, version);
  await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
});
