import ignore, { type Ignore } from "ignore";
import {
  createKanbanArtifactEntryPath,
  readKanbanArtifactConfig,
  readPackageProjectType,
} from "../kanban-project/index";

import { PROJECT_CONFIGURATION_FILE } from "../project-configuration/index";

export const STEAMHARNESS_IGNORE_FILE = ".steamharnessignore";

export interface UploadPathOptions {
  directory?: boolean;
}

export interface UploadMatcher {
  ignores(relativePath: string, options?: UploadPathOptions): boolean;
  explain(relativePath: string, options?: UploadPathOptions): string | undefined;
  assertRequiredPaths(relativePaths: readonly string[]): void;
}

export function hasProjectIgnoreRules(content: string | undefined): boolean {
  if (content === undefined) return false;
  return content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#");
  });
}

export function resolveProjectUploadRequiredPaths(
  packageJson: unknown,
  availablePaths: Iterable<string>,
): string[] {
  const normalizedAvailablePaths = new Set(
    Array.from(availablePaths, (filePath) => normalizeProjectUploadPath(filePath)),
  );
  if (readPackageProjectType(packageJson) === "kanban") {
    const artifact = readKanbanArtifactConfig(packageJson);
    return [
      "package.json",
      createKanbanArtifactEntryPath(artifact),
      ...(normalizedAvailablePaths.has(PROJECT_CONFIGURATION_FILE) ? [PROJECT_CONFIGURATION_FILE] : []),
    ];
  }
  return ["package.json", "index.ts", ...(normalizedAvailablePaths.has(PROJECT_CONFIGURATION_FILE) ? [PROJECT_CONFIGURATION_FILE] : [])];
}

export function createProjectUploadMatcher(content?: string): UploadMatcher {
  const ruleLines = content === undefined ? [] : content.split(/\r?\n/);
  const matcher = ignore().add(ruleLines);

  return {
    ignores(relativePath, options) {
      const normalized = normalizeProjectUploadPath(relativePath, options);
      return normalized === STEAMHARNESS_IGNORE_FILE ? false : matcher.ignores(normalized);
    },
    explain(relativePath, options) {
      const normalized = normalizeProjectUploadPath(relativePath, options);
      if (normalized === STEAMHARNESS_IGNORE_FILE) return undefined;
      return findEffectiveProjectIgnoreRule(normalized, ruleLines);
    },
    assertRequiredPaths(relativePaths) {
      for (const relativePath of relativePaths) {
        const normalized = normalizeProjectUploadPath(relativePath);
        if (!matcher.ignores(normalized)) continue;
        const rule = findEffectiveProjectIgnoreRule(normalized, ruleLines);
        const suffix = rule === undefined ? "" : ` by rule ${JSON.stringify(rule)}`;
        throw new Error(
          `Required upload path ${JSON.stringify(normalized)} is excluded by ${STEAMHARNESS_IGNORE_FILE}${suffix}.`,
        );
      }
    },
  };
}

export function normalizeProjectUploadPath(
  relativePath: string,
  options: UploadPathOptions = {},
): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const withoutTrailingSlash = normalized.replace(/\/+$/, "");
  if (
    withoutTrailingSlash === "" ||
    withoutTrailingSlash.startsWith("/") ||
    /^[a-zA-Z]:/.test(withoutTrailingSlash) ||
    withoutTrailingSlash.includes("\0") ||
    withoutTrailingSlash.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid workflow upload path ${JSON.stringify(relativePath)}.`);
  }
  return options.directory === true ? `${withoutTrailingSlash}/` : withoutTrailingSlash;
}

export function createProjectUploadPortablePathKey(relativePath: string): string {
  return normalizeProjectUploadPath(relativePath).normalize("NFC").toLowerCase();
}

function findEffectiveProjectIgnoreRule(
  normalizedPath: string,
  ruleLines: readonly string[],
): string | undefined {
  const matcher: Ignore = ignore();
  let ignored = false;
  let effectiveRule: string | undefined;
  for (const ruleLine of ruleLines) {
    matcher.add(ruleLine);
    const nextIgnored = matcher.ignores(normalizedPath);
    if (nextIgnored !== ignored) {
      ignored = nextIgnored;
      effectiveRule = ruleLine;
    }
  }
  return ignored ? effectiveRule : undefined;
}
