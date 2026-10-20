import { projectAvatarDataUrl } from "@steamharness/project-card-metadata/avatar";
import type { ProjectCardMetadata, ProjectKind } from "../types";
import { cn } from "@/lib/utils";
import { useTranslation } from "@steamharness/i18n/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function ProjectAvatar({ card, projectType = "workflow", projectId, size = "sm", label, onClick }: {
  card?: ProjectCardMetadata; projectType?: ProjectKind; projectId?: string; size?: "sm" | "md" | "lg";
  label?: string; onClick?: () => void;
}) {
  const { t } = useTranslation("serverWeb");
  const source = projectAvatarDataUrl(card, projectType);
  const title = onClick ? t("projectAvatarOpen", { name: label ?? "" }) : label ?? t("projectAvatarPreview");
  const trigger = <Button type="button" variant="ghost" title={title} aria-label={title}
    data-testid={projectId ? `project-card-icon-${projectId}` : undefined}
    className={cn("shrink-0 overflow-hidden rounded-md p-0", size === "lg" ? "size-16" : size === "md" ? "size-12" : "size-9")}
    onClick={event => { event.stopPropagation(); onClick?.(); }}>
    <img src={source} alt="" className="size-full" />
  </Button>;
  if (onClick) return trigger;
  return <Dialog>
    <DialogTrigger asChild>{trigger}</DialogTrigger>
    <DialogContent aria-describedby={undefined} onClick={event => event.stopPropagation()}>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <img src={source} alt={title} className="mx-auto aspect-square w-64 max-w-full rounded-md" />
    </DialogContent>
  </Dialog>;
}
