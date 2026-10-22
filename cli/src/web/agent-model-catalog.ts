import { parseAgentModelCatalog } from '@steamharness/project-configuration';
import type { WebConnection } from './runtime';

/** Uses only the independent, host-managed AI identity. Never exposes its token. */
export async function loadAgentModelCatalog(connection?: WebConnection) {
  const subscriptionUrl = connection?.aiServerUrl ? `${connection.aiServerUrl.replace(/\/+$/, '')}/settings/ai` : undefined;
  if (!connection?.aiServerUrl || !connection.aiAccessToken) return { entries: [], subscriptionUrl, unavailable: true };
  const response = await fetch(`${connection.aiServerUrl.replace(/\/+$/, '')}/api/ai/catalog`, {
    headers: { Authorization: `Bearer ${connection.aiAccessToken}` }, signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  const result = await response.json();
  if (!response.ok || result.errCode !== 0) throw new Error(result.errMessage || 'Cannot load system AI models.');
  return { entries: parseAgentModelCatalog(result.data), subscriptionUrl, unavailable: false };
}
