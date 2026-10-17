import path from "node:path";
import { inferServerEnvMode } from "./env";

export function resolveReleaseStorageRootFromEnv(): string | undefined {
  const raw = process.env.STEAMHARNESS_RELEASE_STORAGE_ROOT?.trim();
  return raw ? path.resolve(raw) : undefined;
}

export function resolvePublishedRoot(): string | undefined {
  const releaseRoot = resolveReleaseStorageRootFromEnv();
  return releaseRoot ? path.join(releaseRoot, "published") : undefined;
}

export function resolveReleaseMetadataRootFromEnv(): string | undefined {
  const explicit = firstNonEmpty(process.env.STEAMHARNESS_RELEASE_METADATA_DIR);
  if (explicit) {
    return path.resolve(explicit);
  }

  const releaseRoot = resolveReleaseStorageRootFromEnv();
  return releaseRoot ? path.join(releaseRoot, "releases") : undefined;
}

export function resolveServerDataRootFromEnv(options: {
  serverRoot: string;
  mode?: "development" | "production";
}): string {
  const explicit = firstNonEmpty(
    process.env.STEAMHARNESS_SERVER_DATA_DIR,
    process.env.STEAMHARNESS_SERVER_DEPLOY_DIR,
  );

  if (explicit) {
    return path.resolve(explicit);
  }

  const mode = options.mode ?? inferServerEnvMode();
  const releaseRoot = resolveReleaseStorageRootFromEnv();

  // Keeps production runtime data pinned to the mounted release root instead
  // of silently falling back to server/.data.
  if (mode === "production" && releaseRoot) {
    return path.join(releaseRoot, "server-data");
  }

  return path.join(options.serverRoot, ".data");
}

export function resolveDocsRoot(): string | undefined {
  const explicit = firstNonEmpty(process.env.STEAMHARNESS_DOCS_ROOT);

  if (explicit) {
    return path.resolve(explicit);
  }

  const publishedRoot = resolvePublishedRoot();
  return publishedRoot ? path.join(publishedRoot, "docs", "stable") : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value?.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
