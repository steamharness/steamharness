import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { register } from 'tsx/esm/api';
register();
const { startProjectCli } = await import('../extensions/studio-workstation/src/workflow-cli-process.ts');
const { registerWebAppProvider } = await import('../extensions/studio-workstation/src/web-app-providers.ts');
const { WebAppConnectionError } = await import('../extensions/studio-workstation/src/web-app-errors.ts');
const projectId = '00000000-0000-4000-8000-000000000001';
const entries = [{ entryId: 'main', type: 'kanban', root: '.', name: 'Application', entry: 'dist/steamharness/build/main/index.html', webApp: { service: 'sample.app' } }];
async function fixture(t, supported = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-web-app-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'node_modules/@steamharness/cli'); await mkdir(cli, { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{}');
  await writeFile(path.join(cli, 'package.json'), JSON.stringify({ name: '@steamharness/cli', version: '1.0.0', bin: { steamharness: 'cli.cjs' } }));
  const log = path.join(root, 'messages.jsonl');
  await writeFile(path.join(cli, 'cli.cjs'), String.raw`const fs=require('fs');let currentConfiguration={id:'local',name:'Local',params:{api:'https://local.invalid/api'}};require('readline').createInterface({input:process.stdin}).on('line',line=>{const value=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\n');if(value.type==='close')process.exit(0);if(value.type==='user-settings'&&value.userSettings.testLogin)console.log(JSON.stringify({type:'web-app-login',entryId:value.userSettings.testLogin,configuration:value.userSettings.staleConfiguration??currentConfiguration}));if(value.type==='user-settings'&&value.userSettings.testConfiguration){currentConfiguration=value.userSettings.testConfiguration;console.log(JSON.stringify({type:'web-app-configuration',entryId:'main',configuration:currentConfiguration}));}if(value.type==='configure')console.log(JSON.stringify({type:'ready',protocolVersion:1,hostProtocolVersion:1,accountProtocolVersion:1,entriesProtocolVersion:1,webAppProtocolVersion:${supported ? '1' : 'undefined'},userSettingsProtocolVersion:1,webAppConfigurationProtocolVersion:1,webAppLoginProtocolVersion:1,webAppConfigurations:{main:{id:'local',name:'Local',params:{api:'https://local.invalid/api'}}},url:'http://127.0.0.1:34567/entries/main/#session='+'a'.repeat(64),project:{id:${JSON.stringify(projectId)},entries:${JSON.stringify(entries)},defaultEntry:'main'}}));});`);
  const options = { projectDir: root, dataDir: path.join(root, 'data'), nodePath: process.execPath, theme: 'dark', surface: 'editor', platform: true, expectedProjectId: projectId, entryId: 'main', webAppEntries: entries };
  const messages = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { options, messages };
}
async function until(check) { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('Expected host transition did not complete'); }
const first = { serverUrl: 'https://first.invalid', accessToken: 'first-host-secret' };
const second = { serverUrl: 'https://second.invalid', accessToken: 'second-host-secret' };

test('an older CLI starts offline, but cannot send credentials to a hosted provider', async t => {
  const { options } = await fixture(t, false);
  let opened = 0;
  const registration = registerWebAppProvider({ matches: () => true, open: async () => { opened++; throw Error('must not open'); } });
  t.after(() => registration.dispose());
  const session = await startProjectCli(options); t.after(() => session.close());
  assert.throws(() => session.connectWebApp('main', first), /Update the project CLI/);
  assert.equal(opened, 0);
});

test('switching account disposes late sessions, forwards only the current scope and clears on exit', async t => {
  const { options, messages } = await fixture(t);
  const pending = [], disposed = [];
  const registration = registerWebAppProvider({ matches: () => true, open: input => new Promise(resolve => pending.push({ input, resolve })) });
  t.after(() => registration.dispose());
  const session = await startProjectCli(options); t.after(() => session.close());
  session.updateAuth(first);
  await until(async () => (await messages()).some(item => item.type === 'auth'));
  assert.equal(pending.length, 0, 'Starting the project or connecting its project credential does not open H5');
  const oldOpen = session.connectWebApp('main', first);
  await until(() => pending.length === 1);
  await session.connectWebApp();
  assert.equal(pending[0].input.signal.aborted, true);
  const newOpen = session.connectWebApp('main', second);
  await until(() => pending.length === 2); assert.equal(pending[0].input.signal.aborted, true);
  const scope = name => ({ binding: { service: 'sample.app', apiBaseUrl: 'https://im.invalid/api', bootstrap: { token: name } }, dispose: () => { disposed.push(name); } });
  pending[0].resolve(scope('old-scope')); pending[1].resolve(scope('new-scope'));
  await Promise.all([oldOpen, newOpen]);
  await until(async () => (await messages()).some(item => item.webApps?.main));
  const bindings = (await messages()).filter(item => item.webApps?.main);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].webApps.main.bootstrap.token, 'new-scope');
  assert.ok(!JSON.stringify(bindings).includes('host-secret')); assert.deepEqual(disposed, ['old-scope']);
  await session.close(); assert.deepEqual(disposed, ['old-scope', 'new-scope']);
});

