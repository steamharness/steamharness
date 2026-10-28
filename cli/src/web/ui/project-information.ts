import { t } from '../localization';
import { projectTypeLabels, type Project } from '../workflow-types';
import { projectAvatarDataUrl } from '@steamharness/project-card-metadata/avatar';

export interface ProjectInformationSection {
  title: string;
  expanded?: boolean;
  rows: { label: string; value: string; avatarUrl?: string }[];
}

export function projectInformation(project: Project): ProjectInformationSection[] {
  const info = project.projectInfo;
  const declarations: Record<string, string> = { multilingual: t("Multiple languages"), multiplatform: t("Multiple platforms") };
  const platforms: Record<string, string> = { macos: 'macOS', windows: 'Windows', web: 'Web' };
  const sections: ProjectInformationSection[] = [{
    title: t("Basic information"), expanded: true, rows: [
      { label: t("Default name"), value: project.manifest?.name || project.name },
      { label: t("Project type"), value: [...new Set(project.entries.map(entry => projectTypeLabels[entry.type]))].join(' / ') },
      { label: t("Version"), value: project.manifest?.version || t("Not declared") },
      { label: t("Project UUID"), value: project.id },
      { label: project.assistant ? t("Working directory") : t("Local path"), value: project.assistant?.workdir || project.folderPath },
    ],
  }, {
    title: t("Project declarations"), expanded: true, rows: [
      { label: t("Platform support"), value: info?.platformSupport.mode === 'specific'
        ? info.platformSupport.platforms.map(id => platforms[id] || id).join(', ') : t("Platform independent") },
      { label: t("Declarations"), value: info?.declarations.map(id => declarations[id] || id).join(', ') || t("Not declared") },
    ],
  }];
  if (info && Object.keys(info.localizedNames).length) {
    sections.push({ title: t("Localized names"), rows: Object.entries(info.localizedNames).map(([label, value]) => ({ label, value })) });
  }
  sections.push({ title: t("Project windows"), expanded: true, rows: project.entries.map(entry => ({ label: entry.name, value: `${entry.entryId} · ${projectTypeLabels[entry.type]}`, avatarUrl: projectAvatarDataUrl(entry.projectCard, entry.type) })) });
  if (project.entrypoints.length) {
    sections.push({ title: t("Entrypoints"), rows: project.entrypoints.map(entry => ({
      label: entry.title || entry.id,
      value: entry.id === project.defaultEntrypoint ? t("{0} (default)", entry.id) : entry.id,
    })) });
  }
  return sections;
}
