import { t } from './localization';
import type { Project } from './workflow-types';
import type { ProjectVersionStatus } from './steamharness-server-projects';
import { projectAvatarDataUrl } from '@steamharness/project-card-metadata/avatar';

export interface InfoItem {
  id: string;
  label: string;
  value?: string;
  icon?: string;
  avatarUrl?: string;
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
  const basic = [
    row('name', t("Default name"), text(pkg.name) ?? project.name),
    row('type', t("Project type"), [...new Set(project.entries.map(entry => t(typeNames[entry.type])))].join(' / ')),
    row('version', t("Version"), text(pkg.version) ?? t("Not declared")),
    row('uuid', t("Project UUID"), project.id),
    row('path', t("Local path"), project.folderPath, 'folder'),
  ];
  if (text(pkg.description)) { basic.push(row('description', t("Description"), text(pkg.description))); }

  const entries = project.entries.map(entry => ({ ...group(`window:${entry.entryId}`, entry.name, 'window', [
    row(`window:${entry.entryId}:id`, t('Entry ID'), entry.entryId),
    row(`window:${entry.entryId}:type`, t('Project type'), t(typeNames[entry.type])),
    row(`window:${entry.entryId}:path`, t('Local path'), `${entry.root}/${entry.entry}`),
  ], false), avatarUrl: projectAvatarDataUrl(entry.projectCard, entry.type) }));
  const databases = project.databases.map(database => group(`database:${database.alias}`, database.alias, 'database', [
    row(`database:${database.alias}:host`, t('Storage location'), database.host === 'local' ? t('Local') : t('Server')),
    row(`database:${database.alias}:binding`, t('Database binding'), database.bindingRef ?? t('Not bound')),
    row(`database:${database.alias}:kv-read`, t('KV read'), access(database.permissions.kv.read)),
    row(`database:${database.alias}:kv-write`, t('KV write'), access(database.permissions.kv.write)),
    row(`database:${database.alias}:knowledge-read`, t('Knowledge read'), access(database.permissions.knowledge.read)),
    row(`database:${database.alias}:knowledge-write`, t('Knowledge write'), access(database.permissions.knowledge.write)),
  ], false));

  const platforms = [row('platform-mode', t("Platform mode"), platform.mode === 'specific' ? t("Specific platforms")
    : platform.mode === undefined || platform.mode === 'agnostic' ? t("Platform independent") : text(platform.mode))];
  if (platform.mode === 'specific') {
    platforms.push(...strings(platform.platforms).map(id => row(`platform:${id}`, platformNames.get(id) ?? id, t("Supported"))));
  }
  const items = [
    group('basic', t("Basic Information"), 'info', basic),
    group('declarations', t("Project Declarations"), 'verified', declarations.map(id => row(`declaration:${id}`, declarationNames.has(id) ? t(declarationNames.get(id)!) : id, t("Declared")))),
    group('names', t("Localized Names"), 'globe', Object.entries(localizedNames)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1].trim())
      .map(([locale, name]) => row(`name:${locale}`, locale, name))),
    group('platforms', t("Platform Support"), 'device-desktop', platforms),
    group('windows', t('Project windows'), 'window', entries, false),
    group('databases', t('Database spaces'), 'database', databases, false),
  ];
  if (project.entrypoints.length) {
    items.push(group('entrypoints', t("Entrypoints"), 'run-all', project.entrypoints.map(entry => row(`entry:${entry.id}`, entry.title ?? entry.id,
      entry.id === project.defaultEntrypoint ? t("{0} (default)", entry.id) : entry.id)), false));
  }
  return items;
}
