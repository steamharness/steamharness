import { Workflow, MessageCircle, Bot, Code, GitBranch, Boxes, Zap, Database, FileText, Cpu, Brain } from "lucide";
import { normalizeProjectCardMetadata, type ProjectCardMetadata } from "./index";
import type { ProjectKind } from "../project-types/index";

const icons = { workflow: Workflow, "message-circle": MessageCircle, bot: Bot, sparkles: Workflow,
  code: Code, "git-branch": GitBranch, boxes: Boxes, zap: Zap, database: Database, "file-text": FileText, cpu: Cpu, brain: Brain };

/** A self-contained Lucide avatar usable by HTML images, webviews and native tree items. */
export function projectAvatarSvg(value: Partial<ProjectCardMetadata> | undefined, projectType: ProjectKind = "workflow"): string {
  const card = normalizeProjectCardMetadata(value, projectType);
  const glyph = (icons[card.icon][2] ?? []).map(([tag, attributes]) => {
    const attrs = Object.entries(attributes).filter(([key]) => key !== "key")
      .map(([key, value]) => `${key}="${String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"`).join(" ");
    return `<${tag} ${attrs}/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="${card.iconBackgroundColor}"/><g transform="translate(14 14) scale(1.5)" fill="none" stroke="${card.iconColor}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${glyph}</g></svg>`;
}

export function projectAvatarDataUrl(card: Partial<ProjectCardMetadata> | undefined, projectType: ProjectKind = "workflow"): string {
  return `data:image/svg+xml,${encodeURIComponent(projectAvatarSvg(card, projectType))}`;
}
