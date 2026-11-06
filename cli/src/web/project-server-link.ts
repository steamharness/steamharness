import type { WebConnection } from './runtime';
import { t } from './localization';

/** Exchange authority for a short-lived browser handoff; never put a long-lived key in a URL. */
export async function projectServerBrowserLink(connection: WebConnection, projectId: string): Promise<string> {
  const response = await fetch(`${connection.serverUrl}/api/auth/browser-session`, {
    method: 'POST', headers: { Authorization: `Bearer ${connection.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnTo: `/detail/${encodeURIComponent(projectId)}` }), signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  const value = await response.json();
  if (!response.ok || value?.errCode !== 0 || typeof value.data?.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.data.code)) {
    throw new Error(t('Could not open the cloud project. Check your Server connection and try again.'));
  }
  return `${connection.serverUrl}/api/auth/browser-session?code=${encodeURIComponent(value.data.code)}`;
}
