import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("alpha CI publishes immutable npm packages and propagates exact Core versions", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "../../.gitlab-ci.yml"), "utf8");
  assert.match(source, /workflow:\s*\n\s+auto_cancel:\s*\n\s+on_job_failure: all/u);
  assert.match(source, /release:npm:alpha:[\s\S]*?npm-alpha-publish\.mjs steamharness "\$ALPHA_VERSION" \.release\/alpha/u);
  assert.match(source, /alpha-dependencies\.mjs --skip-ci[\s\S]*?cli\|package\.json\|devDependencies[\s\S]*?cli\|package\.json\|peerDependencies/u);
  assert.match(source, /snapshot:alpha:[\s\S]*?workspace-snapshot\.mjs --skip-ci --submodule core/u);
  assert.match(source, /retention:alpha:[\s\S]*?alpha-retention\.mjs --job-name release:npm:alpha --retain 3/u);
  assert.match(source, /trigger:cli:alpha:[\s\S]*?needs:[\s\S]*?job: alpha:prepare[\s\S]*?artifacts: true[\s\S]*?job: retention:alpha[\s\S]*?STEAMHARNESS_ALPHA_CASCADE: "true"[\s\S]*?project: "\$CI_PROJECT_NAMESPACE\/cli"[\s\S]*?strategy: mirror/u);
  assert.doesNotMatch(source, /trigger:cli:alpha:[\s\S]*?STEAMHARNESS_ALPHA_CHANGED:/u);
});

test("dev npm publication is explicit, immutable, and isolated from the alpha cascade", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "../../.gitlab-ci.yml"), "utf8");
  assert.match(source, /dev:prepare:[\s\S]*?STEAMHARNESS_NPM_DEV_RELEASE == "true"[\s\S]*?--tag-prefix dev\/v --branch dev --env-prefix DEV --output \.dev\.env/u);
  assert.match(source, /release:npm:dev:[\s\S]*?name: dev[\s\S]*?STEAMHARNESS_NPM_DEV_RELEASE == "true"[\s\S]*?npm-alpha-publish\.mjs steamharness "\$DEV_VERSION" \.release\/dev dev/u);
});

test("every npm publish is gated by the release gate before it can pack", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "../../.gitlab-ci.yml"), "utf8");
  for (const job of ["release:npm", "release:npm:alpha", "release:npm:dev", "release:npm:feature"]) {
    const section = source.slice(source.indexOf(`\n${job}:\n`));
    const body = section.slice(0, section.indexOf("\n\n"));
    assert.match(
      body,
      /release-gate\.mjs publisher --manifest package\.json --package steamharness/u,
      `${job} must run the publisher gate`,
    );
    // The gate must reject a bad version before anything is packed or pushed.
    // It cannot run earlier than the version is written into package.json.
    const packAt = ["pnpm pack", "pnpm publish", "feature-release.mjs publish"]
      .map((step) => body.indexOf(step))
      .filter((index) => index !== -1);
    assert.equal(packAt.length > 0, true, `${job} must pack or publish`);
    assert.equal(
      body.indexOf("release-gate.mjs publisher") < Math.min(...packAt),
      true,
      `${job} must gate before it packs or publishes`,
    );
  }
});

test("a feature branch publishes from its own tag, without touching a channel", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "../../.gitlab-ci.yml"), "utf8");

  // The tag is the whole trigger: a feature branch gets no branch pipeline, so
  // nothing publishes until the reserving script pushes `feat/v<version>`. It
  // gates the pipeline itself and both of its jobs.
  const featureTagPattern = "feat\\/v\\d+\\.\\d+\\.\\d+-\\d{11}";
  assert.equal(
    source.split(featureTagPattern).length - 1 >= 3,
    true,
    "the feat tag rule must gate the workflow rule and both feature jobs",
  );
  assert.match(source, /feature:prepare:[\s\S]*?CI_COMMIT_TAG =~ \/\^feat[\s\S]*?feature-release\.mjs env --output \.feature\.env/u);
  assert.match(source, /release:npm:feature:[\s\S]*?needs:[\s\S]*?job: feature:prepare[\s\S]*?feature-release\.mjs version --version "\$FEATURE_VERSION"/u);
  assert.match(source, /release:npm:feature:[\s\S]*?feature-release\.mjs publish --version "\$FEATURE_VERSION" --dist-tag "\$FEATURE_DIST_TAG"/u);

  // No channel job may pick the tag up, and no downstream project is synced:
  // the feature branch bumps the pins it needs itself.
  assert.doesNotMatch(source, /alpha:prepare:[\s\S]{0,400}?feat\//u);
  assert.doesNotMatch(source, /release:npm:feature:[\s\S]{0,800}?alpha-dependencies\.mjs/u);
  assert.doesNotMatch(source, /release:npm:feature:[\s\S]{0,800}?workspace-snapshot\.mjs/u);
});
