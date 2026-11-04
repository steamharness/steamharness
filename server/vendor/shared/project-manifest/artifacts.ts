import { normalizeEntryPath } from "./index";

export const PROJECT_ARTIFACT_DIRECTORY = "dist/steamharness";
export const DATABASE_GENERATED_DIRECTORY = `${PROJECT_ARTIFACT_DIRECTORY}/generated/database`;

/** All paths are relative to the aggregate root, including child-entry outputs. */
export function projectArtifactDirectory(sourceRoot = "."): string {
  normalizeEntryPath(sourceRoot, "database source root", true);
  return sourceRoot === "." ? PROJECT_ARTIFACT_DIRECTORY : `${PROJECT_ARTIFACT_DIRECTORY}/entries/${encodeURIComponent(sourceRoot)}`;
}

export function databaseArtifactDirectory(sourceRoot = "."): string {
  return `${projectArtifactDirectory(sourceRoot)}/generated/database`;
}

/** Source entries are relative to their source root; Kanban artifacts use the aggregate root. */
export function projectEntryFilePath(entry: { root: string; entry: string; type: string }): string {
  return entry.type === "kanban" || entry.root === "." ? entry.entry : `${entry.root}/${entry.entry}`;
}

/** Return a canonical owner only for paths in the managed database output tree. */
export function databaseArtifactSourceRoot(filename: string): string | undefined {
  const normalized = filename.replaceAll("\\", "/");
  if (normalized.startsWith(`${DATABASE_GENERATED_DIRECTORY}/`)) return ".";
  const match = /^dist\/steamharness\/entries\/([^/]+)\/generated\/database\//.exec(normalized);
  if (!match) return undefined;
  try {
    const sourceRoot = decodeURIComponent(match[1]);
    return sourceRoot !== "." && encodeURIComponent(sourceRoot) === match[1]
      && normalized.startsWith(`${databaseArtifactDirectory(sourceRoot)}/`) ? sourceRoot : undefined;
  } catch { return undefined; }
}
