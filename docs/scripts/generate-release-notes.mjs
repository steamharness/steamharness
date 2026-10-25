/**
 * 从各发布仓的 CHANGELOG 生成 Docs 发布日志页。
 *
 * 一次版本记录动辄上百条（Core v0.2.4 单版就有 100 条），全部堆在一个页面里没法读，
 * 所以拆成两层：`<单元>.mdx` 只留版本索引，每个版本单独一页在 `<单元>/<版本>.mdx`。
 *
 * 页面是生成产物，不要手工编辑：改内容请改对应仓库的 `CHANGELOG.md`，然后重跑
 * `pnpm generate:releases`。`docs/AGENTS.md` 也据此规定发布日志页不手工编造版本事实。
 *
 * 只有工作区里存在源仓库的单元走自动生成；内置项目 codex / conversation / opencode / pi
 * 在本仓库没有对应检出，其页面保留人工维护，本脚本不读也不写。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 六个 section 的固定顺序，与各仓 CHANGELOG 一致。 */
const SECTION_ORDER = ["新特性", "破坏性变更", "新增", "变更", "修复", "移除"];
const SECTION_ORDER_EN = ["New Features", "Breaking Changes", "Added", "Changed", "Fixed", "Removed"];

/**
 * 发布单元。`source` 为 null 表示本仓库没有该单元的检出，其页面人工维护。
 * `target` 与 `endpoint` 对应原表格里的「发布目标」和「入口」列。
 */
export const RELEASE_UNITS = Object.freeze([
  {
    slug: "core", label: "Core", labelEn: "Core", title: "Core 发布日志",
    description: "steamharness Core 的完整版本记录与更新说明。",
    source: "core", packageLabel: "steamharness", target: "npm",
    endpoint: "https://www.npmjs.com/package/steamharness",
  },
  {
    slug: "cli", label: "CLI", labelEn: "CLI", title: "CLI 发布日志",
    description: "@steamharness/cli 的完整版本记录与更新说明。",
    source: "cli", packageLabel: "@steamharness/cli", target: "npm",
    endpoint: "https://www.npmjs.com/package/@steamharness/cli",
  },
  {
    slug: "server", label: "Server", labelEn: "Server", title: "Server 发布日志",
    description: "SteamHarness Server 的完整版本记录与更新说明。",
    source: "server", packageLabel: "server", target: "当前设备",
    endpoint: "https://server.steamharness.yuhe.space",
  },
  {
    slug: "server-web", label: "Server Web", labelEn: "Server Web", title: "Server Web 发布日志",
    description: "Server Web 管理端的完整版本记录与更新说明。",
    source: "server/web", packageLabel: "server-web", target: "当前设备",
    endpoint: "https://server.steamharness.yuhe.space",
  },
  {
    slug: "builtin-developer-assistant", label: "开发者小助手", labelEn: "Developer Assistant",
    title: "开发者小助手发布日志",
    description: "内置开发者小助手的完整版本记录与更新说明。",
    source: "build-in/build-in-developer-assistant", packageLabel: "builtin-developer-assistant",
    target: "内置项目更新",
    endpoint: "https://updates.steamharness.yuhe.space/builtin-projects/developer-assistant/",
  },
  { slug: "builtin-codex", label: "Codex", labelEn: "Codex", title: "Codex 发布日志", source: null },
  { slug: "builtin-conversation", label: "Conversation", labelEn: "Conversation", title: "Conversation 发布日志", source: null },
  { slug: "builtin-opencode", label: "OpenCode", labelEn: "OpenCode", title: "OpenCode 发布日志", source: null },
  { slug: "builtin-pi", label: "Pi", labelEn: "Pi", title: "Pi 发布日志", source: null },
]);

/** 解析 CHANGELOG 正文为 `{ version, date, sections }`。空 section 会被丢掉。 */
export function parseChangelog(source) {
  const normalized = source.replace(/\r\n?/g, "\n");
  const releases = [];
  let release = null;
  let section = null;
  for (const line of normalized.split("\n")) {
    const versionHeading = /^## (\d+\.\d+\.\d+) - (\d{4}-\d{2}-\d{2})$/.exec(line);
    if (versionHeading) {
      release = { version: versionHeading[1], date: versionHeading[2], sections: [] };
      releases.push(release);
      section = null;
      continue;
    }
    const sectionHeading = /^###\s+(\S.*?)\s*$/.exec(line);
    if (sectionHeading && release) {
      section = { name: sectionHeading[1], entries: [] };
      release.sections.push(section);
      continue;
    }
    // 条目与破坏性变更的迁移续行都原样保留，缩进层级不能丢
    if (section && (line.startsWith("- ") || line.startsWith("  "))) {
      section.entries.push(line);
    }
  }
  return releases;
}

