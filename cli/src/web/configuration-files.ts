import { CONFIGURATION_FILE_MAX_BYTES, parseConfigurationFile, validateConfigurationFileSelection, type ProjectConfigurationField } from '@steamharness/project-configuration';
import type { WebConnection } from './runtime';

/** Configuration files always use project-scoped Server storage, independent of run history. */
export async function uploadConfigurationFile(projectId: string, field: ProjectConfigurationField, input: unknown, connection: WebConnection | undefined) {
  if (!connection) throw new Error('SteamHarness Server login is required.');
  if (!input || typeof input !== 'object') throw new Error('Invalid configuration file upload.');
  const file = input as Record<string, unknown>;
  if (typeof file.name !== 'string' || typeof file.mimeType !== 'string' || typeof file.data !== 'string' || Object.keys(file).some(key => !['name','mimeType','data'].includes(key))
    || file.data.length > Math.ceil(CONFIGURATION_FILE_MAX_BYTES / 3) * 4 || file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new Error('Invalid configuration file upload.');
  const bytes = Buffer.from(file.data, 'base64');
  validateConfigurationFileSelection(field, {name:file.name,mimeType:file.mimeType,size:bytes.length});
  const query = new URLSearchParams({fileName:file.name,mimeType:file.mimeType});
  const response = await fetch(`${connection.serverUrl}/api/projects/${encodeURIComponent(projectId)}/files?${query}`, {
    method:'POST', headers:{Authorization:`Bearer ${connection.accessToken}`,'Content-Type':file.mimeType}, body:bytes,
    redirect:'error', signal:AbortSignal.timeout(120_000),
  });
  const result = await response.json();
  if (!response.ok || result.errCode !== 0) throw new Error(result.errMessage || 'Configuration file upload failed.');
  if (!Array.isArray(result.data) || result.data.length !== 1) throw new Error('Invalid server file reference.');
  const reference = parseConfigurationFile(result.data[0]);
  if (reference.projectId !== projectId || reference.size !== bytes.length) throw new Error('Invalid server file reference.');
  validateConfigurationFileSelection(field, reference);
  return reference;
}
