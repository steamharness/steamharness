import { createMemoryRuntimePersistence } from 'steamharness/runtime-storage';
import { startWebServer as startAggregate, startEntryWebServer as startEntry, type WebOptions } from '../web/server';
import { decodeSession, encodeSession } from '../web/conversation-history';
import type { ConversationSession } from '../web/workflow-types';
const repositories = new Map<string, ReturnType<typeof createMemoryRuntimePersistence>>();
export function temporaryRuntimePersistence(directory: string, entryId = "main") {
  directory += `:${entryId}`;
  let storage = repositories.get(directory); if (!storage) { storage = createMemoryRuntimePersistence(); repositories.set(directory, storage); } return storage;
}
export const startWebServer = (options: WebOptions) => startAggregate({ ...options, runtimePersistence: options.runtimePersistence ?? temporaryRuntimePersistence(options.dataDir ?? options.projectDir, options.entryId), runtimePersistenceForEntry: entryId => temporaryRuntimePersistence(options.dataDir ?? options.projectDir, entryId) });
export const startEntryWebServer = (options: WebOptions) => startEntry({ ...options, runtimePersistence: options.runtimePersistence ?? temporaryRuntimePersistence(options.dataDir ?? options.projectDir, options.entryId), runtimePersistenceForEntry: entryId => temporaryRuntimePersistence(options.dataDir ?? options.projectDir, entryId) });
export async function seedTestSessions(directory: string, sessions: ConversationSession[], replace = true) {
  const persistence = temporaryRuntimePersistence(directory);
  for (const record of await persistence.list('conversation')) {
    if (!replace || sessions.some(session => session.id === record.key)) continue;
    const lease = await persistence.acquire(record.scope); try { await lease.delete(record); } finally { await lease.close(); }
  }
  for (const session of sessions) { const lease = await persistence.acquire(session.agentOwnerId ?? session.id); try { await lease.write(encodeSession(session, 0)); } finally { await lease.close(); } }
}
export async function readTestSessions(directory: string) {
  const backend = temporaryRuntimePersistence(directory);
  const selection = (await backend.list('workflow')).find(record => record.key === 'conversation-selection');
  return { sessions: (await backend.list('conversation')).map(decodeSession), activeId: selection?.state.activeId, selectionVersion: 1 };
}

export type { WebOptions } from "../web/server";