function frontmatter(title, description) {
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n`;
}

/**
 * 各仓 CHANGELOG 里的 Docs 链接是仓库相对路径（`../docs/cli/steamharness.mdx`，
 * 相对于 cli/ 仓库根），在文档站里解析不了，改写成站点绝对路径。
 * 目标页面不存在时保持原样，交给 validate 报错，而不是悄悄丢一条引用。
 */
const REPO_DOCS_LINK = /(参见|See)\s*\[([^\]]+)\]\(\.\.\/docs\/([^)]+)\)/gu;

async function rewriteDocsLinks(text, locale, root) {
  const pending = [...text.matchAll(REPO_DOCS_LINK)];
  const resolved = [];
  for (const match of pending) {
    const target = match[3].replace(/\.mdx$/u, "");
    const exists = await readFile(path.join(root, `${target}.mdx`), "utf8").then(() => true, () => false);
    resolved.push([match, exists ? `${match[1]} [${match[2]}](${locale === "en" ? "/en" : ""}/${target})` : null]);
  }
  let output = text;
  for (const [match, replacement] of resolved) {
    if (replacement) output = output.replace(match[0], replacement);
  }
  return output;
}

/** 站内绝对链接在英文站必须带 /en/ 前缀。 */
function unitHref(locale, slug, version) {
  return locale === "en"
    ? `/en/guides/releases/${slug}/${version}`
    : `/guides/releases/${slug}/${version}`;
}

async function versionPage(unit, release, locale, root) {
  const label = locale === "en" ? `${unit.label} ${release.version}` : `${unit.label} 发布日志`;
  const out = [
    frontmatter(locale === "en" ? `${unit.label} ${release.version}` : `${unit.label} v${release.version}`,
      locale === "en"
        ? `Release notes for ${unit.label} ${release.version}.`
        : `${unit.label} v${release.version} 的更新说明。`),
    `# ${locale === "en" ? `${unit.label} ${release.version}` : `${unit.label} v${release.version}`}`,
    "",
    locale === "en"
      ? `${release.date} · Tag \`${unit.packageLabel}/v${release.version}\` · ${unit.target}`
      : `${release.date} · Tag \`${unit.packageLabel}/v${release.version}\` · ${unit.target}`,
    "",
    `<span id="${unit.packageLabel}-${release.version.replace(/\./g, "-")}" className="release-version-anchor"></span>`,
    `<span id="${unit.packageLabel}.${release.version}" className="release-version-anchor"></span>`,
    "",
  ];
  const order = locale === "en" ? SECTION_ORDER_EN : SECTION_ORDER;
  const ordered = [...release.sections].sort((left, right) => order.indexOf(left.name) - order.indexOf(right.name));
  for (const section of ordered) {
    const entries = [];
    for (const entry of section.entries) entries.push(await rewriteDocsLinks(entry, locale, root));
    out.push(`#### ${section.name}`, "", ...entries, "");
  }
  return `${out.join("\n").replace(/\n+$/u, "\n")}`;
}

function indexPage(unit, releases, locale) {
  const label = locale === "en" ? unit.title.replace("发布日志", "release notes") : unit.title;
  const out = [
    frontmatter(unit.title, unit.description),
    `# ${unit.title}`,
    "",
    locale === "en"
      ? `Versions and complete notes for \`${unit.packageLabel}\` come from that release unit's \`CHANGELOG.md\`; release metadata adds exact publication times, commits, artifact counts, and release endpoints when available.`
      : `\`${unit.packageLabel}\` 的版本与完整更新说明来自该发布单元的 \`CHANGELOG.md\`；release metadata 可用时会补充精确发布时间、Commit、产物数和发布入口。`,
    "",
    locale === "en"
      ? "> Sources: local package.json and each release unit's CHANGELOG preview"
      : "> 数据源：本地 package.json 与各发布单元 CHANGELOG.md 预览",
    ">",
    locale === "en"
      ? `> - Generated by \`pnpm generate:releases\` from \`${unit.source}/CHANGELOG${locale === "en" ? ".en" : ""}.md\``
      : `> - 由 \`pnpm generate:releases\` 从 \`${unit.source}/CHANGELOG${locale === "en" ? ".en" : ""}.md\` 生成`,
    locale === "en"
      ? "> - Notes use the six-section layout (highlights, breaking changes, added, changed, fixed, removed)"
      : "> - 更新说明为六段式（精选 / 破坏性变更 / 新增 / 变更 / 修复 / 移除）",
    "",
    locale === "en" ? "## Versions" : "## 版本记录",
    "",
    locale === "en"
      ? "| Version | Published | Target | Endpoint |"
      : "| 版本 | Tag | 发布时间 | 发布目标 | 产物数 | Commit | 入口 |",
    locale === "en"
      ? "| --- | --- | --- | --- |"
      : "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const release of releases) {
    const link = `[v${release.version}](${unitHref(locale, unit.slug, `v${release.version}`)})`;
    out.push(locale === "en"
      ? `| ${link} | ${release.date} | ${unit.target} | [打开](${unit.endpoint}) |`
      : `| ${link} | \`${unit.packageLabel}/v${release.version}\` | ${release.date} | ${unit.target} | — | — | [入口](${unit.endpoint}) |`);
  }
  out.push("");
  return out.join("\n");
}

