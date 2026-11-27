import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export interface PlatformConnection {
  serverUrl: string;
  accessToken: string;
}

export interface PlatformConnections {
  project?: PlatformConnection;
  ai?: PlatformConnection;
}

/** Resolve only an explicitly supplied project connection; never consult saved credentials or system AI. */
export async function resolveLocalStorageAccountKey(connection?: PlatformConnection): Promise<string> {
  if (!connection) return 'local';
  const url = new URL(connection.serverUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid project Server address.');
  if (['localhost', '[::1]'].includes(url.hostname)) url.hostname = '127.0.0.1';
  const server = url.href.replace(/\/+$/, '');
  const response = await fetch(`${server}/api/auth/me`, { headers: { Authorization: `Bearer ${connection.accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const result = response.ok && await response.json() as { errCode: number; data?: { profile?: { userId?: string } } };
  const id = result && result.errCode === 0 && result.data?.profile?.userId;
  if (typeof id !== 'string' || !id) throw new Error('Could not verify the project account for local storage.');
  return createHash('sha256').update(JSON.stringify([server, id])).digest('hex');
}

const scope = new AsyncLocalStorage<PlatformConnections>();

/** Opt into APIs that require a Server connection. Project and AI credentials are never interchangeable. */
export function withPlatformConnections<T>(connections: PlatformConnections, run: () => T): T {
  return scope.run(connections, run);
}

export function currentPlatformConnections(): PlatformConnections | undefined {
  return scope.getStore();
}
