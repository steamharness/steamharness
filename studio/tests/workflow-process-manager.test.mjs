import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { register } from 'tsx/esm/api';
import { optionalNativeExternals } from '../scripts/node-extension-build.mjs';

register();
const source = fileURLToPath(new URL('../extensions/studio-workstation/src/', import.meta.url));
const { ProjectProcessManager } = await import('../extensions/studio-workstation/src/workflow-process-client.ts');
const { startProjectCli } = await import('../extensions/studio-workstation/src/workflow-cli-process.ts');
const { startStudioControlBridge } = await import('../extensions/studio-workstation/src/studio-control-bridge.ts');

test('a detached project survives a host exit, shares compatible leases, and stops only on retirement', { timeout: 30_000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-process-manager-')));
  const service = path.join(root, 'service.cjs'), client = path.join(root, 'client.cjs');
  const project = path.join(root, 'project'), cli = path.join(project, 'node_modules', '@steamharness', 'cli');
  const data = path.join(root, 'owner-a'), otherData = path.join(root, 'owner-b');
  const manager = new ProjectProcessManager(data, service), other = new ProjectProcessManager(otherData, service);
  const signal = AbortSignal.timeout(25_000), clients = [];
  let window;
  t.after(async () => {
    if (window && window.exitCode === null && window.signalCode === null) { const exited = once(window, 'exit'); window.kill('SIGKILL'); await exited; }
    await Promise.all(clients.map(session => session.close()));
    await Promise.all([manager, other].map(owner => owner.stop(AbortSignal.timeout(10_000))));
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([
    build({ entryPoints: [path.join(source, 'workflow-process-service.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: service }),
    build({ stdin: { resolveDir: source, contents: `export { startProjectCli } from './workflow-cli-process'; export { ProjectProcessManager } from './workflow-process-client';` },
      bundle: true, platform: 'node', external: optionalNativeExternals, format: 'cjs', outfile: client }),
    mkdir(cli, { recursive: true }),
  ]);
  await writeFile(path.join(cli, 'package.json'), JSON.stringify({ name: '@steamharness/cli', version: '1.0.0', bin: './fixture.cjs' }));
  const id = 'f31ce55e-efd1-4d89-8b7a-bab252c0338d', entries = [{ entryId: 'main' }, { entryId: 'other' }];
  const completed = path.join(root, 'finished.txt'), gate = path.join(root, 'release.txt');
  await writeFile(path.join(cli, 'fixture.cjs'), `const { createServer } = require('node:http'), { existsSync, appendFileSync } = require('node:fs');
    let auth, work, status = 'idle';
    const server = createServer(async (req, res) => {
      if (req.url === '/start' && status === 'idle') {
        status = 'running';
        work = setInterval(() => {
          if (!existsSync(${JSON.stringify(gate)})) return;
          clearInterval(work); status = 'done'; appendFileSync(${JSON.stringify(completed)}, process.pid + '\\n');
        }, 50);
      }
      if (req.url === '/control') {
        const reply = await fetch(process.env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_URL, { method: 'POST', headers: {
          Authorization: 'Bearer ' + process.env.STEAMHARNESS_STUDIO_CONTROL_BRIDGE_TOKEN, 'Content-Type': 'application/json'
        }, body: JSON.stringify({ operation: 'test', input: {} }) });
        return res.end(await reply.text());
      }
      res.end(JSON.stringify({ pid: process.pid, status, auth }));
    });
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.once('line', () => server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ type: 'ready', protocolVersion: 1,
      hostProtocolVersion: 1, localStorageVersion: 2, accountProtocolVersion: 1, entriesProtocolVersion: 1, url: 'http://127.0.0.1:' + server.address().port
      + '/entries/main/#session=' + 'a'.repeat(64), project: { id: ${JSON.stringify(id)}, entries: ${JSON.stringify(entries)} } }))));
    lines.on('line', line => { const msg = JSON.parse(line); if (msg.type === 'auth') auth = msg.connection?.accessToken;
      if (msg.type === 'close') { clearInterval(work); server.close(); lines.close(); process.stdin.pause(); } });`);
  const options = { projectDir: project, dataDir: data, nodePath: process.execPath, theme: 'dark', surface: 'editor', expectedProjectId: id, entryId: 'main' };
  const managed = { key: 'project/editor', sources: [project], release: false, entries };
  const request = async (url, route = '/') => (await fetch(new URL(route, url), { signal })).json();
  const until = async read => { for (;;) { signal.throwIfAborted(); const value = await read(); if (value) return value; await delay(50, undefined, { signal }); } };
  // A separate process stands in for the native UI's Node extension host. Its
  // socket (including stdio to the test) disappears on a real abrupt exit.
  window = spawn(process.execPath, ['-e', `const { startProjectCli, ProjectProcessManager } = require(${JSON.stringify(client)});
    startProjectCli({ ...${JSON.stringify(options)}, managed: { ...${JSON.stringify(managed)}, manager: new ProjectProcessManager(${JSON.stringify(data)}, ${JSON.stringify(service)}) } })
      .then(session => process.send(session.ready.url)).catch(error => { console.error(error); process.exitCode = 1; });`],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const [url] = await once(window, 'message', { signal });
  const connect = async (manager, entryId = 'main', studioControl) => {
    const session = await startProjectCli({ ...options, entryId, studioControl, dataDir: manager === other ? otherData : data, signal,
      managed: { ...managed, key: studioControl ? 'project/control' : managed.key, manager } });
    clients.push(session); return session;
  };
  const attached = await connect(manager, 'other');
  assert.equal(new URL(attached.ready.url).pathname, '/entries/other/');
  const original = await request(attached.ready.url, '/start');
  assert.equal(original.pid, (await request(url)).pid);
  attached.updateAuth({ serverUrl: 'https://test.invalid', accessToken: 'first-host' });
  await until(async () => (await request(url)).auth === 'first-host');
  await attached.close();
  const exited = once(window, 'exit', { signal }); window.kill('SIGKILL'); await exited;
  const resumed = await connect(manager);
  assert.deepEqual(await request(resumed.ready.url), { pid: original.pid, status: 'running', auth: 'first-host' });
  resumed.updateAuth({ serverUrl: 'https://test.invalid', accessToken: 'same-account-new-session' });
  await resumed.close();
  await writeFile(gate, 'go');
  assert.equal(await until(() => readFile(completed, 'utf8').catch(() => '')), `${original.pid}\n`);
  const isolated = await connect(other);
  assert.notEqual((await request(isolated.ready.url)).pid, original.pid);
  assert.equal((await request(isolated.ready.url)).auth, undefined);
  const retained = await connect(manager);
  assert.equal((await request(retained.ready.url)).status, 'done');
  const hold = await manager.hold(project, signal);
  try {
    await retained.retired;
    await retained.closed;
    await assert.rejects(connect(manager), /being upgraded/);
    assert.equal((await request(isolated.ready.url)).status, 'idle');
  } finally { hold.dispose(); }

  // UI-only calls get a new host handler on attach without changing the CLI.
  const bridge = await startStudioControlBridge(async () => 'first window', signal);
  const first = await connect(manager, 'main', bridge);
  assert.deepEqual(await request(first.ready.url, '/control'), { ok: true, value: 'first window' });
  await first.close(); await bridge.close();
  const unavailable = await request(first.ready.url, '/control');
  assert.equal(unavailable.error?.code, 'STUDIO_CONTROL_UNAVAILABLE');
  const secondBridge = await startStudioControlBridge(async () => 'reopened window', signal);
  const second = await connect(manager, 'main', secondBridge);
  assert.equal(new URL(first.ready.url).origin, new URL(second.ready.url).origin);
  assert.deepEqual(await request(second.ready.url, '/control'), { ok: true, value: 'reopened window' });
  await manager.stop(signal); await second.closed; await secondBridge.close();
  assert.equal((await request(isolated.ready.url)).status, 'idle');
});
