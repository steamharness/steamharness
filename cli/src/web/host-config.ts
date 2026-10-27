import path from 'node:path';
import { parseUserSettings, type UserSettings } from 'steamharness';
import type { WebConnection } from './runtime';
import type { Project } from './workflow-types';
import type { CliRelatedProjectSpec } from '../related-projects';

export interface WebHostConfiguration {
  connection?: WebConnection;
  surface: 'editor' | 'assistant';
  assistant?: NonNullable<Project['assistant']>;
  assistantProjectDir?: string;
  relatedProjects?: CliRelatedProjectSpec[];
  resourceProjects?: string[];
  userSettings?: UserSettings;
}

export function parseHostResourceProjects(value: unknown): string[] {
  if (value === undefined) { return []; }
  if (!Array.isArray(value) || value.length > 100 || value.some(directory => typeof directory !== 'string' || !path.isAbsolute(directory))) { throw new Error('Invalid host resource projects.'); }
  return [...new Set(value)] as string[];
}

export function parseHostRelatedProjects(value: unknown): CliRelatedProjectSpec[] {
  if (value === undefined) { return []; }
  if (!Array.isArray(value) || value.length > 100) { throw new Error('Invalid host related projects.'); }
  const aliases = new Set<string>(), directories = new Set<string>();
  return value.map(project => {
    if (!project || typeof project.alias !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(project.alias)
      || typeof project.projectDir !== 'string' || !path.isAbsolute(project.projectDir)
      || aliases.has(project.alias) || directories.has(project.projectDir)) { throw new Error('Invalid host related projects.'); }
    aliases.add(project.alias); directories.add(project.projectDir);
    return { alias: project.alias, projectDir: project.projectDir };
  });
}

export function parseHostConnection(value: unknown, options: { allowAi?: boolean } = {}): WebConnection | undefined {
  if (value === null || value === undefined) { return; }
  const connection = value as Partial<WebConnection>;
  if (typeof connection.serverUrl !== 'string' || typeof connection.accessToken !== 'string' || !connection.accessToken || connection.accessToken.length > 16_384) { throw new Error('Invalid host login.'); }
  const url = new URL(connection.serverUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) { throw new Error('Invalid host server URL.'); }
  if (options.allowAi !== true && (connection.aiServerUrl !== undefined || connection.aiAccessToken !== undefined)) { throw new Error('AI connection requires the assistant surface.'); }
  const aiServerUrl = connection.aiServerUrl === undefined ? undefined : normalizeHostUrl(connection.aiServerUrl, 'AI server');
  if (connection.aiAccessToken !== undefined && (typeof connection.aiAccessToken !== 'string' || !connection.aiAccessToken || connection.aiAccessToken.length > 16_384)) { throw new Error('Invalid host AI login.'); }
  if ((aiServerUrl === undefined) !== (connection.aiAccessToken === undefined)) { throw new Error('AI server URL and token must be configured together.'); }
  return { serverUrl: url.toString().replace(/\/+$/, ''), accessToken: connection.accessToken,
    ...(aiServerUrl === undefined ? {} : { aiServerUrl, aiAccessToken: connection.aiAccessToken }) };
}

/** Optional AI authentication is separate so older project CLIs can ignore it. */
export function parseHostAuthentication(message: { connection?: unknown; systemAiConnection?: unknown }): WebConnection | undefined {
  const connection = parseHostConnection(message.connection, { allowAi: true });
  if (message.systemAiConnection === undefined) { return connection; }
  if (connection?.aiServerUrl !== undefined || connection?.aiAccessToken !== undefined) { throw new Error('Duplicate host AI connection.'); }
  const ai = parseHostConnection(message.systemAiConnection);
  if (!ai) { return connection; }
  if (!connection) { throw new Error('System AI requires a host project account.'); }
  return { ...connection, aiServerUrl: ai.serverUrl, aiAccessToken: ai.accessToken };
}

function normalizeHostUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) { throw new Error(`Invalid host ${label} URL.`); }
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) { throw new Error(`Invalid host ${label} URL.`); }
  return url.toString().replace(/\/+$/, '');
}

export function parseHostConfiguration(value: unknown): WebHostConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid web host configuration.'); }
  const configuration = value as Record<string, any>;
  if (configuration.type !== 'configure' || !['editor', 'assistant'].includes(configuration.surface)) { throw new Error('Invalid web host configuration.'); }
  const assistant = configuration.assistant as WebHostConfiguration['assistant'];
  if (assistant && (typeof assistant.workdir !== 'string' || !path.isAbsolute(assistant.workdir) || !Array.isArray(assistant.roots) || !assistant.roots.length || assistant.roots.length > 100
    || (assistant.standalone !== undefined && typeof assistant.standalone !== 'boolean')
    || assistant.roots.some(root => typeof root.uri !== 'string' || typeof root.name !== 'string' || typeof root.folderPath !== 'string' || !path.isAbsolute(root.folderPath))
    || !assistant.roots.some(root => root.folderPath === assistant.workdir))) { throw new Error('Invalid assistant workspace.'); }
  const assistantProjectDir = configuration.assistantProjectDir;
  if (configuration.surface === 'assistant' && (!assistant || typeof assistantProjectDir !== 'string' || !path.isAbsolute(assistantProjectDir))) {
    throw new Error('A dedicated assistant project and its workspace are required.');
  }
  if (configuration.surface !== 'assistant' && (assistant || assistantProjectDir !== undefined)) { throw new Error('Assistant configuration requires the assistant surface.'); }
  return { surface: configuration.surface, assistant, assistantProjectDir,
    ...(configuration.userSettings === undefined ? {} : { userSettings: parseUserSettings(configuration.userSettings) }),
    connection: parseHostAuthentication(configuration),
    relatedProjects: parseHostRelatedProjects(configuration.relatedProjects),
    ...(configuration.resourceProjects === undefined ? {} : { resourceProjects: parseHostResourceProjects(configuration.resourceProjects) }) };
}
