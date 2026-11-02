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