test('configuration changes clear the old binding and ignore late environment sessions', async t => {
  const { options, messages } = await fixture(t);
  const pending = [], disposed = [];
  const registration = registerWebAppProvider({ matches: () => true, open: input => new Promise(resolve => pending.push({ input, resolve })) });
  t.after(() => registration.dispose());
  const session = await startProjectCli(options); t.after(() => session.close());
  const opening = session.connectWebApp('main', first);
  await until(() => pending.length === 1);
  assert.equal(pending[0].input.configuration.id, 'local');
  const scope = name => ({ binding: { service: 'sample.app', apiBaseUrl: 'https://im.invalid/api', bootstrap: { token: name } }, dispose: () => disposed.push(name) });
  pending[0].resolve(scope('local'));
  await opening;
  await until(async () => (await messages()).some(item => item.webApps?.main?.bootstrap.token === 'local'));
  session.updateUserSettings({ agent: {}, testConfiguration: { id: 'online', name: 'Online', params: { api: 'https://online.invalid/api' } } });
  await until(() => pending.length === 2);
  assert.deepEqual(disposed, ['local']);
  assert.equal(pending[1].input.configuration.params.api, 'https://online.invalid/api');
  const current = (await messages()).filter(item => item.type === 'web-apps').at(-1);
  assert.deepEqual(current.webApps, {});
  session.updateUserSettings({ agent: {}, testConfiguration: { id: 'local', name: 'Local', params: { api: 'https://local.invalid/api' } } });
  await until(() => pending.length === 3);
  assert.equal(pending[1].input.signal.aborted, true);
  pending[1].resolve(scope('late-online')); pending[2].resolve(scope('new-local'));
  await until(async () => (await messages()).some(item => item.webApps?.main?.bootstrap.token === 'new-local'));
  assert.equal((await messages()).some(item => item.webApps?.main?.bootstrap.token === 'late-online'), false);
  assert.deepEqual(disposed, ['local', 'late-online']);
});

test('authorization failure is reported and retry opens a fresh scoped session', async t => {
  const { options, messages } = await fixture(t);
  let finish, opened = 0;
  const registration = registerWebAppProvider({ matches: () => true, open: () => { opened++; return new Promise((resolve, reject) => { finish = { resolve, reject }; }); } });
  t.after(() => registration.dispose());
  const session = await startProjectCli(options); t.after(() => session.close());
  const errors = []; session.onWebAppError(reason => { errors.push(reason); });
  const opening = session.connectWebApp('main', first);
  await until(() => finish); finish.reject(Error('private-provider-detail'));
  await opening;
  await until(() => errors.length === 1);
  assert.deepEqual(errors, ['unknown']);
  const retry = session.connectWebApp('main', first); await until(() => opened === 2);
  finish.resolve({ binding: { service: 'sample.app', apiBaseUrl: 'https://im.invalid/api', bootstrap: {} }, dispose() {} });
  await retry; await until(async () => (await messages()).some(item => item.type === 'web-apps' && item.webApps.main));
});

