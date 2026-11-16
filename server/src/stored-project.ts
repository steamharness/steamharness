import { normalizeProjectManifest, type ProjectManifest } from "@steamharness/project-manifest";

export interface StoredProjectManifestRow {
  id: string;
  name: string;
  entries: unknown;
  default_entry: string | null;
}

export class InvalidStoredProjectError extends Error {
  constructor(readonly projectId: string, cause: unknown) {
    super("Stored project entries are invalid.", { cause });
    this.name = "InvalidStoredProjectError";
  }
}

export function readStoredProjectManifest(row: StoredProjectManifestRow): ProjectManifest {
  // These retired declarations remain in existing rows. Ignore them only when
  // reading persistence; authored manifests must still pass the strict schema.
  const entries = Array.isArray(row.entries) ? row.entries.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const { databases, knowledgeBases, ...current } = entry as Record<string, unknown>;
    return current;
  }) : row.entries;
  try {
    return normalizeProjectManifest({
      projectId: row.id,
      name: row.name,
      entries,
      defaultEntry: row.default_entry,
    });
  } catch (error) {
    throw new InvalidStoredProjectError(row.id, error);
  }
}

export function isSupportedStoredProject(row: StoredProjectManifestRow): boolean {
  try {
    readStoredProjectManifest(row);
    return true;
  } catch (error) {
    if (error instanceof InvalidStoredProjectError) return false;
    throw error;
  }
}
