import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { register } from 'tsx/esm/api';
register();
const { startProjectCli } = await import('../extensions/studio-workstation/src/workflow-cli-process.ts');
const { registerWebAppProvider } = await import('../extensions/studio-workstation/src/web-app-providers.ts');
const projectId = '00000000-0000-4000-8000-000000000001';
const entries = [{ entryId: 'main', type: 'kanban', root: '.', name: 'Application', entry: 'dist/steamharness/build/main/index.html', webApp: { service: 'sample.app' } }];
async function fixture(t, supported = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-web-app-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'node_modules/@steamharness/cli'); await mkdir(cli, { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{}');
  await writeFile(path.join(cli, 'package.json'), JSON.stringify({ name: '@steamharness/cli', version: '1.0.0', bin: { steamharness: 'cli.cjs' } }));
  const log = path.join(root, 'messages.jsonl');
  await writeFile(path.join(cli, 'cli.cjs'), String.raw`const fs=require('fs');require('readline').createInterface({input:process.stdin}).on('line',line=>{const value=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\n');if(value.type==='close')process.exit(0);if(value.type==='configure')console.log(JSON.stringify({type:'ready',protocolVersion:1,hostProtocolVersion:1,accountProtocolVersion:1,entriesProtocolVersion:1,webAppProtocolVersion:${supported ? '1' : 'undefined'},url:'http://127.0.0.1:34567/entries/main/#session='+'a'.repeat(64),project:{id:${JSON.stringify(projectId)},entries:${JSON.stringify(entries)},defaultEntry:'main'}}));});`);
  const options = { projectDir: root, dataDir: path.join(root, 'data'), nodePath: process.execPath, theme: 'dark', surface: 'editor', expectedProjectId: projectId, entryId: 'main', webAppEntries: entries, connection: { serverUrl: 'https://first.invalid', accessToken: 'first-host-secret' } };
  const messages = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { options, messages };
}
async function until(check) { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('Expected host transition did not complete'); }

test('an older CLI is rejected before a host provider receives account credentials', async t => {
  const { options } = await fixture(t, false);
  let opened = 0;
  const registration = registerWebAppProvider({ matches: () => true, open: async () => { opened++; throw Error('must not open'); } });
  t.after(() => registration.dispose());
  await assert.rejects(startProjectCli(options), /does not support/); assert.equal(opened, 0);
});

test('switching account disposes late sessions, forwards only the current scope and clears on exit', async t => {
  const { options, messages } = await fixture(t);
  const pending = [], disposed = [];
  const registration = registerWebAppProvider({ matches: () => true, open: input => new Promise(resolve => pending.push({ input, resolve })) });
  t.after(() => registration.dispose());
  const session = await startProjectCli(options); t.after(() => session.close());
  await until(() => pending.length === 1);
  session.updateAuth({ serverUrl: 'https://second.invalid', accessToken: 'second-host-secret' });
  await until(() => pending.length === 2); assert.equal(pending[0].input.signal.aborted, true);
  const scope = name => ({ binding: { service: 'sample.app', apiBaseUrl: 'https://im.invalid/api', bootstrap: { token: name } }, dispose: () => { disposed.push(name); } });
  pending[0].resolve(scope('old-scope')); pending[1].resolve(scope('new-scope'));
  await until(async () => (await messages()).some(item => item.type === 'web-apps'));
  const bindings = (await messages()).filter(item => item.type === 'web-apps');
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].webApps.main.bootstrap.token, 'new-scope');
  assert.ok(!JSON.stringify(bindings).includes('host-secret')); assert.deepEqual(disposed, ['old-scope']);
  await session.close(); assert.deepEqual(disposed, ['old-scope', 'new-scope']);
});

test('authorization failure is reported and retry opens a fresh scoped session', async t => {
  const { options, messages } = await fixture(t);
  let finish, opened = 0;
  const registration = registerWebAppProvider({ matches: () => true, open: () => { opened++; return new Promise((resolve, reject) => { finish = { resolve, reject }; }); } });
  t.after(() => registration.dispose());
  const session = await startProjectCli(options); t.after(() => session.close());
  let errors = 0; session.onWebAppError(() => { errors++; });
  await until(() => finish); finish.reject(Error('private-provider-detail'));
  await until(() => errors === 1);
  const retry = session.retryWebApps(); await until(() => opened === 2);
  finish.resolve({ binding: { service: 'sample.app', apiBaseUrl: 'https://im.invalid/api', bootstrap: {} }, dispose() {} });
  await retry; await until(async () => (await messages()).some(item => item.type === 'web-apps'));
});
