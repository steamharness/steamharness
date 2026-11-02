import { createMemoryRuntimePersistence } from '../runtime-storage/memory';
import { createRuntimeStateStorage } from '../runtime-storage/state';
const stores = new WeakMap<object, ReturnType<typeof createRuntimeStateStorage>>();
export function testConversationStorage(identity: object = {}) {
  let storage = stores.get(identity);
  if (!storage) {
    storage = createRuntimeStateStorage({ projectId: 'test', entryId: 'main', rootDir: '.', conversationId: 'test', runId: 'test', persistence: createMemoryRuntimePersistence() });
    stores.set(identity, storage);
  }
  return storage.conversation;
}

export function testExecutionStorage() {
  return { host: 'local' as const, local: { runtimePersistence: createMemoryRuntimePersistence() } };
}

const agentStores = new Map<string, ReturnType<typeof createMemoryRuntimePersistence>>();
export function testAgentPersistence(key: string) {
  let storage = agentStores.get(key); if (!storage) { storage = createMemoryRuntimePersistence(); agentStores.set(key, storage); }
  return storage;
}
export function testAgentStorage(key: string) { return testAgentPersistence(key).agentStorage('test', 'main'); }
