import { AsyncLocalStorage } from 'node:async_hooks';

export interface PlatformConnection {
  serverUrl: string;
  accessToken: string;
}

export interface PlatformConnections {
  project?: PlatformConnection;
  ai?: PlatformConnection;
}

const scope = new AsyncLocalStorage<PlatformConnections>();

/** Opt into APIs that require a Server connection. Project and AI credentials are never interchangeable. */
export function withPlatformConnections<T>(connections: PlatformConnections, run: () => T): T {
  return scope.run(connections, run);
}

export function currentPlatformConnections(): PlatformConnections | undefined {
  return scope.getStore();
}
