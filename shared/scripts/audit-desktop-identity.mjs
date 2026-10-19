import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SPLIT_REPOSITORIES = Object.freeze([
  "desktop", "harness", "cli", "server", "shared", "docs",
  "build-in/build-in-developer-assistant", "build-in/build-in-studio-control",
]);

const IGNORED_DIRECTORIES = new Set([
  ".agents", ".ci-artifacts", ".git", ".pnpm-store", ".release", ".shared",
  ".steamharness-local", "__snapshots__", "__tests__", "coverage", "dist",
  "node_modules", "out", "public", "release", "test-results", "vendor",
]);
const IGNORED_FILES = new Set([
  "AGENTS.md", "CLAUDE.md",
  "scripts/audit-desktop-identity.mjs",
  "scripts/check-desktop-identity.mjs", "scripts/validate-docs.mjs",
]);
const TEXT_EXTENSIONS = new Set([
  "", ".cjs", ".css", ".cts", ".env", ".example", ".html", ".js",
  ".json", ".jsx", ".md", ".mdx", ".mjs", ".mts", ".ts", ".tsx",
  ".yaml", ".yml",
]);

const REMOVED_CONTRACTS = Object.freeze([
  ["package", /@steamharness\/app\b/u],
  ["environment", /\b(?:STEAMHARNESS_APP_[A-Z0-9_]*|APP_LOCAL_[A-Z0-9_]*)\b/u],
  ["config-file", /\bworkflow-app\.json\b/u],
  ["runtime-helper", /\b(?:workflow\.)?isApp\s*(?:\(|:)/u],
  ["runtime-marker", /STEAMHARNESS_RUNTIME_PLATFORM\s*=\s*["'`]?app\b/u],
  ["runtime-value", /\b(?:normalized|runtime|platform|source|value)\s*(?:===?|:|=)\s*["'`]app["'`]/u],
  ["ipc", /["'`](?:app:(?:get-version|login|update)|local-app-state:)/u],
  ["storage", /steamharness\.app(?:[.:/-]|$)/u],
  ["i18n", /(?:(?:namespace|ns)\s*[:=]\s*["'`]app["'`]|useTranslation\(\s*["'`]app["'`]\s*\))/u],
  ["compatibility", /\b(?:minAppVersion|appVersion)\b/u],
  ["release", /(?:\brelease:app\b|\/app\/stable\b|guides\/(?:releases\/)?app(?:\/|\b)|\bapp\/v\d)/u],
  ["monorepo-path", /\bapp\/(?:src|scripts|assets|builtin-projects|CHANGELOG|DESIGN|AGENTS)(?:\/|\b)/u],
]);

export async function auditDesktopIdentity(options = {}) {
  const splitRoot = path.resolve(options.splitRoot ?? path.join(import.meta.dirname, "..", ".."));
  const repositories = options.repositories ?? SPLIT_REPOSITORIES;
  const violations = [];
  let filesChecked = 0;

  for (const repository of repositories) {
    const repositoryRoot = path.join(splitRoot, repository);
    for (const relativeFile of await listTextFiles(repositoryRoot)) {
      filesChecked += 1;
      const lines = (await readFile(path.join(repositoryRoot, relativeFile), "utf8")).split(/\r?\n/u);
      for (const [lineIndex, line] of lines.entries()) {
        for (const [kind, pattern] of REMOVED_CONTRACTS) {
          const match = pattern.exec(line);
          if (match === null || isExplicitRejection({ repository, relativeFile, lines, lineIndex, kind })) continue;
          violations.push({
            repository,
            file: normalize(relativeFile),
            line: lineIndex + 1,
            kind,
            value: match[0],
          });
        }
      }
    }
  }

  if (violations.length > 0) throw new DesktopIdentityAuditError(violations);
  return { splitRoot, repositories: [...repositories], filesChecked };
}

export function parseAuditArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (token === "--repositories") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --repositories.");
      const repositories = [...new Set(value
        .split(/[\n,]/u)
        .map((item) => item.trim())
        .filter(Boolean))];
      const unknown = repositories.filter((repository) => !SPLIT_REPOSITORIES.includes(repository));
      if (unknown.length > 0) throw new Error(`Unknown split repository: ${unknown.join(", ")}`);
      if (repositories.length === 0) throw new Error("--repositories must select at least one repository.");
      options.repositories = repositories;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

export class DesktopIdentityAuditError extends Error {
  constructor(violations) {
    super([
      `Desktop identity audit failed with ${violations.length} violation(s):`,
      ...violations.map(({ repository, file, line, kind, value }) =>
        `- ${repository}/${file}:${line}: ${kind}: ${JSON.stringify(value)}`),
    ].join("\n"));
    this.name = "DesktopIdentityAuditError";
    this.violations = violations;
  }
}

function isExplicitRejection({ repository, relativeFile, lines, lineIndex, kind }) {
  const context = lines.slice(Math.max(0, lineIndex - 1), lineIndex + 3).join("\n");
  if (
    repository === "harness" && normalize(relativeFile) === "src/runtime-platform.ts"
    && (kind === "runtime-marker" || kind === "runtime-value")
  ) {
    return /normalized\s*===\s*["']app["'][\s\S]*throw new TypeError\([\s\S]*no longer supported; use ["']desktop["']/u.test(context);
  }
  if (
    path.basename(repository).startsWith("build-in-")
    && normalize(relativeFile) === "scripts/builtin-release.mjs"
    && kind === "compatibility"
  ) {
    return /Object\.hasOwn\(release, ["']minAppVersion["']\)[\s\S]*throw new Error\([\s\S]*minAppVersion is not supported; use minDesktopVersion/u.test(context);
  }
  return false;
}

async function listTextFiles(root, relativeDirectory = "") {
  const directory = path.join(root, relativeDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Split repository is missing: ${root}`);
    }
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) files.push(...await listTextFiles(root, relativePath));
      continue;
    }
    const normalized = normalize(relativePath);
    if (
      entry.isFile() && !IGNORED_FILES.has(normalized)
      && !path.basename(normalized).startsWith("CHANGELOG") && isTextFile(entry.name)
    ) files.push(relativePath);
  }
  return files.sort();
}

function isTextFile(file) {
  if (file === ".env" || file.startsWith(".env.")) return true;
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function normalize(file) {
  return file.split(path.sep).join("/");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await auditDesktopIdentity(parseAuditArgs(process.argv.slice(2)));
    process.stdout.write(`Desktop identity audit passed: ${result.filesChecked} files across ${result.repositories.length} repositories.\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
