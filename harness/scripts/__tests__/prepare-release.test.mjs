import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareRelease, resolveSpawnInvocation } from "../prepare-release.mjs";

test("Core release preparation updates its version and only Core dependencies in Workspace", async () => {
  const root = await createFixture();
  try {
    const result = await prepareRelease({
      root,
      version: "1.1.0",
      date: "2026-08-12",
      runCommand: async () => {},
    });
    assert.equal(result.tag, "steamharness/v1.1.0");
    assert.deepEqual(result.synchronizedPackages, [
      path.join("workspace", "package.json"),
      path.join("workspace", "workflow", "hello", "package.json"),
    ]);
    assert.equal(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version, "1.1.0");
    const workspace = JSON.parse(await readFile(path.join(root, "workspace", "package.json"), "utf8"));
    assert.equal(workspace.dependencies["steamharness"], "1.1.0");
    assert.equal(workspace.devDependencies["@steamharness/cli"], "2.0.0");
    assert.match(await readFile(path.join(root, "CHANGELOG.md"), "utf8"), /## 1\.1\.0 - 2026-08-12/);
    assert.equal(await readFile(path.join(root, "CHANGELOG.next.md"), "utf8"), "# Unreleased\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Core release preparation rolls every file back when lockfile generation fails", async () => {
  const root = await createFixture();
  const tracked = [
    "package.json",
    "CHANGELOG.md",
    "CHANGELOG.en.md",
    "CHANGELOG.next.md",
    "CHANGELOG.next.en.md",
    path.join("workspace", "package.json"),
    path.join("workspace", "pnpm-lock.yaml"),
    path.join("workspace", "workflow", "hello", "package.json"),
  ];
  const before = new Map(await Promise.all(tracked.map(async (file) => [
    file,
    await readFile(path.join(root, file), "utf8"),
  ])));
  try {
    await assert.rejects(
      prepareRelease({
        root,
        version: "1.1.0",
        date: "2026-08-12",
        runCommand: async () => {
          await writeFile(path.join(root, "workspace", "pnpm-lock.yaml"), "changed\n", "utf8");
          throw new Error("lockfile failed");
        },
      }),
      /lockfile failed/,
    );
    for (const [file, contents] of before) {
      assert.equal(await readFile(path.join(root, file), "utf8"), contents, file);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Corepack invocation is Windows-safe", () => {
  assert.deepEqual(resolveSpawnInvocation("corepack", ["pnpm", "install"], {
    platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    comSpec: "C:\\Windows\\System32\\cmd.exe",
  }), {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      "call",
      "C:\\Program Files\\nodejs\\corepack.cmd",
      "pnpm",
      "install",
    ],
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-core-release-"));
  await mkdir(path.join(root, "workspace", "workflow", "hello"), { recursive: true });
  await mkdir(path.join(root, "workspace", "conversation", "empty"), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "package.json"), '{"name":"steamharness","version":"1.1.0"}\n', "utf8"),
    writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## 1.0.0 - 2026-08-01\n\n### 修复\n\n- 修复 现有版本。\n", "utf8"),
    writeFile(path.join(root, "CHANGELOG.en.md"), "# Changelog\n\n## 1.0.0 - 2026-08-01\n\n### Fixed\n\n- Fixed Existing release.\n", "utf8"),
    writeFile(path.join(root, "CHANGELOG.next.md"), "# Unreleased\n\n### 新增\n\n- 新增 独立发布。\n", "utf8"),
    writeFile(path.join(root, "CHANGELOG.next.en.md"), "# Unreleased\n\n### Added\n\n- Added Independent release.\n", "utf8"),
    writeFile(path.join(root, "workspace", "package.json"), '{"dependencies":{"steamharness":"1.0.0"},"devDependencies":{"@steamharness/cli":"2.0.0"}}\n', "utf8"),
    writeFile(path.join(root, "workspace", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8"),
    writeFile(path.join(root, "workspace", "workflow", "hello", "package.json"), '{"devDependencies":{"steamharness":"1.0.0","@steamharness/cli":"2.0.0"}}\n', "utf8"),
  ]);
  return root;
}
