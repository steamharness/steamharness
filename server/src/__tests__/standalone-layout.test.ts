import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

test("standalone Server retains Server Web but has no App Web Studio host", () => {
  assert.equal(existsSync(path.join(root, "web", "package.json")), true);
  assert.equal(existsSync(path.join(root, "scripts", "studio-server.mjs")), false);
  assert.equal(existsSync(path.join(root, "scripts", "studio-launchd.mjs")), false);
  assert.equal(existsSync(path.join(root, "src", "studio-sync-runner.ts")), false);
  assert.equal(existsSync(path.join(root, "src", "studio-workspace-sync.ts")), false);
});

test("standalone Server build has no Studio sync entrypoint", () => {
  const source = readFileSync(path.join(root, "tsup.config.ts"), "utf8");
  assert.doesNotMatch(source, /studio-sync-runner/);
});

test("standalone Server scripts do not import the former monorepo root", () => {
  const deploySource = readFileSync(path.join(root, "scripts", "deploy.mjs"), "utf8");
  const migrationSource = readFileSync(
    path.join(root, "scripts", "migrate-workspace-projects.mjs"),
    "utf8",
  );

  assert.match(deploySource, /from "\.\/release-storage\.mjs"/);
  assert.doesNotMatch(deploySource, /\.\.\/\.\.\/scripts/);
  assert.match(deploySource, /Run `pnpm build` before starting the deployment/);
  assert.doesNotMatch(deploySource, /pnpm -C server/);
  assert.equal(existsSync(path.join(root, "docker", "download")), false);
  assert.equal(existsSync(path.join(root, "scripts", "download-server.mjs")), false);
  assert.equal(existsSync(path.join(root, "scripts", "download-launchd.mjs")), false);
  assert.match(migrationSource, /STEAMHARNESS_WORKSPACE_ROOT/);
  assert.match(migrationSource, /"harness", "workspace", "workflow"/);
  assert.doesNotMatch(migrationSource, /"\.\.\/\.\."/);
});
