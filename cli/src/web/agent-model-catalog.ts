import { parseAgentModelCatalog } from '@steamharness/project-configuration';
import type { WebConnection } from './runtime';
import { ServerReadCache } from './server-read-cache';

const catalogCache = new ServerReadCache(30_000, 1);
let catalogIdentity: string | undefined;

/** Uses only the independent, host-managed AI identity. Never exposes its token. */
export async function loadAgentModelCatalog(connection?: WebConnection) {
  const identity = connection?.aiServerUrl && connection.aiAccessToken
    ? JSON.stringify([connection.aiServerUrl.replace(/\/+$/, ''), connection.aiAccessToken]) : undefined;
  if (identity !== catalogIdentity) { catalogCache.clear(); catalogIdentity = identity; }
  const subscriptionUrl = connection?.aiServerUrl ? `${connection.aiServerUrl.replace(/\/+$/, '')}/settings/ai` : undefined;
  if (!connection?.aiServerUrl || !connection.aiAccessToken) return { entries: [], subscriptionUrl, unavailable: true };
  const { aiServerUrl, aiAccessToken } = connection;
  const value = await catalogCache.read(identity!, async () => {
    const response = await fetch(`${aiServerUrl.replace(/\/+$/, '')}/api/ai/catalog`, {
      headers: { Authorization: `Bearer ${aiAccessToken}` }, signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok || result.errCode !== 0) throw new Error(result.errMessage || 'Cannot load system AI models.');
    return { entries: parseAgentModelCatalog(result.data), subscriptionUrl, unavailable: false };
  });
  if (identity !== catalogIdentity) throw new Error('Resource access changed. Open the card again.');
  return value;
}
