import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationOwnership } from '../web/conversation-ownership';
import { ConversationHistory } from '../web/conversation-history';
import type { ConversationSession } from '../web/workflow-types';

const directories: string[] = [], owners: ConversationOwnership[] = [];
afterEach(async () => { for (const owner of owners.splice(0)) owner.close(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'conversation-ownership-')); directories.push(directory);
  const owner = () => { const value = new ConversationOwnership(path.join(directory, 'owners')); owners.push(value); return value; };
  return { directory, owner };
}

it('admits one writer per conversation, permits independent conversations and transfers an idle view', async () => {
  const f = await fixture(), one = f.owner(), two = f.owner();
  expect(one.select('page-a', 'same')).toEqual({ readOnly: false });
  expect(one.select('page-b', 'same').readOnly).toBe(true);
  expect(two.select('page-c', 'same').readOnly).toBe(true);
  expect(two.select('page-c', 'different').readOnly).toBe(false);
  expect(() => two.assertWritable('same', 'page-c')).toThrow('another window');
  one.select('page-a', 'third');
  expect(two.select('page-c', 'same').readOnly).toBe(false);
});

it('retains the execution owner when its page navigates away', async () => {
  const f = await fixture(), one = f.owner(), two = f.owner();
  one.select('page-a', 'running'); expect(one.execute('running')).toBe(true);
  one.update(new Set(['running']), new Set(['running']));
  one.select('page-a', 'other');
  expect(two.execute('running')).toBe(false);
  one.update(new Set(), new Set());
  expect(two.execute('running')).toBe(true);
});

it('shares one process owner across fork views while keeping each view single-writer', async () => {
  const f = await fixture();
  const scope = (id: string) => id === 'child' ? 'root' : id;
  const one = new ConversationOwnership(path.join(f.directory, 'owners'), scope);
  const two = new ConversationOwnership(path.join(f.directory, 'owners'), scope);
  owners.push(one, two);
  expect(one.select('page-a', 'root').readOnly).toBe(false);
  expect(one.select('page-b', 'child').readOnly).toBe(false);
  expect(one.select('page-c', 'child').readOnly).toBe(true);
  expect(two.select('page-d', 'child').readOnly).toBe(true);
  expect(one.owns('child')).toBe(true);
});

it('releases an open conversation after its owning process is killed', async () => {
  const f = await fixture(), two = f.owner();
  const moduleUrl = new URL('../web/conversation-ownership.ts', import.meta.url).href;
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { ConversationOwnership } from ${JSON.stringify(moduleUrl)}; const owner = new ConversationOwnership(process.argv[1]); owner.select('child', 'same'); process.send({ready:true}); setInterval(()=>{},1000);`,
    path.join(f.directory, 'owners')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Child ownership timed out')), 10_000);
      child.once('message', () => { clearTimeout(timer); resolve(); });
      child.once('error', reject); child.once('exit', code => reject(new Error(`Child exited: ${code}`)));
    });
    expect(two.select('page', 'same').readOnly).toBe(true);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    expect(two.select('page', 'same').readOnly).toBe(false);
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } }
});

it('merges independent saves and never overwrites another window or resurrects a deleted conversation', async () => {
  const f = await fixture(), one = f.owner(), two = f.owner();
  const session = (id: string): ConversationSession => ({ id, title: id, messages: [], draft: { text: '', attachments: [] } });
  const original = { sessions: [session('one'), session('two')], activeId: 'one', selectionVersion: 1 };
  const filename = path.join(f.directory, 'conversations.json'); await writeFile(filename, JSON.stringify(original));
  const a = new ConversationHistory(filename, original, one), b = new ConversationHistory(filename, original, two);
  const left = structuredClone(original.sessions), right = structuredClone(original.sessions);
  one.assertWritable('one', 'page-a'); two.assertWritable('two', 'page-b');
  left[0].draft!.text = 'From A'; right[1].draft!.text = 'From B';
  await Promise.all([a.save(left, 'one'), b.save(right, 'two')]);
  expect(JSON.parse(await readFile(filename, 'utf8')).sessions.map((entry: ConversationSession) => entry.draft?.text)).toEqual(['From A', 'From B']);
  await a.save([left[1]], 'two');
  right[1].draft!.text = 'B continues'; await b.save(right, 'two');
  expect(JSON.parse(await readFile(filename, 'utf8')).sessions).toMatchObject([{ id: 'two', draft: { text: 'B continues' } }]);
});

it('removes a root and its persisted fork views even after the local views are gone', async () => {
  const f = await fixture();
  const sessions: ConversationSession[] = [{ id: 'root', title: 'Root', messages: [] }, { id: 'fork', title: 'Fork', messages: [], agentOwnerId: 'root' }];
  const owner = new ConversationOwnership(path.join(f.directory, 'owners'), id => sessions.find(session => session.id === id)?.agentOwnerId ?? id); owners.push(owner);
  const filename = path.join(f.directory, 'conversations.json');
  const history = new ConversationHistory(filename, {}, owner);
  owner.assertWritable('root', 'page'); await history.save(sessions, 'root');
  sessions.splice(0);
  await history.save(sessions, 'new');
  expect(JSON.parse(await readFile(filename, 'utf8')).sessions).toEqual([]);
});

it.each([false, true])('persists migration to a separate scope before deleting the source (opened=%s)', async opened => {
  const f = await fixture();
  const sessions: ConversationSession[] = [{ id: 'root', title: 'Root', messages: [] },
    { id: 'fork', title: 'Fork', messages: [], agentOwnerId: 'root' }];
  const owner = new ConversationOwnership(path.join(f.directory, 'owners'), id => sessions.find(session => session.id === id)?.agentOwnerId ?? id);
  owners.push(owner); const other = f.owner();
  owner.assertWritable('root', 'root-page');
  if (opened) owner.select('fork-page', 'fork');
  const filename = path.join(f.directory, 'conversations.json'), history = new ConversationHistory(filename, {}, owner);
  await history.save(sessions, 'root');
  delete sessions[1].agentOwnerId;
  const release = owner.independent('fork');
  owner.update(new Set(), new Set());
  expect(owner.scope('fork')).toBe('fork'); expect(owner.owns('fork')).toBe(true);
  expect(other.execute('fork')).toBe(false);
  await history.save(sessions, 'root');
  release();
  expect(owner.owns('fork')).toBe(opened);
  sessions.shift(); await history.save(sessions, 'fork');
  const saved = JSON.parse(await readFile(filename, 'utf8'));
  expect(saved.sessions).toEqual([{ id: 'fork', title: 'Fork', messages: [] }]);
  if (!opened) expect(other.execute('fork')).toBe(true);
  else expect(() => owner.assertWritable('fork', 'other-page')).toThrow('another window');
});
