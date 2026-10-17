import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RELEASE_UNITS,
  generateReleaseNotes,
  parseChangelog,
  releaseNavigationTree,
} from "../generate-release-notes.mjs";

const CHANGELOG_ZH = `# Changelog

## 0.2.4 - 2026-09-05

### 新特性

- **本地执行**：开发服务器无需 Runner。参见 [部署](../docs/guides/server/deployment.mdx)。

### 破坏性变更

- 移除公开 Embed 接口。
  迁移：改用 Desktop 承载。

### 新增

- 新增 项目 KV 条目删除接口。

### 修复

- 修复 上传超时预算。

## 0.1.0 - 2026-07-29

### 变更

- 变更 初始版本。
`;

const CHANGELOG_EN = CHANGELOG_ZH
  .replace("## 0.2.4", "## 0.2.4")
  .replace(/### 新特性/u, "### New Features")
  .replace(/### 破坏性变更/u, "### Breaking Changes")
  .replace(/### 新增/u, "### Added")
  .replace(/### 修复/u, "### Fixed")
  .replace(/### 变更/u, "### Changed")
  .replace(/- 修复 /u, "- Fixed ")
  .replace(/- 新增 /u, "- Added ")
  .replace(/- 变更 /u, "- Changed ")
  .replace("迁移：", "Migration: ")
  .replace("参见", "See");

test("parseChangelog keeps version order, sections and indented migration lines", () => {
  const releases = parseChangelog(CHANGELOG_ZH);
  assert.deepEqual(releases.map((release) => release.version), ["0.2.4", "0.1.0"]);
  const latest = releases[0];
  assert.equal(latest.date, "2026-09-05");
  assert.deepEqual(latest.sections.map((section) => section.name), ["新特性", "破坏性变更", "新增", "修复"]);
  const breaking = latest.sections[1];
  assert.deepEqual(breaking.entries, ["- 移除公开 Embed 接口。", "  迁移：改用 Desktop 承载。"]);
});

test("generateReleaseNotes writes an index plus one page per version", async () => {
  const { docs, workspace } = await createFixture();
  try {
    const written = await generateReleaseNotes({ root: docs, workspace });
    assert.ok(written.includes(path.join("guides", "releases", "server", "v0.2.4.mdx")));
    assert.ok(written.includes(path.join("en", "guides", "releases", "server", "v0.2.4.mdx")));
    const index = await readFile(path.join(docs, "guides/releases/server.mdx"), "utf8");
    assert.match(index, /\[v0\.2\.4\]\(\/guides\/releases\/server\/v0\.2\.4\)/u);
    // 索引页只留索引，不再堆全部版本正文
    assert.doesNotMatch(index, /^#### /mu);
    const version = await readFile(path.join(docs, "guides/releases/server/v0.2.4.mdx"), "utf8");
    assert.match(version, /^# Server v0\.2\.4$/mu);
    assert.match(version, /^#### 新特性$/mu);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("generateReleaseNotes rewrites repository-relative Docs links to site paths", async () => {
  const { docs, workspace } = await createFixture();
  try {
    await mkdir(path.join(docs, "guides/server"), { recursive: true });
    await writeFile(path.join(docs, "guides/server/deployment.mdx"), "# 部署\n", "utf8");
    await generateReleaseNotes({ root: docs, workspace });
    const zh = await readFile(path.join(docs, "guides/releases/server/v0.2.4.mdx"), "utf8");
    const en = await readFile(path.join(docs, "en/guides/releases/server/v0.2.4.mdx"), "utf8");
    assert.match(zh, /参见 \[部署\]\(\/guides\/server\/deployment\)/u);
    assert.match(en, /See \[部署\]\(\/en\/guides\/server\/deployment\)/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("generateReleaseNotes leaves a link alone when its target page is missing", async () => {
  const { docs, workspace } = await createFixture();
  try {
    await generateReleaseNotes({ root: docs, workspace });
    const zh = await readFile(path.join(docs, "guides/releases/server/v0.2.4.mdx"), "utf8");
    assert.match(zh, /\(\.\.\/docs\/guides\/server\/deployment\.mdx\)/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("generateReleaseNotes is idempotent", async () => {
  const { docs, workspace } = await createFixture();
  try {
    await generateReleaseNotes({ root: docs, workspace });
    const first = await readFile(path.join(docs, "guides/releases/server/v0.2.4.mdx"), "utf8");
    await generateReleaseNotes({ root: docs, workspace });
    assert.equal(await readFile(path.join(docs, "guides/releases/server/v0.2.4.mdx"), "utf8"), first);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("generateReleaseNotes rejects a release unit whose zh and en versions drifted", async () => {
  const { docs, workspace } = await createFixture();
  try {
    await writeFile(
      path.join(workspace, "server/CHANGELOG.en.md"),
      CHANGELOG_EN.replace("## 0.1.0 - 2026-07-29", "## 0.1.1 - 2026-07-30"),
      "utf8",
    );
    await assert.rejects(generateReleaseNotes({ root: docs, workspace }), /version sets drifted/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("releaseNavigationTree lists every version newest first", async () => {
  const { docs, workspace } = await createFixture();
  try {
    const tree = await releaseNavigationTree({ root: docs, workspace });
    const server = tree.find((unit) => unit.slug === "server");
    assert.deepEqual(server.items, ["v0.2.4", "v0.1.0"]);
    assert.equal(server.labelEn, "Server");
    // 没有源仓库的单元保留人工维护的版本页
    assert.deepEqual(tree.find((unit) => unit.slug === "builtin-pi").items, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("every unit slug is unique and kebab-case", () => {
  const slugs = RELEASE_UNITS.map((unit) => unit.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const slug of slugs) assert.match(slug, /^[a-z]+(?:-[a-z]+)*$/u);
});

async function createFixture() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "release-notes-"));
  const docs = path.join(workspace, "docs");
  await mkdir(path.join(workspace, "server"), { recursive: true });
  await mkdir(path.join(docs, "guides/releases"), { recursive: true });
  await mkdir(path.join(docs, "en/guides/releases"), { recursive: true });
  await writeFile(path.join(workspace, "server/CHANGELOG.md"), CHANGELOG_ZH, "utf8");
  await writeFile(path.join(workspace, "server/CHANGELOG.en.md"), CHANGELOG_EN, "utf8");
  // 其余单元只保留存在性，测试只关心 server 这一条链路
  for (const unit of RELEASE_UNITS) {
    if (!unit.source || unit.source === "server") continue;
    await mkdir(path.join(workspace, unit.source), { recursive: true });
    await writeFile(path.join(workspace, unit.source, "CHANGELOG.md"), "# Changelog\n", "utf8");
    await writeFile(path.join(workspace, unit.source, "CHANGELOG.en.md"), "# Changelog\n", "utf8");
  }
  return { workspace, docs };
}
