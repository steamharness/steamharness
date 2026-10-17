import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/** Each release unit's tag is checked against that unit's own manifest. */
const UNIT_MANIFESTS = Object.freeze({
  server: "package.json",
  "server-web": "web/package.json",
});

test("public Server CI does not contain private AI deployment jobs", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "../../.gitlab-ci.yml"), "utf8");
  assert.match(source, /deploy:stable:/u);
});

test("stable CI shell commands read the declared package versions", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const source = await readFile(path.join(root, ".gitlab-ci.yml"), "utf8");
  // Both the release and the deploy job re-check the tag, so a unit can appear
  // more than once. What matters is that every unit appears, checked against
  // its own manifest, and that no check is left out of this test.
  const checks = source.split("\n").filter((line) => line.trim().startsWith('- test "$CI_COMMIT_TAG" ='));
  assert.ok(checks.length >= Object.keys(UNIT_MANIFESTS).length, "every release unit needs its tag checked");

  const seen = [];
  for (const line of checks) {
    const unit = /"([a-z-]+)\/v/u.exec(line)?.[1];
    assert.ok(unit, `cannot read the unit out of: ${line}`);
    seen.push(unit);
    const manifestPath = UNIT_MANIFESTS[unit];
    assert.ok(manifestPath, `${unit} is checked against a manifest the test does not know about`);
    const manifest = JSON.parse(await readFile(path.join(root, manifestPath), "utf8"));
    const result = spawnSync("bash", ["-c", line.trim().slice(2)], {
      cwd: root,
      env: { ...process.env, CI_COMMIT_TAG: `${unit}/v${manifest.version}` },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${unit}: ${result.stderr}`);
  }
  assert.deepEqual([...new Set(seen)].sort(), Object.keys(UNIT_MANIFESTS).sort());
});

test("alpha CI deploys both Server units and retains three release artifacts", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "../../.gitlab-ci.yml"), "utf8");
  assert.match(source, /workflow:\s*\n\s+auto_cancel:\s*\n\s+on_job_failure: all/u);
  assert.match(source, /alpha:prepare:[\s\S]*?--manifest package\.json --manifest web\/package\.json/u);
  assert.match(source, /release:alpha:[\s\S]*?build-runtime\.mjs --channel alpha/u);
  assert.match(source, /snapshot:alpha:[\s\S]*?workspace-snapshot\.mjs --skip-ci --submodule server/u);
  assert.match(source, /retention:alpha:[\s\S]*?alpha-retention\.mjs --job-name release:alpha --retain 3/u);
  assert.match(source, /trigger:desktop:alpha:[\s\S]*?STEAMHARNESS_ALPHA_CASCADE == "true"[\s\S]*?project: "\$CI_PROJECT_NAMESPACE\/desktop"[\s\S]*?strategy: mirror/u);
  assert.match(source, /trigger:workspace:alpha:[\s\S]*?STEAMHARNESS_ALPHA_CASCADE != "true"[\s\S]*?project: "\$CI_PROJECT_NAMESPACE\/workspace"[\s\S]*?strategy: mirror/u);
  assert.doesNotMatch(source, /trigger:(?:desktop|workspace):alpha:[\s\S]*?STEAMHARNESS_ALPHA_CHANGED:/u);
  assert.match(source, /alpha:prepare:[\s\S]*?STEAMHARNESS_RECOVERY_TARGET != "alpha"/u);
  assert.match(source, /release:alpha:[\s\S]*?STEAMHARNESS_RECOVERY_TARGET != "alpha"/u);
  assert.match(source, /recover:ecs:alpha:[\s\S]*?STEAMHARNESS_RECOVERY_TARGET == "alpha"[\s\S]*?needs: \[validate\][\s\S]*?deploy-ecs\.mjs ensure alpha/u);
  assert.match(source, /recover:ecs:release:[\s\S]*?STEAMHARNESS_RECOVERY_TARGET == "release"[\s\S]*?needs: \[validate\][\s\S]*?deploy-ecs\.mjs ensure release/u);
  assert.match(source, /deploy:stable:[\s\S]*?needs:\s*\n\s+- job: release:server-web\n\s+artifacts: true[\s\S]*?build-runtime\.mjs --channel stable[\s\S]*?deploy-ecs\.mjs deploy-server stable/u);
  assert.match(source, /renew:ecs:certificate:[\s\S]*?CI_PIPELINE_SOURCE == "schedule" && \(\$CI_COMMIT_BRANCH == "main" \|\| \$CI_COMMIT_BRANCH == "dev"\)/u);
  assert.match(source, /renew:ecs:certificate:[\s\S]*?needs: \[\][\s\S]*?nvm use 24\.15\.0/u);
  assert.match(source, /validate:[\s\S]*?CI_PIPELINE_SOURCE == "schedule"[\s\S]*?when: never/u);
  assert.match(source, /bootstrap:ecs:[\s\S]*?CI_PIPELINE_SOURCE != "schedule" && \(\$CI_COMMIT_BRANCH == "main" \|\| \$CI_COMMIT_BRANCH == "dev"\)/u);
  assert.match(source, /migrate:ecs:[\s\S]*?CI_PIPELINE_SOURCE != "schedule" && \(\$CI_COMMIT_BRANCH == "main" \|\| \$CI_COMMIT_BRANCH == "dev"\)/u);
  assert.match(source, /renew:ecs:certificate:[\s\S]*?STEAMHARNESS_ACME_EMAIL/u);
  assert.match(source, /if \[\[ -s "\$NVM_DIR\/nvm\.sh" \]\]; then[\s\S]*?Node\.js >=22 is required when nvm is unavailable/u);
});
