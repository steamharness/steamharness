export interface FileBlobClient {
  fetchProjectFile(fileId: string): Promise<Blob>;
}

interface KnowledgeImageCacheState {
  pending: Map<string, Promise<string | null>>;
  disposed: boolean;
}

const knowledgeImageCacheStates = new WeakMap<Map<string, string>, KnowledgeImageCacheState>();

export function readProjectFileIdFromMarkdownImageSrc(src: string, origin = readCurrentOrigin()): string | null {
  const trimmed = src.trim();
  if (!trimmed) return null;

  const rawPath = (() => {
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const url = new URL(trimmed);
        const expectedOrigin = normalizeOrigin(origin);
        if (expectedOrigin && url.origin !== expectedOrigin) return null;
        return url.pathname;
      } catch {
        return null;
      }
    }
    return trimmed.split(/[?#]/, 1)[0] ?? "";
  })();
  if (!rawPath) return null;

  const prefix = "/api/projects/files/";
  if (!rawPath.startsWith(prefix)) return null;
  const fileId = rawPath.slice(prefix.length).split("/", 1)[0] ?? "";
  if (!fileId) return null;

  try {
    return decodeURIComponent(fileId);
  } catch {
    return fileId;
  }
}

export async function resolveKnowledgeImageSrc(
  src: string,
  options: {
    client: FileBlobClient;
    cache: Map<string, string>;
    origin?: string;
  },
): Promise<string | null | undefined> {
  const fileId = readProjectFileIdFromMarkdownImageSrc(src, options.origin);
  if (!fileId) return undefined;

  const cached = options.cache.get(fileId);
  if (cached) return cached;

  const state = getKnowledgeImageCacheState(options.cache);
  const pending = state.pending.get(fileId);
  if (pending) return pending;

  // Resolve server file images through the authenticated host client so the
  // rendered <img> never has to make an unauthenticated raw request. Keeping
  // the Promise in the session also prevents duplicate Markdown references
  // from downloading and allocating separate object URLs.
  const request = options.client.fetchProjectFile(fileId)
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      if (state.disposed) {
        URL.revokeObjectURL(url);
        return null;
      }
      options.cache.set(fileId, url);
      return url;
    })
    .catch((error) => {
      console.warn("Unable to resolve knowledge image", error);
      return null;
    })
    .finally(() => {
      state.pending.delete(fileId);
    });
  state.pending.set(fileId, request);
  return request;
}

/**
 * Ends a host-owned image session. Hosts revoke completed URLs themselves;
 * this marks pending requests so a late Blob is immediately released too.
 */
export function disposeKnowledgeImageCache(cache: Map<string, string>): void {
  const state = knowledgeImageCacheStates.get(cache);
  if (state) state.disposed = true;
}

function getKnowledgeImageCacheState(cache: Map<string, string>): KnowledgeImageCacheState {
  const current = knowledgeImageCacheStates.get(cache);
  if (current && !current.disposed) return current;

  const next: KnowledgeImageCacheState = {
    pending: new Map<string, Promise<string | null>>(),
    disposed: false,
  };
  knowledgeImageCacheStates.set(cache, next);
  return next;
}

function normalizeOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

function readCurrentOrigin(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location.origin;
}
