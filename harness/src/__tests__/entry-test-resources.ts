import { randomUUID } from "node:crypto";
import { createEntriesContext } from "../entries/index";

export function createTestResources(_unused?: unknown) {
  const projectId = randomUUID(), entryId = 'test', actor = { userId: 'test', isSystemAdmin: true };
  return { projectId, entryId,
    entries: createEntriesContext({ projectId, name: 'test', defaultEntry: entryId, entries: [{ entryId, name: 'test', type: 'workflow', root: '.', entry: 'index.ts' }] }, { actor, projectId, sourceEntryId: entryId }, { async list() { return []; }, async run() { throw new Error('No nested test entry.'); } }) };
}
