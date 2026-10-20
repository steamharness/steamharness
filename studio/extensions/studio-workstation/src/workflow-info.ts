import { t } from './localization';
import type { Project } from './workflow-types';
import type { ProjectVersionStatus } from './steamharness-server-projects';

export interface InfoItem {
  id: string;
  label: string;
  value?: string;
  icon?: string;
  expanded?: boolean;
  children?: InfoItem[];
}

export interface InfoState {
  type: 'info-state';
  generation: number;
  project?: Pick<Project, 'uri' | 'name'> & { avatarUrl?: string };
  items: InfoItem[];
  update?: ProjectVersionStatus;
}

const declarationNames = new Map([['multilingual', 'Multiple languages'], ['multiplatform', 'Multiple platforms']]);
const platformNames = new Map([['macos', 'macOS'], ['windows', 'Windows'], ['web', 'Web']]);
const storageNames = new Map([['local', 'Local'], ['server', 'Server'], ['both', 'Local and server']]);
const typeNames = { workflow: 'Workflow', conversation: 'Conversation', kanban: 'Kanban' };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim()) : []; }
function row(id: string, label: string, value?: string, icon?: string): InfoItem { return { id, label, value, icon }; }
function group(id: string, label: string, icon: string, children: InfoItem[], expanded = true): InfoItem {
  return { id, label, icon, expanded, children: children.length ? children : [row(`${id}:empty`, t("Not declared"))] };
}

function access(value: unknown): string {
  const rule = record(value);
  if (rule.mode === 'all') { return t("All"); }
  if (rule.mode === 'none') { return t("Not allowed"); }
  if (rule.mode === 'prefixes') { return `${t("Prefixes")}: ${strings(rule.prefixes).join(', ') || t("None")}`; }
  return text(rule.mode) ?? t("Not declared");
}

export function projectInfoItems(project: Project, manifest: unknown): InfoItem[] {
  const pkg = record(manifest);
  const info = record(record(pkg.steamHarness).projectInfo);
  const declarations = strings(info.declarations);
  const localizedNames = record(info.localizedNames);
  const platform = record(info.platformSupport);
  const storage = record(info.dataStorage);
  const basic = [
    row('name', t("Default name"), text(pkg.name) ?? project.name),
    row('type', t("Project type"), t(typeNames[project.projectType])),
    row('version', t("Version"), text(pkg.version) ?? t("Not declared")),
    row('uuid', t("Project UUID"), project.id),
    row('path', t("Local path"), project.folderPath, 'folder'),
  ];
  if (text(pkg.description)) { basic.push(row('description', t("Description"), text(pkg.description))); }

  const related = (Array.isArray(info.relatedProjects) ? info.relatedProjects : []).map((value, index) => {
    const relation = record(value), grant = record(relation.grantToRelatedProject), knowledge = record(grant.knowledge);
    const id = `relation:${index}`;
    const children = [
      row(`${id}:uuid`, t("Project UUID"), text(relation.projectId)),
      group(`${id}:grant`, t("Permissions Granted to Related Project"), 'shield', [
        row(`${id}:read`, t("KV read"), access(grant.read)),
        row(`${id}:write`, t("KV write"), access(grant.write)),
        row(`${id}:knowledge-read`, t("Knowledge read"), access(knowledge.read)),
        row(`${id}:knowledge-write`, t("Knowledge write"), access(knowledge.write)),
        row(`${id}:entrypoints`, t("Entrypoints"), access(grant.entrypoints)),
      ]),
    ];
    return group(id, text(relation.alias) ?? text(relation.projectId) ?? t("Related Projects"), 'link', children, false);
  });

  const platforms = [row('platform-mode', t("Platform mode"), platform.mode === 'specific' ? t("Specific platforms")
    : platform.mode === undefined || platform.mode === 'agnostic' ? t("Platform independent") : text(platform.mode))];
  if (platform.mode === 'specific') {
    platforms.push(...strings(platform.platforms).map(id => row(`platform:${id}`, platformNames.get(id) ?? id, t("Supported"))));
  }
  const mode = text(storage.mode);
  const items = [
    group('basic', t("Basic Information"), 'info', basic),
    group('declarations', t("Project Declarations"), 'verified', declarations.map(id => row(`declaration:${id}`, declarationNames.has(id) ? t(declarationNames.get(id)!) : id, t("Declared")))),
    group('names', t("Localized Names"), 'globe', Object.entries(localizedNames)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1].trim())
      .map(([locale, name]) => row(`name:${locale}`, locale, name))),
    group('platforms', t("Platform Support"), 'device-desktop', platforms),
    group('storage', t("Data Storage"), 'database', [row('storage-mode', t("Storage location"), mode ? storageNames.has(mode) ? t(storageNames.get(mode)!) : mode : t("Not declared"))]),
    group('related', t("Related resources"), 'references', related, false),
  ];
  if (project.entrypoints.length) {
    items.push(group('entrypoints', t("Entrypoints"), 'run-all', project.entrypoints.map(entry => row(`entry:${entry.id}`, entry.title ?? entry.id,
      entry.id === project.defaultEntrypoint ? t("{0} (default)", entry.id) : entry.id)), false));
  }
  return items;
}