test('a separately bundled provider reports a safe setup reason to existing and late subscribers', async t => {
  const { options } = await fixture(t);
  const registration = registerWebAppProvider({ matches: () => true, open: async () => {
    // This object deliberately has a different class identity, as private layers do.
    throw Object.assign(Error('private-token-must-not-leak'), { reason: 'server-not-configured' });
  } });
  t.after(() => registration.dispose());
  const session = await startProjectCli(options); t.after(() => session.close());
  const errors = []; session.onWebAppError(reason => errors.push(reason));
  await session.connectWebApp('main', first);
  await until(() => errors.length === 1);
  assert.deepEqual(errors, ['server-not-configured']);
  const late = []; session.onWebAppError(reason => late.push(reason));
  await until(() => late.length === 1);
  assert.deepEqual(late, errors);
  assert.equal(new WebAppConnectionError('server-not-configured').reason, errors[0]);
});


test('environment changes only prepare sign-in actions and a cancelled manual login remains retryable', async t => {
  const { options, messages } = await fixture(t);
  const requests = [], errors = [];
  let attempt = 0;
  const prompt = { service: 'sample.app', apiBaseUrl: 'https://im.invalid/api', bootstrap: null,
    login: { kind: 'external', serverUrl: 'https://online.invalid', environment: 'Online' } };
  const registration = registerWebAppProvider({ matches: () => true, open: async input => {
    requests.push(input);
    if (!input.interactive) return { binding: prompt, dispose() {} };
    if (++attempt === 1) throw Object.assign(Error('cancelled'), { reason: 'login-cancelled' });
    return { binding: { ...prompt, login: undefined, bootstrap: { token: 'scoped' } }, dispose() {} };
  } });
  t.after(() => registration.dispose());
  const session = await startProjectCli(options); t.after(() => session.close());
  session.onWebAppError(reason => errors.push(reason));
  session.onWebAppLogin(entryId => { void session.connectWebApp(entryId, first, { interactive: true }); });
  await session.connectWebApp('main', first, { interactive: false });
  assert.equal(attempt, 0);
  session.updateUserSettings({ agent: {}, testConfiguration: { id: 'online', name: 'Online', params: {} } });
  await until(() => requests.length === 2);
  assert.equal(requests[1].interactive, false);
  assert.equal(attempt, 0);
  session.updateUserSettings({ agent: {}, testLogin: 'other' });
  await until(async () => (await messages()).some(message => message.userSettings?.testLogin === 'other'));
  assert.equal(attempt, 0, 'Another entry cannot request authorization');
  session.updateUserSettings({ agent: {}, testLogin: 'main', staleConfiguration: { id: 'local', name: 'Local', params: {} } });
  await until(async () => (await messages()).some(message => message.userSettings?.staleConfiguration));
  assert.equal(attempt, 0, 'A click from the previous environment must not authorize the current one');
  await until(async () => (await messages()).filter(message => message.type === 'web-apps').at(-1)?.webApps?.main?.login);
  const beforeCancel = (await messages()).filter(message => message.type === 'web-apps').length;
  session.updateUserSettings({ agent: {}, testLogin: 'main' });
  await until(() => errors.includes('login-cancelled'));
  assert.ok((await messages()).filter(message => message.type === 'web-apps').at(-1).webApps.main.login);
  assert.equal((await messages()).filter(message => message.type === 'web-apps').length, beforeCancel, 'Cancelling must preserve the current page and its retry button');
  session.updateUserSettings({ agent: {}, testLogin: 'main', retry: 2 });
  await until(async () => (await messages()).some(message => message.webApps?.main?.bootstrap?.token === 'scoped'));
  assert.equal(attempt, 2);
  assert.ok(!JSON.stringify((await messages()).filter(message => message.webApps)).includes('host-secret'));
});
