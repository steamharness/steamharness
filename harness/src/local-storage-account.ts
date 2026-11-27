import { AsyncLocalStorage } from 'node:async_hooks';
import { localAccountDirectory, localRuntimeAccountDirectory } from '@steamharness/project-manifest/node';
import { currentPlatformConnections, resolveLocalStorageAccountKey, type PlatformConnection } from './platform-connections';

const accounts = new AsyncLocalStorage<{ project?: PlatformConnection; directory: string }>();

/** Synchronous storage factories inherit the account pinned before project code was loaded. */
export function executionAccountDirectory(): string {
  return accounts.getStore()?.directory ?? localRuntimeAccountDirectory();
}

export async function resolveExecutionAccountDirectory(hostAccount?: string): Promise<string> {
  const project = currentPlatformConnections()?.project;
  const pinned = accounts.getStore();
  if (pinned && pinned.project === project) return pinned.directory;
  if (hostAccount !== undefined) return localAccountDirectory(hostAccount);
  return project ? localAccountDirectory(await resolveLocalStorageAccountKey(project)) : localRuntimeAccountDirectory();
}

export async function withExecutionAccount<T>(run: () => Promise<T>, hostAccount?: string): Promise<T> {
  const project = currentPlatformConnections()?.project;
  const directory = await resolveExecutionAccountDirectory(hostAccount);
  return accounts.run({ project, directory }, run);
}
