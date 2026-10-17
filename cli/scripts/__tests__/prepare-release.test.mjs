import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareRelease } from "../prepare-release.mjs";

test("CLI release preparation updates only the CLI release files", async () => {
  const root = await createFixture();
  try {
    const result = await prepareRelease({ root, version: "1.1.0", date: "2026-08-12" });
    assert.deepEqual(result, {
      unit: "steamharness-cli",
      version: "1.1.0",
      tag: "steamharness-cli/v1.1.0",
    });
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    assert.equal(manifest.version, "1.1.0");
    assert.equal(manifest.peerDependencies["steamharness"], ">=1.1.0 <1.2.0");
    assert.match(await readFile(path.join(root, "CHANGELOG.md"), "utf8"), /## 1\.1\.0 - 2026-08-12/);
    assert.equal(await readFile(path.join(root, "CHANGELOG.next.md"), "utf8"), "# Unreleased\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI release preparation rejects localized category drift without writing", async () => {
  const root = await createFixture();
  const manifestPath = path.join(root, "package.json");
  const before = await readFile(manifestPath, "utf8");
  try {
    await writeFile(path.join(root, "CHANGELOG.next.en.md"), "# Unreleased\n\n### Fixed\n\n- Fixed Independent release.\n", "utf8");
    await assert.rejects(
      prepareRelease({ root, version: "1.1.0", date: "2026-08-12" }),
      /matching sections, entry counts and order/,
    );
    assert.equal(await readFile(manifestPath, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI release preparation promotes the version already declared on alpha", async () => {
  const root = await createFixture();
  try {
    const manifestPath = path.join(root, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "1.1.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    const result = await prepareRelease({ root, version: "1.1.0", date: "2026-08-24" });
    assert.equal(result.version, "1.1.0");
    assert.match(await readFile(path.join(root, "CHANGELOG.md"), "utf8"), /## 1\.1\.0 - 2026-08-24/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI release preparation rejects a ranged Core dependency without writing", async () => {
  const root = await createFixture();
  const manifestPath = path.join(root, "package.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.devDependencies["steamharness"] = "^1.1.4";
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    const before = await readFile(manifestPath, "utf8");

    await assert.rejects(
      prepareRelease({ root, version: "1.1.0", date: "2026-08-24" }),
      /devDependencies\.steamharness must be an exact stable SemVer version/,
    );
    assert.equal(await readFile(manifestPath, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-release-"));
  await Promise.all([
    writeFile(path.join(root, "package.json"), '{"name":"@steamharness/cli","version":"1.0.0","peerDependencies":{"steamharness":">=1.0.0 <2.0.0"},"devDependencies":{"steamharness":"1.1.4"}}\n', "utf8"),
    writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## 1.0.0 - 2026-08-01\n\n### 修复\n\n- 修复 现有版本。\n", "utf8"),
    writeFile(path.join(root, "CHANGELOG.en.md"), "# Changelog\n\n## 1.0.0 - 2026-08-01\n\n### Fixed\n\n- Fixed Existing release.\n", "utf8"),
    writeFile(path.join(root, "CHANGELOG.next.md"), "# Unreleased\n\n### 新增\n\n- 新增 独立发布。\n", "utf8"),
    writeFile(path.join(root, "CHANGELOG.next.en.md"), "# Unreleased\n\n### Added\n\n- Added Independent release.\n", "utf8"),
  ]);
  return root;
}
