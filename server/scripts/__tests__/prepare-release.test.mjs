import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareRelease } from "../prepare-release.mjs";

test("release preparation updates only the selected Server release unit", async () => {
  const root = await createFixture();
  try {
    const webBefore = await readFile(path.join(root, "web", "package.json"), "utf8");
    const result = await prepareRelease({ root, unit: "server", version: "1.1.0", date: "2026-08-12" });
    assert.equal(result.tag, "server/v1.1.0");
    assert.equal(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version, "1.1.0");
    assert.match(await readFile(path.join(root, "CHANGELOG.md"), "utf8"), /## 1\.1\.0 - 2026-08-12/);
    assert.equal(await readFile(path.join(root, "CHANGELOG.next.md"), "utf8"), "# Unreleased\n");
    assert.equal(await readFile(path.join(root, "web", "package.json"), "utf8"), webBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archived release notes keep their section headings and blank lines", async () => {
  const root = await createFixture();
  try {
    await writeNext(root, ".", "# Unreleased\n\n### 新特性\n\n- **本地执行**：开发服务器无需 Runner。参见 [部署](../docs/guides/server/deployment.mdx)。\n\n### 破坏性变更\n\n- 移除公开 Embed 接口。\n  迁移：改用 Desktop 承载。\n\n### 修复\n\n- 修复 上传超时预算。\n");
    await writeNext(root, ".", "# Unreleased\n\n### New Features\n\n- **Local execution**: the dev server needs no Runner. See [Deployment](../docs/guides/server/deployment.mdx).\n\n### Breaking Changes\n\n- Remove the public Embed endpoints.\n  Migration: run them in Desktop instead.\n\n### Fixed\n\n- Fixed the artifact upload timeout budget.\n", "en");
    await prepareRelease({ root, unit: "server", version: "1.1.0", date: "2026-08-12" });
    const history = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
    assert.match(history, /## 1\.1\.0 - 2026-08-12\n\n### 新特性\n\n- \*\*本地执行\*\*/u);
    assert.match(history, /### 破坏性变更\n\n- 移除公开 Embed 接口。\n {2}迁移：改用 Desktop 承载。/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release preparation rejects mismatched localized sections without writing", async () => {
  const root = await createFixture();
  const manifestPath = path.join(root, "web", "package.json");
  const before = await readFile(manifestPath, "utf8");
  try {
    await writeNext(root, "web", "# Unreleased\n\n### Fixed\n\n- Fixed the web build.\n", "en");
    await assert.rejects(
      prepareRelease({ root, unit: "server-web", version: "1.1.0", date: "2026-08-12" }),
      /matching sections, entry counts and order/u,
    );
    assert.equal(await readFile(manifestPath, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release preparation rejects localized entry counts that drift apart", async () => {
  const root = await createFixture();
  try {
    await writeNext(root, "web", "# Unreleased\n\n### Added\n\n- Added the first entry.\n- Added a second entry.\n", "en");
    await assert.rejects(
      prepareRelease({ root, unit: "server-web", version: "1.1.0", date: "2026-08-12" }),
      /matching sections, entry counts and order/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release notes require every entry to carry its section verb prefix", async () => {
  const root = await createFixture();
  try {
    await writeNext(root, ".", "# Unreleased\n\n### 新增\n\n- 缺少动词前缀的条目。\n");
    await assert.rejects(
      prepareRelease({ root, unit: "server", version: "1.1.0" }),
      /zh-CN release note has invalid format/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release notes require a headline section to use a bold title", async () => {
  const root = await createFixture();
  try {
    await writeNext(root, ".", "# Unreleased\n\n### 新特性\n\n- 没有粗体标题的精选条目。\n");
    await assert.rejects(
      prepareRelease({ root, unit: "server", version: "1.1.0" }),
      /zh-CN release note has invalid format/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release notes reject sections listed out of order", async () => {
  const root = await createFixture();
  try {
    await writeNext(root, ".", "# Unreleased\n\n### 修复\n\n- 修复 先出现的修复。\n\n### 新增\n\n- 新增 后出现的新增。\n");
    await assert.rejects(
      prepareRelease({ root, unit: "server", version: "1.1.0" }),
      /out of order/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release notes reject a section that carries no entries", async () => {
  const root = await createFixture();
  try {
    await writeNext(root, ".", "# Unreleased\n\n### 新增\n\n### 修复\n\n- 修复 只有修复有内容。\n");
    await assert.rejects(
      prepareRelease({ root, unit: "server", version: "1.1.0" }),
      /section '新增' has no entries/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release notes reject entries longer than the locale limit", async () => {
  const root = await createFixture();
  try {
    await writeNext(root, ".", `# Unreleased\n\n### 新增\n\n- 新增 ${"补".repeat(101)}\n`);
    await assert.rejects(
      prepareRelease({ root, unit: "server", version: "1.1.0" }),
      /exceeds the 100 character limit \(104\)/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release notes point at the retired bracket tag format", async () => {
  const root = await createFixture();
  try {
    await writeNext(root, ".", "# Unreleased\n\n### 新增\n\n- 【新增】仍是旧版括号前缀。\n");
    await assert.rejects(
      prepareRelease({ root, unit: "server", version: "1.1.0" }),
      /retired bracket tag format/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release notes only accept a migration line inside breaking changes", async () => {
  const root = await createFixture();
  try {
    await writeNext(root, ".", "# Unreleased\n\n### 修复\n\n- 修复 不该带迁移说明。\n  迁移：这里不该出现。\n");
    await assert.rejects(
      prepareRelease({ root, unit: "server", version: "1.1.0" }),
      /migration note must follow an entry inside '修复'/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release notes reject an unknown section heading", async () => {
  const root = await createFixture();
  try {
    await writeNext(root, ".", "# Unreleased\n\n### 优化\n\n- 优化 已废弃的分类。\n");
    await assert.rejects(
      prepareRelease({ root, unit: "server", version: "1.1.0" }),
      /unknown section '优化'/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release notes reject entries that appear before any section heading", async () => {
  const root = await createFixture();
  try {
    await writeNext(root, ".", "# Unreleased\n\n- 新增 没有小节标题的条目。\n");
    await assert.rejects(
      prepareRelease({ root, unit: "server", version: "1.1.0" }),
      /must open with a '### ' section heading/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release preparation rejects histories whose entry counts drifted apart", async () => {
  const root = await createFixture();
  try {
    await writeFile(
      path.join(root, "CHANGELOG.en.md"),
      "# Changelog\n\n## 1.0.0 - 2026-08-01\n\n### Added\n\n- Added the initial release.\n- Added an extra entry the Chinese side never got.\n",
      "utf8",
    );
    await assert.rejects(
      prepareRelease({ root, unit: "server", version: "1.1.0" }),
      /histories must have matching sections and entry counts per version/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release preparation promotes a version already declared on alpha", async () => {
  const root = await createFixture();
  try {
    const manifestPath = path.join(root, "package.json");
    await writeFile(manifestPath, '{"version":"1.1.0"}\n', "utf8");
    const result = await prepareRelease({
      root,
      unit: "server",
      version: "1.1.0",
      date: "2026-08-24",
    });
    assert.equal(result.version, "1.1.0");
    assert.match(await readFile(path.join(root, "CHANGELOG.md"), "utf8"), /## 1\.1\.0 - 2026-08-24/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeNext(root, directory, contents, locale = "zh") {
  const name = locale === "zh" ? "CHANGELOG.next.md" : "CHANGELOG.next.en.md";
  await writeFile(path.join(root, directory, name), contents, "utf8");
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "server-release-prepare-"));
  for (const directory of [root, path.join(root, "web")]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "package.json"), '{"version":"1.0.0"}\n', "utf8");
    await writeFile(
      path.join(directory, "CHANGELOG.md"),
      "# Changelog\n\n## 1.0.0 - 2026-08-01\n\n### 新增\n\n- 新增 初始发布能力。\n",
      "utf8",
    );
    await writeFile(
      path.join(directory, "CHANGELOG.en.md"),
      "# Changelog\n\n## 1.0.0 - 2026-08-01\n\n### Added\n\n- Added the initial release.\n",
      "utf8",
    );
    await writeFile(
      path.join(directory, "CHANGELOG.next.md"),
      "# Unreleased\n\n### 新增\n\n- 新增 增加发布能力。\n",
      "utf8",
    );
    await writeFile(
      path.join(directory, "CHANGELOG.next.en.md"),
      "# Unreleased\n\n### Added\n\n- Added release support.\n",
      "utf8",
    );
  }
  return root;
}
