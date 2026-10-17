import type { WorkflowProjectAccessRule } from '@steamharness/project-info';
import { t } from '../localization';
import { projectTypeLabels, type WorkflowProject } from '../workflow-types';

export interface ProjectInformationSection {
  title: string;
  expanded?: boolean;
  rows: { label: string; value: string }[];
}

function access(rule?: WorkflowProjectAccessRule): string {
  if (rule?.mode === 'all') { return t("All"); }
  if (rule?.mode === 'none') { return t("Not allowed"); }
  if (rule?.mode === 'prefixes') { return `${t("Prefixes")}: ${rule.prefixes.join(', ')}`; }
  return t("Not declared");
}

export function projectInformation(project: WorkflowProject): ProjectInformationSection[] {
  const info = project.projectInfo;
  const storage = { local: t("Local"), server: t("Server"), both: t("Local and server") };
  const declarations: Record<string, string> = { multilingual: t("Multiple languages"), multiplatform: t("Multiple platforms") };
  const platforms: Record<string, string> = { macos: 'macOS', windows: 'Windows', web: 'Web' };
  const sections: ProjectInformationSection[] = [{
    title: t("Basic information"), expanded: true, rows: [
      { label: t("Default name"), value: project.manifest?.name || project.name },
      { label: t("Project type"), value: projectTypeLabels[project.projectType] },
      { label: t("Version"), value: project.manifest?.version || t("Not declared") },
      { label: t("Project UUID"), value: project.id },
      { label: project.assistant ? t("Working directory") : t("Local path"), value: project.assistant?.workdir || project.folderPath },
    ],
  }, {
    title: t("Project declarations"), expanded: true, rows: [
      { label: t("Storage location"), value: info?.dataStorage ? storage[info.dataStorage.mode] : t("Not declared") },
      { label: t("Platform support"), value: info?.platformSupport.mode === 'specific'
        ? info.platformSupport.platforms.map(id => platforms[id] || id).join(', ') : t("Platform independent") },
      { label: t("Declarations"), value: info?.declarations.map(id => declarations[id] || id).join(', ') || t("Not declared") },
    ],
  }];
  if (info && Object.keys(info.localizedNames).length) {
    sections.push({ title: t("Localized names"), rows: Object.entries(info.localizedNames).map(([label, value]) => ({ label, value })) });
  }
  for (const relation of info?.relatedProjects ?? []) {
    const grant = relation.grantToRelatedProject;
    sections.push({ title: t("Related project: {0}", relation.alias), rows: [
      { label: t("Project UUID"), value: relation.projectId },
      { label: t("KV read granted"), value: access(grant.read) },
      { label: t("KV write granted"), value: access(grant.write) },
      { label: t("Knowledge read granted"), value: access(grant.knowledge?.read) },
      { label: t("Knowledge write granted"), value: access(grant.knowledge?.write) },
      { label: t("Entrypoints granted"), value: access(grant.entrypoints) },
    ] });
  }
  if (project.entrypoints.length) {
    sections.push({ title: t("Entrypoints"), rows: project.entrypoints.map(entry => ({
      label: entry.title || entry.id,
      value: entry.id === project.defaultEntrypoint ? t("{0} (default)", entry.id) : entry.id,
    })) });
  }
  return sections;
}
