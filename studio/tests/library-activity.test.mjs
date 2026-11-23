import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { readRunningLibraryProjects } from '../extensions/studio-workstation/src/library-activity.ts';

async function fixture(t) {
  const storage = await mkdtemp(path.join(tmpdir(), 'studio-activity-leases-'));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const now = Date.now(), projectId = randomUUID();
  const uri = name => pathToFileURL(path.join(storage, name)).href;
  const lease = async (scope = '', entryId = 'main', id = projectId) => {
    const directory = path.join(storage, scope, 'projects', id, 'entries', entryId, 'activity');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${randomUUID()}.json`);
    return (runs, overrides) => writeFile(file, JSON.stringify({ version: 1, projectId: id, entryId, pid: process.pid, updatedAt: now, runs, ...overrides }));
  };
  return { now, projectId, uri, lease, read: projects => readRunningLibraryProjects(storage, projects, now) };
}

test('the launcher sees runs from any entry and clears them independently on completion', async t => {
  const f = await fixture(t);
  const project = { projectId: f.projectId, uri: f.uri('source'), distribution: 'source' };
  const writeA = await f.lease('', 'main'), writeB = await f.lease('', 'child'), writeOtherWindow = await f.lease('', 'child');
  const running = (id, status = 'running', time = f.now - 100) => ({ id, status, changedAt: time });
  await writeA([]); await writeB([]);
  assert.deepEqual(await f.read([project]), []);
  await writeA([running('a')]); await writeB([running('b')]);
  assert.deepEqual(await f.read([project]), [project.uri]);
  await writeA([running('a', 'success')]);
  assert.deepEqual(await f.read([project]), [project.uri]);
  await writeOtherWindow([running('b', 'waiting_for_input', f.now - 10), { id: 'history', status: 'running' }]);
  assert.deepEqual(await f.read([project]), [], 'a newer approval wait supersedes an old running snapshot');
});

test('activity is isolated by release and managed Bot instance, and cannot come from dead or stale leases', async t => {
  const f = await fixture(t);
  const instance = randomUUID(), other = randomUUID();
  const instanceUri = f.uri(`${instance}.code-workspace`);
  const source = { projectId: f.projectId, uri: f.uri('template'), distribution: 'source' };
  const release = { ...source, uri: f.uri('installed'), distribution: 'release' };
  const managed = { uri: instanceUri, managed: true };
  const candidates = [source, release, managed, { uri: f.uri(`${other}.code-workspace`), projectId: f.projectId, managed: true },
    { uri: 'file:///broken%name.code-workspace', managed: true }, { uri: f.uri('bad'), projectId: '../../release' },
    { uri: 'vscode-remote://dev/bot', projectId: f.projectId }];
  const runs = [{ id: 'running', status: 'running', changedAt: f.now - 100 }];
  await (await f.lease())(runs, { updatedAt: f.now - 20_001 });
  await (await f.lease())(runs, { pid: 0x7fff_ffff });
  await (await f.lease())(runs, { projectId: randomUUID() });
  await (await f.lease('release'))(runs);
  const writeFolderBot = await f.lease(path.join('folder-bots', instance));
  await writeFolderBot(runs);
  assert.deepEqual(await f.read(candidates), [release.uri, instanceUri]);
  await writeFolderBot([{ ...runs[0], status: 'aborted' }]);
  assert.deepEqual(await f.read(candidates), [release.uri]);
});
