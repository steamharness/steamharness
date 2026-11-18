import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareRelease } from "../prepare-release.mjs";
import { writeReleaseFixture } from "../../../docs/scripts/__tests__/release-fixture.mjs";

test("CLI release preparation updates only the CLI release files", async () => {
  const root = await createFixture();
  try {
    const result = await prepareRelease({ root, docsRoot: path.join(root, "docs"), version: "1.1.0" });
    assert.deepEqual(result, {
      unit: "steamharness-cli",
      version: "1.1.0",
      tag: "steamharness/v1.1.0",
      docsPaths: { "zh-CN": "/guides/releases/cli/v1.1.0/", en: "/en/guides/releases/cli/v1.1.0/" },
    });
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    assert.equal(manifest.version, "1.1.0");
    assert.equal(manifest.peerDependencies["steamharness"], "1.1.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI release preparation rejects localized category drift without writing", async () => {
  const root = await createFixture();
  const manifestPath = path.join(root, "package.json");
  const before = await readFile(manifestPath, "utf8");
  try {
    const docsRoot = path.join(root, "docs");
    await writeReleaseFixture(docsRoot, "cli", "1.1.0", { enId: "different-id" });
    await assert.rejects(
      prepareRelease({ root, docsRoot, version: "1.1.0" }),
      /note IDs\/sections differ/,
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
    const result = await prepareRelease({ root, docsRoot: path.join(root, "docs"), version: "1.1.0" });
    assert.equal(result.version, "1.1.0");
    assert.equal(result.docsPaths.en, "/en/guides/releases/cli/v1.1.0/");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI release preparation rejects a different Core version without writing", async () => {
  const root = await createFixture();
  const manifestPath = path.join(root, "package.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.devDependencies.steamharness = "1.1.4";
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const before = await readFile(manifestPath, "utf8");
    await assert.rejects(prepareRelease({ root, version: "1.1.0" }), /Core and CLI versions must match/);
    assert.equal(await readFile(manifestPath, "utf8"), before);
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
      prepareRelease({ root, version: "1.1.0" }),
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
    writeFile(path.join(root, "package.json"), '{"name":"@steamharness/cli","version":"1.0.0","peerDependencies":{"steamharness":">=1.0.0 <2.0.0"},"devDependencies":{"steamharness":"1.1.0"}}\n', "utf8"),
    writeReleaseFixture(path.join(root, "docs"), "cli", "1.1.0"),
  ]);
  return root;
}
