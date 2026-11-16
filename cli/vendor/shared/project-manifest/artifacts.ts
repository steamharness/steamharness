import { normalizeEntryPath } from "./entry-path";
import { isProjectEntryId } from "./identity";
import { PROJECT_ARTIFACT_DIRECTORY } from "./artifact-paths";
export * from "./artifact-paths";

/** All paths are relative to the aggregate root, including child-entry outputs. */
export function projectArtifactDirectory(sourceRoot = "."): string {
  normalizeEntryPath(sourceRoot, "project source root", true);
  return sourceRoot === "." ? PROJECT_ARTIFACT_DIRECTORY : `${PROJECT_ARTIFACT_DIRECTORY}/entries/${encodeURIComponent(sourceRoot)}`;
}

/** Each source root owns generated code and a separate build directory for every entry. */
export function projectEntryBuildDirectory(entry: { root: string; entryId: string }): string {
  if (!isProjectEntryId(entry.entryId)) throw new Error("Invalid or reserved project entry identity.");
  return `${projectArtifactDirectory(entry.root)}/build/${entry.entryId}`;
}

/** Source entries are relative to their source root; Kanban artifacts use the aggregate root. */
export function projectEntryFilePath(entry: { root: string; entry: string; type: string }): string {
  return entry.type === "kanban" || entry.root === "." ? entry.entry : `${entry.root}/${entry.entry}`;
}
