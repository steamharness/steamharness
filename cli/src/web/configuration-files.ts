import { CONFIGURATION_FILE_MAX_BYTES, parseConfigurationFile, validateConfigurationFileSelection, configurationSnapshot, type ProjectConfigurationState, type ProjectConfigurationField } from '@steamharness/project-configuration';
import type { WebConnection } from './runtime';

/** Configuration files always use project-scoped Server storage, independent of run history. */
export async function uploadConfigurationFile(projectId: string, field: ProjectConfigurationField, input: unknown, connection: WebConnection | undefined, options: { target?: string } = {}) {
  if (!connection) throw new Error('SteamHarness Server login is required.');
  if (!input || typeof input !== 'object') throw new Error('Invalid configuration file upload.');
  const file = input as Record<string, unknown>;
  if (typeof file.name !== 'string' || typeof file.mimeType !== 'string' || typeof file.data !== 'string' || Object.keys(file).some(key => !['name','mimeType','data'].includes(key))
    || file.data.length > Math.ceil(CONFIGURATION_FILE_MAX_BYTES / 3) * 4 || file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new Error('Invalid configuration file upload.');
  const bytes = Buffer.from(file.data, 'base64');
  validateConfigurationFileSelection(field, {name:file.name,mimeType:file.mimeType,size:bytes.length});
  const query = new URLSearchParams({fileName:file.name,mimeType:file.mimeType,key:field.name,field:JSON.stringify(field)});
  if (options.target !== undefined) query.set('target', options.target);
  const response = await fetch(`${connection.serverUrl}/api/projects/${encodeURIComponent(projectId)}/configurations/files?${query}`, {
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

/** Read configuration attachments through their narrow account/version permission, not project data access. */
export async function readConfigurationFile(projectId: string, state: ProjectConfigurationState, fileId: string, connection: WebConnection | undefined, options: { target?: string; signal?: AbortSignal } = {}) {
  let reference;
  for (const profile of state.configurations) for (const field of state.fields.filter(field => field.type === 'file')) {
    const value = configurationSnapshot(state, profile.id, false).values[field.name];
    const refs = value === undefined ? [] : (field.multiple && Array.isArray(value) ? value : [value]).map(parseConfigurationFile);
    reference ??= refs.find(ref => ref.id === fileId);
  }
  if (!reference) return;
  const unavailable = (cause?: unknown) => Object.assign(new Error('Configuration file is unavailable.', { cause }), { code: 'KANBAN_FILE_UNAVAILABLE' });
  if (!connection) throw unavailable();
  const target = options.target ?? 'draft';
  try {
    const response = await fetch(`${connection.serverUrl}/api/projects/${encodeURIComponent(projectId)}/configurations/files/${encodeURIComponent(fileId)}?target=${encodeURIComponent(target)}`, {
      headers: { Authorization: `Bearer ${connection.accessToken}` }, redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
    // A project-managed file can predate the attachment API. Let the caller try
    // its authenticated project bridge; permission and server failures must stop here.
    if (response.status === 404) return;
    if (!response.ok) throw unavailable();
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length !== reference.size) throw unavailable();
    return { file: reference, base64: data.toString('base64') };
  } catch (error) { throw unavailable(error); }
}