export async function generateReleaseNotes(options = {}) {
  const root = path.resolve(options.root ?? path.resolve(import.meta.dirname, ".."));
  const workspace = options.workspace ?? path.resolve(root, "..");
  const written = [];
  for (const unit of RELEASE_UNITS) {
    if (!unit.source) continue;
    const sourceDir = path.resolve(workspace, unit.source);
    let releases = [];
    for (const locale of ["zh", "en"]) {
      const suffix = locale === "en" ? ".en" : "";
      let text;
      try {
        text = await readFile(path.join(sourceDir, `CHANGELOG${suffix}.md`), "utf8");
      } catch (error) {
        throw new Error(`Missing ${unit.source}/CHANGELOG${suffix}.md for the ${unit.slug} release unit.`);
      }
      const parsed = parseChangelog(text);
      if (locale === "zh") {
        releases = parsed;
      } else {
        const zhVersions = releases.map((item) => item.version).join(",");
        const enVersions = parsed.map((item) => item.version).join(",");
        if (zhVersions !== enVersions) {
          throw new Error(`${unit.slug} CHANGELOG version sets drifted: zh=[${zhVersions}] en=[${enVersions}]`);
        }
      }
      const base = path.join(root, locale === "en" ? "en/guides/releases" : "guides/releases", unit.slug);
      await rm(base, { recursive: true, force: true });
      await mkdir(base, { recursive: true });
      for (const release of parsed) {
        const target = path.join(base, `v${release.version}.mdx`);
        await writeFile(target, await versionPage(unit, release, locale, root), "utf8");
        written.push(path.relative(root, target));
      }
      const indexPath = path.join(root, locale === "en" ? "en/guides/releases" : "guides/releases", `${unit.slug}.mdx`);
      await writeFile(indexPath, indexPage(unit, parsed, locale), "utf8");
      written.push(path.relative(root, indexPath));
    }
  }
  return written.sort();
}

/** 返回导航需要的层级：每个单元一个分类，成员是索引页加全部版本页。 */
export async function releaseNavigationTree(options = {}) {
  const root = path.resolve(options.root ?? path.resolve(import.meta.dirname, ".."));
  const workspace = options.workspace ?? path.resolve(root, "..");
  const tree = [];
  for (const unit of RELEASE_UNITS) {
    const versions = unit.source
      ? parseChangelog(await readFile(path.join(workspace, unit.source, "CHANGELOG.md"), "utf8"))
        .map((release) => `v${release.version}`)
      : await listExistingVersions(root, unit.slug);
    // 与索引页的版本表一致：新版本在前
    versions.sort((left, right) => compareVersions(right, left));
    tree.push({ slug: unit.slug, label: unit.label, labelEn: unit.labelEn, path: `guides/releases/${unit.slug}`, items: versions });
  }
  return tree;
}

function compareVersions(left, right) {
  const parse = (value) => value.replace(/^v/u, "").split(".").map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

/**
 * 同步 `docs.json` 的发布日志导航。每个单元一个分类，分类本身链到索引页，
 * 成员是该单元的全部版本页；否则新生成的页面不在侧边栏里，Docusaurus 会告警，
 * validate 也会因为导航覆盖率下降而失败。
 */
export async function updateReleaseNavigation(options = {}) {
  const root = path.resolve(options.root ?? path.resolve(import.meta.dirname, ".."));
  const configPath = path.join(root, "docs.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const tree = await releaseNavigationTree(options);
  for (const language of config.navigation.languages) {
    const english = language.language === "en";
    const prefix = english ? "en/" : "";
    const tab = language.tabs.find((entry) => JSON.stringify(entry).includes("guides/releases/"))
      ?? language.tabs[language.tabs.length - 1];
    // 首次运行时 pages 是字符串数组，重跑后是 `{ label, path, items }` 对象，
    // 所以用序列化后的文本定位，脚本必须幂等。
    const group = tab.groups.find((entry) => JSON.stringify(entry).includes("guides/releases/core"));
    if (!group) throw new Error(`Missing release notes navigation group for ${language.language}.`);
    group.pages = tree.map((unit) => ({
      label: english ? unit.labelEn : unit.label,
      path: `${prefix}${unit.path}`,
      items: unit.items.map((version) => `${prefix}${unit.path}/${version}`),
    }));
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return tree.length;
}

async function listExistingVersions(root, slug) {
  const directory = path.join(root, "guides/releases", slug);
  const { readdir } = await import("node:fs/promises");
  let entries = [];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  return entries.filter((name) => /^v\d+\.\d+\.\d+\.mdx$/u.test(name)).map((name) => name.replace(/\.mdx$/u, ""));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const written = await generateReleaseNotes();
  const units = await updateReleaseNavigation();
  process.stdout.write(`Generated ${written.length} release note pages across ${units} units.\n`);
}
