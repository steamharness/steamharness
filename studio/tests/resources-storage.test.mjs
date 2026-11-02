import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runDatabaseHostRequest } from '../extensions/studio-workstation/runtime/database-host.mjs';

async function fixture(t) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname.endsWith('/bindings')) res.end(JSON.stringify({ errCode: 0, data: [{ alias: 'data', databaseId: 'resource' }] }));
    else res.end(JSON.stringify({ errCode: 0, data: { items: [{ id: `${url.pathname}:${url.searchParams.get('page')}`, name: 'Resource' }], total: url.pathname.endsWith('/databases') ? 101 : 1 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { requests, connection: { serverUrl: `http://127.0.0.1:${server.address().port}`, accessToken: 'fixture-token' } };
}
test('resource host reads paginated relational and knowledge catalogs using the selected account', async t => {
  const f = await fixture(t), result = await runDatabaseHostRequest({ connection: f.connection, input: { action: 'catalog' } });
  assert.deepEqual(result.resources.map(resource => resource.kind), ['databases', 'databases', 'knowledge-bases']);
  assert.equal(f.requests.length, 3); assert.ok(f.requests.every(request => request.authorization === 'Bearer fixture-token'));
  assert.equal(JSON.stringify(result).includes('fixture-token'), false);
});
test('resource host resolves only a valid project and entry and rejects removed local KV operations', async t => {
  const f = await fixture(t);
  assert.deepEqual((await runDatabaseHostRequest({ connection: f.connection, input: { action: 'bindings', projectId: '294b1eec-23fa-42cf-9fd3-2417f71c0570', entryId: 'main' } })).bindings, [{ alias: 'data', databaseId: 'resource' }]);
  for (const input of [{ action: 'bindings', projectId: '../other', entryId: 'main' }, { action: 'bindings', projectId: '294b1eec-23fa-42cf-9fd3-2417f71c0570', entryId: '../other' }, { action: 'resource', kind: 'kv' }]) await assert.rejects(runDatabaseHostRequest({ connection: f.connection, input }));
  assert.equal(f.requests.length, 1);
  await assert.rejects(runDatabaseHostRequest({ input: { action: 'catalog' } }), /Sign in/);
  await assert.rejects(runDatabaseHostRequest({ connection: { ...f.connection, serverUrl: 'https://user:password@server.test' }, input: { action: 'catalog' } }), /Invalid Server/);
});
test('bundled management worker works through a managed extension symlink without a local registry', async t => {
  const f = await fixture(t), root = await mkdtemp(path.join(os.tmpdir(), 'studio-resource-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extension = path.join(root, 'extension'); await mkdir(extension);
  const worker = path.join(extension, 'resources-worker.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../extensions/studio-workstation/runtime/resources-worker.mjs', import.meta.url))], outfile: worker, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent' });
  const managed = path.join(root, 'managed'); await symlink(extension, managed, process.platform === 'win32' ? 'junction' : 'dir');
  const child = spawn(process.execPath, [path.join(managed, 'resources-worker.mjs')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const exited = once(child, 'close'); child.stdin.end(JSON.stringify({ connection: f.connection, input: { action: 'catalog' } }));
  assert.equal((await exited)[0], 0, stderr); assert.equal(JSON.parse(stdout).value.resources.length, 3); assert.equal(stdout.includes('fixture-token'), false);
});
