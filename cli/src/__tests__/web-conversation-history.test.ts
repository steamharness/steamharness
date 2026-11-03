import { afterEach, expect, it, vi } from 'vitest';
import { createMemoryRuntimePersistence, type RuntimePersistence } from 'steamharness/runtime-storage';
import { ConversationHistory, decodeSession, encodeSession } from '../web/conversation-history';
import { ConversationOwnership } from '../web/conversation-ownership';
import type { ConversationSession } from '../web/workflow-types';
const owners: ConversationOwnership[] = [];
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.close())); });
async function fixture() {
  const persistence = createMemoryRuntimePersistence();
  const sessions: ConversationSession[] = ['left', 'right'].map(id => ({ id, title: id, messages: [{ id, role: 'assistant', content: id, events: [{ type: 'chunk', value: id }] }] }));
  for (const session of sessions) { const lease = await persistence.acquire(session.id); await lease.write(encodeSession(session, 0)); await lease.close(); }
  const create = async (id: string, backend: RuntimePersistence = persistence) => {
    const ownership = new ConversationOwnership(() => backend); owners.push(ownership);
    const history = new ConversationHistory(() => backend, ownership), local = await history.read();
    await ownership.assertWritable(id, id); ownership.select(id, id);
    await history.refresh(ownership.takeAcquired()); return { ownership, history, sessions: local.sessions! };
  };
  return { persistence, create, read: async () => (await persistence.list('conversation')).map(decodeSession) };
}
it('merges independent writers and preserves ordered messages, trace and queue rows', async () => {
  const f = await fixture(), a = await f.create('left'), b = await f.create('right');
  a.sessions[0].title = 'A'; b.sessions[1].title = 'B';
  a.sessions[0].queuedInputs = [{ id: 'queued', text: 'next', params: {}, attachments: [], createdAt: 1 }];
  await Promise.all([a.history.save(a.sessions, 'left'), b.history.save(b.sessions, 'right')]);
  expect(await f.read()).toMatchObject([{ title: 'A', queuedInputs: [{ id: 'queued' }], messages: [{ events: [{ value: 'left' }] }] }, { title: 'B' }]);
  expect((await a.history.refresh())!.sessions![1].title).toBe('B');
  expect(await a.history.refresh()).toBeUndefined();
});
it('captures only owned sessions synchronously and strips model secrets before transport', async () => {
  const f = await fixture(), a = await f.create('left');
  Object.defineProperty(a.sessions[1].messages[0], 'content', { get() { throw new Error('foreign history serialized'); } });
  a.sessions[0].title = 'captured';
  a.sessions[0].agentParameters = { args: [], policies: {}, userSettings: { agent: { permissionPolicy: 'auto', models: [{ id: 'user', name: 'User', model: 'actual', source: 'third-party', baseUrl: 'https://example.test/v1', apiKind: 'openai-responses', apiKey: 'secret' }] } } };
  const save = a.history.save(a.sessions, 'left'); a.sessions[0].title = 'next'; await save;
  expect((await f.read())[0].title).toBe('captured'); expect(JSON.stringify(await f.read())).not.toContain('secret');
  expect(a.sessions[0].agentParameters.userSettings!.agent.models![0]).toHaveProperty('apiKey', 'secret');
});
it('deletes owned roots and children without resurrecting them from another window', async () => {
  const f = await fixture(), a = await f.create('left'), b = await f.create('right');
  a.sessions.push({ id: 'child', agentOwnerId: 'left', title: 'child', messages: [] });
  await a.history.save(a.sessions, 'left');
  await a.history.save(a.sessions.filter(session => session.id === 'right'), 'right');
  b.sessions[1].title = 'continues'; await b.history.save(b.sessions, 'right');
  expect((await f.read()).map(session => session.id)).toEqual(['right']);
});
it('keeps the committed revision after transport failure and retries the same captured state', async () => {
  const f = await fixture();
  let failed = false;
  const backend = { ...f.persistence, acquire: async (scope: string) => {
    const lease = await f.persistence.acquire(scope);
    return { ...lease, write: async (...args: Parameters<typeof lease.write>) => {
      if (!failed) { failed = true; throw new Error('unavailable'); }
      return lease.write(...args);
    } };
  } };
  const a = await f.create('left', backend); a.sessions[0].title = 'retry';
  await expect(a.history.save(a.sessions, 'left')).rejects.toThrow('unavailable');
  expect((await f.read())[0].title).toBe('left');
  await a.history.save(a.sessions, 'left'); expect((await f.read())[0].title).toBe('retry');
});
it('skips unchanged writes and refreshes after an execution owner transfers', async () => {
  const f = await fixture(), a = await f.create('left');
  const before = (await f.persistence.list('conversation'))[0].revision;
  await a.history.save(a.sessions, 'left'); expect((await f.persistence.list('conversation'))[0].revision).toBe(before);
  await a.ownership.close(); const b = await f.create('left'); b.sessions[0].title = 'new owner'; await b.history.save(b.sessions, 'left');
  expect((await a.history.refresh())!.sessions![0].title).toBe('new owner');
});
