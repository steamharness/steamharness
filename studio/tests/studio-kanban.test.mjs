import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { register } from 'tsx/esm/api';
register();
const { readStudioKanbanDiagnostics } = await import('../extensions/studio-workstation/src/studio-kanban.ts');

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'studio-kanban-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = { projectDir: directory, projectId: 'project', entryId: 'map-2d' };
  const session = { ready: { url: 'http://127.0.0.1:43123/entries/agent/#session=private-capability',
    project: { id: 'project', entries: [{ entryId: 'map-2d', type: 'kanban' }, { entryId: 'agent', type: 'conversation' }] } } };
  const sessions = new Map([[session, directory]]);
  return { directory, input, session, sessions, signal: new AbortController().signal };
}

test('queries the registered aggregate entry with host credentials and returns only runtime evidence', async t => {
  const f = await fixture(t), call = { instanceId: 'page', configurationId: 'config', method: 'map.getInfo', args: {} };
  let requests = 0;
  const value = { available: true, projectId: 'project', entryId: 'map-2d', result: { imageReady: false } };
  const result = await readStudioKanbanDiagnostics(f.sessions, { ...f.input, call }, f.signal, async (url, options) => {
    requests++;
    assert.equal(String(url), 'http://127.0.0.1:43123/entries/map-2d/api/message');
    assert.equal(options.headers.Authorization, 'Bearer private-capability');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { type: 'kanban-diagnostics', applicationId: 'project:map-2d', call });
    return Response.json({ messages: [{ type: 'kanban-diagnostics-result', value }] });
  });
  assert.equal(requests, 1); assert.deepEqual(result, value);
  assert.doesNotMatch(JSON.stringify(result), /capability|43123/);
});

test('never starts a host or reads another project, directory or non-Kanban entry', async t => {
  const f = await fixture(t);
  for (const input of [{ ...f.input, projectId: 'other' }, { ...f.input, projectDir: f.directory + '-other' }, { ...f.input, entryId: 'agent' }]) {
    const value = await readStudioKanbanDiagnostics(f.sessions, input, f.signal, () => assert.fail('No matching host'));
    assert.equal(value.available, false); assert.equal(value.reason, 'preview-not-open');
  }
});

test('rejects ambiguous hosts, non-loopback URLs, expired capability and mismatched responses', async t => {
  const f = await fixture(t), fetch = () => assert.fail('Invalid hosts must not be fetched');
  await assert.rejects(readStudioKanbanDiagnostics(new Map([...f.sessions, [{ ...f.session }, f.directory]]), f.input, f.signal, fetch), /Multiple/);
  for (const url of ['https://remote.test/#session=secret', 'http://127.0.0.1:1234/', 'http://user:password@127.0.0.1:1234/#session=secret']) {
    f.session.ready.url = url;
    await assert.rejects(readStudioKanbanDiagnostics(f.sessions, f.input, f.signal, fetch), /local Kanban|session capability/i);
  }
  f.session.ready.url = 'http://127.0.0.1:1234/#session=secret';
  await assert.rejects(readStudioKanbanDiagnostics(f.sessions, f.input, f.signal, async () => Response.json({ messages: [{ type: 'kanban-diagnostics-result', value: { projectId: 'other', entryId: 'map-2d' } }] })), /Update/);
  await assert.rejects(readStudioKanbanDiagnostics(f.sessions, f.input, f.signal, async () => Response.json({ message: 'private upstream detail' }, { status: 400 })), error => !error.message.includes('private'));
  for (const status of [200, 500]) await assert.rejects(readStudioKanbanDiagnostics(f.sessions, f.input, f.signal,
    async () => new Response('private upstream detail', { status })), error => !error.message.includes('private'));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(readStudioKanbanDiagnostics(f.sessions, f.input, abort.signal, fetch), { name: 'AbortError' });
});
