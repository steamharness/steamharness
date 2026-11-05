import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareRelease } from "../prepare-release.mjs";

const releaseFiles = ["package.json", "CHANGELOG.md", "CHANGELOG.en.md", "CHANGELOG.next.md", "CHANGELOG.next.en.md"];

test("Core release preparation archives bilingual notes without an example workspace", async (t) => {
  const root = await createFixture(t);
  const manifest = await fs.readFile(path.join(root, "package.json"), "utf8");
  const result = await prepareRelease({ root, version: "1.1.0", date: "2026-08-12" });

  assert.deepEqual(result, { unit: "steamharness", version: "1.1.0", tag: "steamharness/v1.1.0", synchronizedPackages: [] });
  assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), manifest);
  assert.match(await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8"), /## 1\.1\.0 - 2026-08-12/);
  assert.match(await fs.readFile(path.join(root, "CHANGELOG.en.md"), "utf8"), /Added Independent release/);
  for (const filename of ["CHANGELOG.next.md", "CHANGELOG.next.en.md"]) {
    assert.equal(await fs.readFile(path.join(root, filename), "utf8"), "# Unreleased\n");
  }
  assert.deepEqual((await fs.readdir(root)).sort(), [...releaseFiles].sort());
});

test("Core release preparation restores every file after a changelog write fails", async (t) => {
  const root = await createFixture(t);
  const before = new Map(await Promise.all(releaseFiles.map(async file => [
    file, await fs.readFile(path.join(root, file), "utf8"),
  ])));
  const originalWrite = fs.writeFile;
  let failed = false;
  t.mock.method(fs, "writeFile", async (filename, ...args) => {
    if (filename === path.join(root, "CHANGELOG.en.md") && !failed) {
      failed = true;
      assert.notEqual(await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8"), before.get("CHANGELOG.md"));
      // Model a partial write, not just a failure before any bytes were changed.
      await originalWrite(filename, "partial write");
      throw new Error("changelog write failed");
    }
    return originalWrite(filename, ...args);
  });

  await assert.rejects(prepareRelease({ root, version: "1.1.0" }), /changelog write failed/);
  assert.equal(failed, true);
  for (const [filename, contents] of before) {
    assert.equal(await fs.readFile(path.join(root, filename), "utf8"), contents, filename);
  }
});

test("Core release preparation validates the source version and bilingual notes before writing", async (t) => {
  const root = await createFixture(t);
  const before = await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8");
  await assert.rejects(prepareRelease({ root, version: "1.1.0-alpha.1" }), /stable X.Y.Z/);
  await assert.rejects(prepareRelease({ root, version: "1.2.0" }), /package.json must be changed/);
  await fs.writeFile(path.join(root, "CHANGELOG.next.en.md"), "# Unreleased\n");
  await assert.rejects(prepareRelease({ root, version: "1.1.0" }));
  assert.equal(await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8"), before);
});

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "steamharness-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all([
    fs.writeFile(path.join(root, "package.json"), '{"name":"steamharness","version":"1.1.0"}\n'),
    fs.writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## 1.0.0 - 2026-08-01\n\n### 修复\n\n- 修复 现有版本。\n"),
    fs.writeFile(path.join(root, "CHANGELOG.en.md"), "# Changelog\n\n## 1.0.0 - 2026-08-01\n\n### Fixed\n\n- Fixed Existing release.\n"),
    fs.writeFile(path.join(root, "CHANGELOG.next.md"), "# Unreleased\n\n### 新增\n\n- 新增 独立发布。\n"),
    fs.writeFile(path.join(root, "CHANGELOG.next.en.md"), "# Unreleased\n\n### Added\n\n- Added Independent release.\n"),
  ]);
  return root;
}
