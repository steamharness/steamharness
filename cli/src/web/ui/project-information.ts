import { readProjectInfo, resolveProjectName } from '@steamharness/project-info';
import { renderProjectDetails, type ProjectDetailSection } from '@steamharness/project-info/details';
import { projectAvatarDataUrl } from '@steamharness/project-card-metadata/avatar';
import { locale, t } from '../localization';
import type { Project } from '../workflow-types';
import '@steamharness/project-info/details.css';

export function projectInformation(project: Project, { secondaryActions, usage, studio = false }: {
  secondaryActions?: HTMLElement; usage?: HTMLElement; studio?: boolean;
} = {}): HTMLElement {
  const info = project.projectInfo, language = locale();
  const label = (en: string, zh: string) => language === 'zh-CN' ? zh : en;
  const declarations = new Map([['multilingual', t('Multiple languages')], ['multiplatform', t('Multiple platforms')]]);
  const platforms = new Map([['macos', 'macOS'], ['windows', 'Windows'], ['web', 'Web']]);
  const sections: ProjectDetailSection[] = [];
  if (!studio || info?.platformSupport.mode === 'specific' || info?.declarations.length) sections.push({
    title: t('Project declarations'), expanded: true,
    rows: [
      [t('Platform support'), info?.platformSupport.mode === 'specific'
        ? info.platformSupport.platforms.map(id => platforms.get(id) ?? id).join(', ') : t('Platform independent')],
      [t('Declarations'), info?.declarations.map(id => declarations.get(id) ?? id).join(', ') || t('Not declared')],
    ],
  });
  if (!studio && info && Object.keys(info.localizedNames).length) {
    sections.push({ title: t('Localized names'), rows: Object.entries(info.localizedNames) });
  }
  if (project.entrypoints.length) {
    sections.push({ title: t('Entrypoints'), rows: project.entrypoints.map(entry => [
      entry.title || entry.id, entry.id === project.defaultEntrypoint ? t('{0} (default)', entry.id) : entry.id,
    ]) });
  }

  const primary = project.entries.find(entry => entry.entryId === project.defaultEntry);
  const defaultName = project.manifest?.name || project.name;
  return renderProjectDetails(document, {
    kind: 'folder', uri: project.uri, name: project.aggregateName, projectId: project.id,
    projectType: primary?.type ?? project.projectType, path: project.assistant?.workdir || project.folderPath,
    version: project.manifest?.version || t('Not declared'), description: project.manifest?.description,
    distribution: project.distribution,
    avatarUrl: projectAvatarDataUrl(project.aggregateProjectCard ?? primary?.projectCard, primary?.type ?? project.projectType),
    entries: project.entries.map(entry => ({
      entryId: entry.entryId, primary: entry.entryId === project.defaultEntry, type: entry.type,
      name: resolveProjectName(entry.name, readProjectInfo(entry), language),
      avatarUrl: projectAvatarDataUrl(entry.projectCard, entry.type),
    })),
  }, label, {
    title: 'h3', sections, secondaryActions, usage, showWindowStatus: studio, currentWindow: studio,
    formatLabel: studio ? undefined : project.distribution === 'release' ? label('Release', '发行版') : project.distribution === 'source' ? label('Source', '源码') : undefined,
    locationLabel: !studio && project.assistant ? t('Working directory') : undefined,
    extraFacts: !studio && defaultName && defaultName !== project.aggregateName ? [[t('Default name'), defaultName]] : undefined,
  });
}
