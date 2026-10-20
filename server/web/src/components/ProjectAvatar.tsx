import { projectAvatarDataUrl } from "@steamharness/project-card-metadata/avatar";
import type { ProjectCardMetadata, ProjectKind } from "../types";
import { cn } from "@/lib/utils";

export function ProjectAvatar({ card, projectType = "workflow", projectId, size = "sm" }: {
  card?: ProjectCardMetadata; projectType?: ProjectKind; projectId?: string; size?: "sm" | "md" | "lg";
}) {
  return <span data-testid={projectId ? `project-card-icon-${projectId}` : undefined} aria-hidden="true"
    className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-md", size === "lg" ? "size-16" : size === "md" ? "size-12" : "size-9")}>
    <img src={projectAvatarDataUrl(card, projectType)} alt="" className="size-full" />
  </span>;
}
