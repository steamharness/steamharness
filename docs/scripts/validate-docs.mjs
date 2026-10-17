import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const LOCALIZED_FIELDS = new Set(["description", "summary", "title", "example", "examples"]);
// The Desktop Web Studio hosting surface, plus the relay and the Web entry that
// briefly replaced it. `wflive.yuhe.space` is the retired relay hostname: the
// web app lives on `wflive-alpha.yuhe.space`, which is why the stable name is
// pinned literally rather than the `wflive` prefix.
const REMOVED_DESKTOP_WEB_TERMS = /\bWeb Studio\b|Web工作室|studio-web|localhost:7133|127\.0\.0\.1:7133|运行到 Web|Web 入口|Web entry|wflive\.yuhe\.space/iu;
const REMOVED_DESKTOP_IDENTITY_TERMS = /guides\/(?:releases\/)?app(?:\/|\b)|STEAMHARNESS_APP_|workflow-app\.json|@steamharness\/app\b|\bminAppVersion\b|\bappVersion\b|\bisApp\b|\/app\/(?:stable|v)|\bapp\/v\d|source\s*=\s*["'`]?app\b|source=app\b|STEAMHARNESS_RUNTIME_PLATFORM=app\b/iu;
const LEGACY_MONOREPO_REFERENCES = /packages\/(?:steamharness|cli)|app\/builtin-projects|pnpm\s+-C\s+(?:app|server\/web|workspace)\b|pnpm\s+(?:run\s+)?app:[\w:-]+/u;
const RELEASE_PAGE_PATH = /^(?:en\/)?guides\/releases\/[^/]+\.mdx$/u;
const ISO_DISPLAY_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/u;
const GENERATED_MDX_DIRECTORIES = new Set(["reference", "en/reference"]);

/** 由 `pnpm generate:releases` 从各仓 CHANGELOG 生成的版本页：`guides/releases/<单元>/vX.Y.Z.mdx`。 */
const GENERATED_RELEASE_PAGE = /^(?:en\/)?guides\/releases\/[a-z-]+\/v\d+\.\d+\.\d+\.mdx$/u;
const isGeneratedReleasePage = (relativeFile) => GENERATED_RELEASE_PAGE.test(relativeFile);

export function validateStandaloneDocsSource(relativeFile, source, options = {}) {
  // 发布日志版本页是各仓 CHANGELOG 的逐字镜像。历史条目里出现 workflow.isApp、minAppVersion
  // 或 Web 入口，恰恰是在记录「这些旧契约已移除」这件事，与这两项检查要防的
  // 「把旧契约当现状写进文档」正好相反，所以生成页跳过它们；链接、双语等检查照常。
  if (options.generated === true) return;
  if (REMOVED_DESKTOP_WEB_TERMS.test(source)) {
    throw new Error(`${relativeFile} still documents the removed Desktop Web Studio hosting surface.`);
  }
  if (REMOVED_DESKTOP_IDENTITY_TERMS.test(source)) {
    throw new Error(`${relativeFile} still contains the removed Desktop app identity.`);
  }
  if (LEGACY_MONOREPO_REFERENCES.test(source)) {
    throw new Error(`${relativeFile} still contains a legacy monorepo path or command.`);
  }
  if (RELEASE_PAGE_PATH.test(relativeFile) && ISO_DISPLAY_TIMESTAMP.test(source)) {
    throw new Error(`${relativeFile} displays an ISO timestamp instead of YYYY-MM-DD HH:mm:ss.`);
  }
}

export async function validateDocs(options = {}) {
  const root = path.resolve(options.root ?? path.resolve(import.meta.dirname, ".."));
  const config = JSON.parse(await readFile(path.join(root, "docs.json"), "utf8"));
  validateStandaloneDocsSource("docs.json", JSON.stringify(config));
  const languages = config.navigation?.languages;
  if (!Array.isArray(languages) || languages.length !== 2) {
    throw new Error("docs.json must declare exactly the zh-Hans and en navigation languages.");
  }
  const languageNames = languages.map((language) => language.language);
  if (JSON.stringify(languageNames) !== JSON.stringify(["zh-Hans", "en"])) {
    throw new Error(`Unexpected Docs language order: ${languageNames.join(", ")}.`);
  }

  const navigatedPages = [];
  for (const language of languages) {
    // 导航项可以是页面 id，也可以是 `{ label, path, items }` 形式的嵌套分类；
    // 分类自身链到一个页面（发布日志里是单元索引页），成员是它的子页面。
    const pages = language.tabs
      .flatMap((tab) => (tab.groups ?? []).flatMap((group) => group.pages ?? []))
      .flatMap((item) => (typeof item === "string" ? [item] : [item.path, ...(item.items ?? [])]));
    if (new Set(pages).size !== pages.length) {
      throw new Error(`${language.language} navigation contains duplicate pages.`);
    }
    for (const page of pages) {
      await assertFile(path.join(root, `${page}.mdx`), `${language.language} navigation page`);
      navigatedPages.push(page);
    }
    for (const tab of language.tabs) {
      if (tab.openapi?.source) await assertFile(path.join(root, tab.openapi.source), `${language.language} OpenAPI source`);
    }
  }

  const zhPages = (await collectFiles(root, root))
    .filter((file) => file.endsWith(".mdx") && !file.startsWith("en/"))
    .map((file) => file.replace(/\.mdx$/u, ""));
  const enPages = (await collectFiles(path.join(root, "en"), path.join(root, "en")))
    .filter((file) => file.endsWith(".mdx"))
    .map((file) => file.replace(/\.mdx$/u, ""));
  if (JSON.stringify(zhPages) !== JSON.stringify(enPages)) {
    throw new Error(`Chinese and English MDX page sets differ.\nzh: ${zhPages.join(", ")}\nen: ${enPages.join(", ")}`);
  }

  const allMdx = [
    ...zhPages.map((page) => `${page}.mdx`),
    ...enPages.map((page) => `en/${page}.mdx`),
  ];
  for (const relativeFile of allMdx) {
    const source = await readFile(path.join(root, relativeFile), "utf8");
    validateStandaloneDocsSource(relativeFile, source, { generated: isGeneratedReleasePage(relativeFile) });
    for (const link of readInternalLinks(source)) {
      const normalized = link.replace(/^\//u, "").split(/[?#]/u, 1)[0].replace(/\/$/u, "");
      if (normalized === "" || normalized.startsWith("images/") || normalized.startsWith("assets/")) continue;
      const candidates = [
        path.join(root, normalized),
        path.join(root, `${normalized}.mdx`),
        path.join(root, normalized, "index.mdx"),
      ];
      if (!await anyFile(candidates)) throw new Error(`${relativeFile} contains an unresolved internal link: ${link}`);
      if (relativeFile.startsWith("en/") && !normalized.startsWith("en/")) {
        throw new Error(`${relativeFile} contains an unlocalized internal link: ${link}`);
      }
    }
  }

  const chineseOpenapiSource = await readFile(path.join(root, "openapi", "steamharness.openapi.yaml"), "utf8");
  const englishOpenapiSource = await readFile(path.join(root, "en", "openapi", "steamharness.openapi.yaml"), "utf8");
  validateStandaloneDocsSource("openapi/steamharness.openapi.yaml", chineseOpenapiSource);
  validateStandaloneDocsSource("en/openapi/steamharness.openapi.yaml", englishOpenapiSource);
  const chineseOpenapi = parseYaml(chineseOpenapiSource);
  const englishOpenapi = parseYaml(englishOpenapiSource);
  if (JSON.stringify(stripLocalizedCopy(chineseOpenapi)) !== JSON.stringify(stripLocalizedCopy(englishOpenapi))) {
    throw new Error("Chinese and English OpenAPI structures differ.");
  }
  const chineseInEnglish = collectLocalizedCopy(englishOpenapi).filter((value) => /[\p{Script=Han}]/u.test(value));
  if (chineseInEnglish.length > 0) throw new Error("English OpenAPI contains Chinese documentation copy.");

  return {
    languages: languageNames,
    pages: allMdx.length,
    navigatedPages: navigatedPages.length,
    openapiPaths: Object.keys(chineseOpenapi.paths ?? {}).length,
  };
}

function readInternalLinks(source) {
  return [...source.matchAll(/(?:\]\(|href=["'])(\/[^)"'\s]+)(?:\)|["'])/gu)].map((match) => match[1]);
}

function stripLocalizedCopy(value) {
  if (Array.isArray(value)) return value.map(stripLocalizedCopy);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !LOCALIZED_FIELDS.has(key))
    .map(([key, nested]) => [key, stripLocalizedCopy(nested)]));
}

function collectLocalizedCopy(value, key) {
  if (typeof value === "string") return LOCALIZED_FIELDS.has(key) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectLocalizedCopy(item, key));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([nestedKey, nested]) => collectLocalizedCopy(nested, nestedKey));
}

async function collectFiles(root, current) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".agents", ".claude", ".codex", ".git", "dist", "node_modules", "scripts"].includes(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isDirectory() && GENERATED_MDX_DIRECTORIES.has(relative)) continue;
    if (entry.isDirectory()) files.push(...await collectFiles(root, absolute));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function assertFile(filePath, label) {
  try {
    if ((await stat(filePath)).isFile()) return;
  } catch {
    // Fall through to the stable error below.
  }
  throw new Error(`${label} does not exist: ${filePath}`);
}

async function anyFile(candidates) {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return true;
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await validateDocs();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
