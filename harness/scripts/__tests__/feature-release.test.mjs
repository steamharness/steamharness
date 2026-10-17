import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatBranchSlug,
  formatFeatureDate,
  nextFeatureVersion,
  parseFeatureVersions,
  readFeatureTag,
  writeFeatureVersion,
} from "../feature-release.mjs";

test("a feature version carries the branch and shares the day's sequence", () => {
  const planned = nextFeatureVersion({
    baseVersion: "0.2.4",
    branch: "codex/pi-agent",
    date: "20260920",
    tags: [],
  });

  // The marker is what keeps a feature build distinguishable from a channel
  // build, and the slug is what npm shows when someone reads the version.
  assert.equal(planned.version, "0.2.4-20260920001.codex-pi-agent");
  assert.equal(planned.tag, "feat/v0.2.4-20260920001.codex-pi-agent");
  assert.equal(planned.distTag, "feat-codex-pi-agent");
});

test("the day's sequence counts every release prefix, so nothing can collide", () => {
  // A dev build of the same day already spent 001; a feature build must not
  // claim it, because npm rejects a second tarball under a published version.
  const tags = [
    "refs/tags/dev/v0.2.4-20260920001",
    "refs/tags/alpha/v0.2.4-20260919004",
    "refs/tags/feat/v0.2.4-20260920002.codex-other",
    "refs/tags/0.2.4-20260920003.feat-elsewhere",
    "refs/tags/steamharness/v0.2.0",
  ];

  assert.deepEqual(
    parseFeatureVersions(tags, "20260920").map((entry) => entry.sequence).sort(),
    [1, 2, 3],
  );

  const planned = nextFeatureVersion({ baseVersion: "0.2.4", branch: "codex/pi-agent", date: "20260920", tags });
  assert.equal(planned.version, "0.2.4-20260920004.codex-pi-agent");
  assert.equal(planned.sequence, 4);
});

test("the day is Shanghai's, not the runner's", () => {
  // 2026-09-19T17:30Z is already the 20th where the release train keeps time.
  assert.equal(formatFeatureDate(new Date("2026-09-19T17:30:00Z")), "20260920");
  assert.equal(formatFeatureDate(new Date("2026-09-19T15:30:00Z")), "20260919");
});

test("a branch slug survives whatever a branch may be called", () => {
  assert.equal(formatBranchSlug("codex/pi-agent"), "codex-pi-agent");
  assert.equal(formatBranchSlug("Codex/Fix__Thing"), "codex-fix-thing");
  assert.equal(formatBranchSlug("feat/a.b"), "feat-a.b");
  assert.throws(() => formatBranchSlug("///"), /no usable slug/u);
});

test("the tag a pipeline reads back names the version and its channel", () => {
  assert.deepEqual(readFeatureTag("feat/v0.2.4-20260920001.codex-pi-agent"), {
    version: "0.2.4-20260920001.codex-pi-agent",
    tag: "feat/v0.2.4-20260920001.codex-pi-agent",
    distTag: "feat-codex-pi-agent",
  });
  // A channel tag is not a feature release, and neither is a malformed one.
  assert.throws(() => readFeatureTag("dev/v0.2.4-20260920001"), /invalid/u);
  assert.throws(() => readFeatureTag("steamharness/v0.2.0"), /invalid/u);
  assert.throws(() => readFeatureTag("feat/v0.2.4-20260920001"), /invalid/u);
});

test("a version that is not the declared base is refused", () => {
  assert.throws(
    () => nextFeatureVersion({ baseVersion: "0.2", branch: "codex/pi-agent", date: "20260920", tags: [] }),
    /base version is invalid/u,
  );
});

test("the manifest carries the feature version and nothing else changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "workflow-feature-release-"));
  try {
    const manifest = { name: "steamharness", version: "0.2.4", private: false, scripts: { build: "tsup" } };
    await writeFile(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const written = await writeFeatureVersion({
      root: dir,
      version: "0.2.4-20260920001.codex-pi-agent",
    });
    assert.deepEqual(written, { packageName: "steamharness", version: "0.2.4-20260920001.codex-pi-agent" });

    const after = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    assert.equal(after.version, "0.2.4-20260920001.codex-pi-agent");
    assert.equal(after.scripts.build, "tsup");

    // The channel shape belongs to the channels: a version the shared tooling
    // would read as one of theirs must not be written here either.
    await assert.rejects(
      () => writeFeatureVersion({ root: dir, version: "0.2.4-20260920002" }),
      /version is invalid/u,
    );
    await assert.rejects(
      () => writeFeatureVersion({ root: dir, version: "0.2.5-20260920003.codex-pi-agent" }),
      /does not match package\.json/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
