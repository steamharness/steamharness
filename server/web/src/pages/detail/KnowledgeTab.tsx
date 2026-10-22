import { disposeKnowledgeImageCache, resolveKnowledgeImageSrc } from "@steamharness/knowledge-base";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { apiClient } from "../../api";
import { createServerKnowledgeRepository } from "./knowledge-repository";
import type { DetailPageProps } from "./types";
import { KnowledgeTableWorkspace } from "./KnowledgeTableWorkspace";

interface ServerImageSession {
  cache: Map<string, string>;
  controller: AbortController;
  disposed: boolean;
}

export function KnowledgeTab({
  project,
  knowledgeRepository,
  knowledgeRefreshToken,
  onResolveKnowledgeImageSrc,
  onKnowledgeDirtyChange,
  onContentBusyChange,
}: DetailPageProps) {
  const serverRepository = useMemo(
    () => createServerKnowledgeRepository(apiClient, project.id),
    [project.id],
  );
  const imageSession = useMemo<ServerImageSession>(() => ({
    cache: new Map<string, string>(),
    controller: new AbortController(),
    disposed: false,
  }), [project.id]);
  const activeImageSessionRef = useRef<ServerImageSession | null>(imageSession);
  const resolveServerImage = useCallback(async (src: string) => {
    const resolved = await resolveKnowledgeImageSrc(src, {
      client: {
        fetchProjectFile: (fileId) => apiClient.fetchProjectFile(fileId, {
          signal: imageSession.controller.signal,
        }),
      },
      cache: imageSession.cache,
    });
    if (imageSession.disposed || activeImageSessionRef.current !== imageSession) {
      releaseStaleServerImageUrl(imageSession.cache, resolved);
      return null;
    }
    return resolved;
  }, [imageSession]);

  useEffect(() => {
    activeImageSessionRef.current = imageSession;
    return () => {
      imageSession.disposed = true;
      imageSession.controller.abort();
      disposeKnowledgeImageCache(imageSession.cache);
      for (const url of imageSession.cache.values()) {
        URL.revokeObjectURL(url);
      }
      imageSession.cache.clear();
      if (activeImageSessionRef.current === imageSession) {
        activeImageSessionRef.current = null;
      }
    };
  }, [imageSession]);

  return (
    <div className="h-full min-h-0">
      <KnowledgeTableWorkspace
        key={project.id}
        repository={knowledgeRepository ?? serverRepository}
        readOnly={!project.access?.capabilities.includes("writeData")}
        refreshToken={knowledgeRefreshToken}
        onBusyChange={onContentBusyChange}
        resolveImageSrc={onResolveKnowledgeImageSrc ?? resolveServerImage}
        onDirtyChange={onKnowledgeDirtyChange}
      />
    </div>
  );
}

function releaseStaleServerImageUrl(
  cache: Map<string, string>,
  resolved: string | null | undefined,
): void {
  if (!resolved?.startsWith("blob:")) return;
  const entry = [...cache.entries()].find(([, url]) => url === resolved);
  if (!entry) return;
  cache.delete(entry[0]);
  URL.revokeObjectURL(resolved);
}
