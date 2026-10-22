import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationHistory } from '../web/conversation-history';
import { ConversationOwnership } from '../web/conversation-ownership';
import type { ConversationSession } from '../web/workflow-types';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
const directories: string[] = [], owners: ConversationOwnership[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); for (const owner of owners.splice(0)) owner.close();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'conversation-history-')); directories.push(directory);
  const filename = path.join(directory, 'conversations.json');
  const sessions: ConversationSession[] = ['left', 'right'].map(id => ({ id, title: id, messages: [{ role: 'assistant', content: id,
    events: [{ type: 'node_chunk', chunk: { type: 'text_delta', delta: 'original trace' } }] }], parameterValues: {} }));
  const saved = { sessions, activeId: 'left', selectionVersion: 1 };
  await fs.writeFile(filename, JSON.stringify(saved));
  const create = async (id: string) => {
    const ownership = new ConversationOwnership(path.join(directory, 'owners')); owners.push(ownership);
    const local = structuredClone(saved), history = new ConversationHistory(filename, local, ownership);
    ownership.select(id, id); await history.refresh(ownership.takeAcquired());
    return { local, ownership, history };
  };
  return { filename, create, read: async () => JSON.parse(await fs.readFile(filename, 'utf8')) };
}

it('captures writable data before awaiting disk and leaves foreign histories unvisited', async () => {
  const f = await fixture(), left = await f.create('left');
  const foreign = left.local.sessions[1];
  Object.defineProperty(foreign.messages[0], 'content', { get: () => { throw new Error('Unrelated transcript was serialized'); } });
  left.local.sessions[0].messages[0].content = 'captured';
  const pending = left.history.save(left.local.sessions, 'left');
  left.local.sessions[0].messages[0].content = 'next frame';
  await pending;
  const saved = await f.read();
  expect(saved.sessions[0].messages[0].content).toBe('captured');
  expect(saved.sessions[0].messages[0].events[0].chunk.delta).toBe('original trace');
  expect(saved.sessions[1].messages[0].content).toBe('right');
  expect(await left.history.refresh()).toBeUndefined();
});

it('does not reread or replace an unchanged file, including the poll after its own writes', async () => {
  const f = await fixture(), left = await f.create('left');
  left.local.sessions[0].title = 'changed'; await left.history.save(left.local.sessions, 'left');
  const before = await fs.stat(f.filename), opens = vi.mocked(fs.open).mockClear();
  for (let index = 0; index < 3; index++) {
    await left.history.save(left.local.sessions, 'left'); expect(await left.history.refresh()).toBeUndefined();
  }
  expect(opens).not.toHaveBeenCalled();
  const after = await fs.stat(f.filename); expect(after.ino).toBe(before.ino); expect(after.mtimeMs).toBe(before.mtimeMs);
  await left.history.save(left.local.sessions, 'right'); expect((await f.read()).activeId).toBe('right');
});

it('delivers foreign updates merged during a save and forces fresh data when ownership transfers', async () => {
  const f = await fixture(), left = await f.create('left'), right = await f.create('right');
  right.local.sessions[1].messages[0].content = 'other window';
  await right.history.save(right.local.sessions, 'right');
  left.local.sessions[0].title = 'local change'; await left.history.save(left.local.sessions, 'left');
  const refreshed = await left.history.refresh();
  expect(refreshed!.sessions![1].messages[0].content).toBe('other window');
  expect((await f.read()).sessions[0].title).toBe('local change');
  expect(await left.history.refresh()).toBeUndefined();
  right.ownership.close(); left.ownership.select('left', 'right');
  const acquired = await left.history.refresh(left.ownership.takeAcquired());
  expect(acquired!.sessions![1].messages[0].content).toBe('other window');
});

it('serializes concurrent saves, merges scoped forks and deletes only owned sessions', async () => {
  const f = await fixture(), left = await f.create('left'), right = await f.create('right');
  left.local.sessions.push({ id: 'fork', agentOwnerId: 'left', title: 'fork', messages: [], parameterValues: {} });
  left.local.sessions[0].title = 'left update'; right.local.sessions[1].title = 'right update';
  await Promise.all([left.history.save(left.local.sessions, 'fork'), right.history.save(right.local.sessions, 'right')]);
  expect((await f.read()).sessions.map((s: ConversationSession) => s.title)).toEqual(['left update', 'right update', 'fork']);
  await left.history.save(left.local.sessions.slice(0, 1), 'left');
  expect((await f.read()).sessions.map((s: ConversationSession) => s.id)).toEqual(['left', 'right']);
});

it('keeps the last committed cache after a failed write and allows the next save to retry', async () => {
  const f = await fixture(), left = await f.create('left');
  const rename = vi.mocked(fs.rename).mockClear().mockRejectedValueOnce(new Error('Disk unavailable'));
  left.local.sessions[0].title = 'retry me';
  await expect(left.history.save(left.local.sessions, 'left')).rejects.toThrow('Disk unavailable');
  expect((await f.read()).sessions[0].title).toBe('left');
  await left.history.save(left.local.sessions, 'left');
  expect(rename).toHaveBeenCalledTimes(2); expect((await f.read()).sessions[0].title).toBe('retry me');
});

it('invalidates its cache after file replacement or deletion without resurrecting foreign conversations', async () => {
  const f = await fixture(), left = await f.create('left');
  const replacement = await f.read(); replacement.sessions[1].title = 'external';
  const temporary = `${f.filename}.external`;
  await fs.writeFile(temporary, JSON.stringify(replacement));
  const previous = await fs.stat(f.filename); await fs.utimes(temporary, previous.atime, previous.mtime);
  await fs.rename(temporary, f.filename);
  expect((await left.history.refresh())!.sessions![1].title).toBe('external');
  await fs.unlink(f.filename); await left.history.save(left.local.sessions, 'left');
  expect((await f.read()).sessions.map((session: ConversationSession) => session.id)).toEqual(['left']);
});
