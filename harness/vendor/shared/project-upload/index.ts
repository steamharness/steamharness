import ignore, { type Ignore } from "ignore";
import {
  KANBAN_MANIFEST_FILE,
  createKanbanArtifactEntryPath,
  readKanbanArtifactConfig,
  readPackageProjectType,
} from "../kanban-project/index";

export const STEAMHARNESS_IGNORE_FILE = ".workflowignore";

export interface UploadPathOptions {
  directory?: boolean;
}

export interface UploadMatcher {
  ignores(relativePath: string, options?: UploadPathOptions): boolean;
  explain(relativePath: string, options?: UploadPathOptions): string | undefined;
  assertRequiredPaths(relativePaths: readonly string[]): void;
}

export function hasWorkflowIgnoreRules(content: string | undefined): boolean {
  if (content === undefined) return false;
  return content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#");
  });
}

export function resolveWorkflowUploadRequiredPaths(
  packageJson: unknown,
  availablePaths: Iterable<string>,
): string[] {
  const normalizedAvailablePaths = new Set(
    Array.from(availablePaths, (filePath) => normalizeWorkflowUploadPath(filePath)),
  );
  if (readPackageProjectType(packageJson) === "kanban") {
    const artifact = readKanbanArtifactConfig(packageJson);
    return [
      "package.json",
      createKanbanArtifactEntryPath(artifact),
      ...(normalizedAvailablePaths.has(KANBAN_MANIFEST_FILE) ? [KANBAN_MANIFEST_FILE] : []),
    ];
  }
  return ["package.json", "index.ts"];
}

export function createWorkflowUploadMatcher(content?: string): UploadMatcher {
  const ruleLines = content === undefined ? [] : content.split(/\r?\n/);
  const matcher = ignore().add(ruleLines);

  return {
    ignores(relativePath, options) {
      const normalized = normalizeWorkflowUploadPath(relativePath, options);
      return normalized === STEAMHARNESS_IGNORE_FILE ? false : matcher.ignores(normalized);
    },
    explain(relativePath, options) {
      const normalized = normalizeWorkflowUploadPath(relativePath, options);
      if (normalized === STEAMHARNESS_IGNORE_FILE) return undefined;
      return findEffectiveWorkflowIgnoreRule(normalized, ruleLines);
    },
    assertRequiredPaths(relativePaths) {
      for (const relativePath of relativePaths) {
        const normalized = normalizeWorkflowUploadPath(relativePath);
        if (!matcher.ignores(normalized)) continue;
        const rule = findEffectiveWorkflowIgnoreRule(normalized, ruleLines);
        const suffix = rule === undefined ? "" : ` by rule ${JSON.stringify(rule)}`;
        throw new Error(
          `Required upload path ${JSON.stringify(normalized)} is excluded by ${STEAMHARNESS_IGNORE_FILE}${suffix}.`,
        );
      }
    },
  };
}

export function normalizeWorkflowUploadPath(
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

export function createWorkflowUploadPortablePathKey(relativePath: string): string {
  return normalizeWorkflowUploadPath(relativePath).normalize("NFC").toLowerCase();
}

function findEffectiveWorkflowIgnoreRule(
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
