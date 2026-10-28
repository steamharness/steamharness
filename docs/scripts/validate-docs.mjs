import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 公开文档的内容校验器。这里不依赖 Docusaurus 或任何 npm 包：
 * 站点由私有工作区构建，公开仓只保证 Markdown/MDX、导航与 OpenAPI 源文件
 * 本身是完整且双语的。
 */
const REMOVED_DESKTOP_WEB_TERMS = /\bWeb Studio\b|Web工作室|studio-web|localhost:7133|127\.0\.0\.1:7133|运行到 Web|Web 入口|Web entry/iu;
const REMOVED_DESKTOP_IDENTITY_TERMS = /guides\/(?:releases\/)?app(?:\/|\b)|STEAMHARNESS_APP_|workflow-app\.json|@steamharness\/app\b|\bminAppVersion\b|\bappVersion\b|\bisApp\b|\/app\/(?:stable|v)|\bapp\/v\d|source\s*=\s*["'`]?app\b|source=app\b|STEAMHARNESS_RUNTIME_PLATFORM=app\b/iu;
const LEGACY_MONOREPO_REFERENCES = /packages\/(?:steamharness|cli)|app\/builtin-projects|pnpm\s+-C\s+(?:app|server\/web|workspace)\b|pnpm\s+(?:run\s+)?app:[\w:-]+/u;
const REMOVED_PROJECT_MODEL = /steamHarness\.projectType|\bdataStorage\b|\brelatedProjects\b|related[ -]projects?|关联项目|context\.storage\.(?:local|server)|--(?:related-project|project-group|publish-group)\b/iu;
const RELEASE_PAGE_PATH = /^(?:en\/)?guides\/releases\/[^/]+\.mdx$/u;
const ISO_DISPLAY_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/u;
const GENERATED_MDX_DIRECTORIES = new Set(["reference", "en/reference"]);
const GENERATED_RELEASE_PAGE = /^(?:en\/)?guides\/releases\/[a-z-]+\/v\d+\.\d+\.\d+\.mdx$/u;
const isGeneratedReleasePage = (relativeFile) => GENERATED_RELEASE_PAGE.test(relativeFile);

export function validateStandaloneDocsSource(relativeFile, source, options = {}) {
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
  if (!/^(?:en\/)?guides\/releases\//u.test(relativeFile) && REMOVED_PROJECT_MODEL.test(source)) {
    throw new Error(`${relativeFile} still documents the removed single-entry project or relationship model.`);
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
      if (tab.openapi?.source) {
        await assertFile(path.join(root, tab.openapi.source), `${language.language} OpenAPI source`);
      }
    }
  }

  const zhPages = (await collectFiles(root, root))
    .filter((file) => file.endsWith(".mdx") && !file.startsWith("en/"))
    .map((file) => file.replace(/\.mdx$/u, ""));
  const enRoot = path.join(root, "en");
  const enPages = (await collectFiles(enRoot, enRoot))
    .filter((file) => file.endsWith(".mdx"))
    .map((file) => file.replace(/\.mdx$/u, ""));
  if (JSON.stringify(zhPages) !== JSON.stringify(enPages)) {
    throw new Error(
      `Chinese and English MDX page sets differ.\nzh: ${zhPages.join(", ")}\nen: ${enPages.join(", ")}`,
    );
  }

  const allMdx = [
    ...zhPages.map((page) => `${page}.mdx`),
    ...enPages.map((page) => `en/${page}.mdx`),
  ];
  for (const relativeFile of allMdx) {
    const source = await readFile(path.join(root, relativeFile), "utf8");
    validateStandaloneDocsSource(relativeFile, source, {
      generated: isGeneratedReleasePage(relativeFile),
    });
    for (const link of readInternalLinks(source)) {
      const normalized = link.replace(/^\//u, "").split(/[?#]/u, 1)[0].replace(/\/$/u, "");
      if (normalized === "" || normalized.startsWith("images/") || normalized.startsWith("assets/")) continue;
      const candidates = [
        path.join(root, normalized),
        path.join(root, `${normalized}.mdx`),
        path.join(root, `${normalized}.api.mdx`),
        path.join(root, normalized, "index.mdx"),
      ];
      if (!await anyFile(candidates)) throw new Error(`${relativeFile} contains an unresolved internal link: ${link}`);
      if (relativeFile.startsWith("en/") && !normalized.startsWith("en/")) {
        throw new Error(`${relativeFile} contains an unlocalized internal link: ${link}`);
      }
    }
  }

  const openapiFiles = ["openapi/steamharness.openapi.yaml", "en/openapi/steamharness.openapi.yaml"];
  for (const relativeFile of openapiFiles) {
    const source = await readFile(path.join(root, relativeFile), "utf8");
    if (!/^openapi:\s*3\./mu.test(source) || !/^paths:\s*$/mu.test(source)) {
      throw new Error(`${relativeFile} is not a complete OpenAPI 3 document.`);
    }
  }

  return {
    languages: languageNames,
    pages: allMdx.length,
    navigatedPages: navigatedPages.length,
    openapiFiles: openapiFiles.length,
  };
}

function readInternalLinks(source) {
  return [...source.matchAll(/(?:\]\(|href=["'])(\/[^)"'\s]+)(?:\)|["'])/gu)].map((match) => match[1]);
}

async function anyFile(candidates) {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return true;
    } catch {
      // 尝试下一个候选路径。
    }
  }
  return false;
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
    // 落到下面的统一错误。
  }
  throw new Error(`Missing ${label}: ${path.relative(path.resolve(import.meta.dirname, ".."), filePath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await validateDocs();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
